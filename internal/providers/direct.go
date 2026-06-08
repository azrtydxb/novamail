package providers

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/smtp"
	"net/textproto"
	"sort"
	"strings"
)

// DirectHELO is the EHLO/HELO name used for direct-to-MX delivery. For good
// deliverability it must be a real FQDN with matching forward + reverse (PTR)
// DNS. The delivery worker sets it from the DB-driven `direct_helo` setting
// (Settings page) on boot and on every config.changed reload.
var DirectHELO = "localhost"

// DirectConfig configures the direct-to-MX provider.
type DirectConfig struct {
	Name          string
	HELO          string // "" ⇒ DirectHELO
	MinTLSVersion uint16 // 0 ⇒ TLS 1.2 (opportunistic STARTTLS only)
}

// DirectProvider delivers a message straight to the recipient domain's MX hosts
// (no upstream relay): it resolves MX, connects on port 25, opportunistically
// upgrades to TLS (STARTTLS, unverified per RFC 7435), and hands the message off.
// This is the v2 direct-delivery path; it is only used when a provider of type
// "direct" is configured and routed to. Uses the stdlib SMTP client (the classic
// MTA client) so STARTTLS can be applied opportunistically with our HELO name.
type DirectProvider struct{ cfg DirectConfig }

// NewDirect builds a direct-to-MX provider.
func NewDirect(cfg DirectConfig) *DirectProvider {
	if cfg.Name == "" {
		cfg.Name = "direct"
	}
	return &DirectProvider{cfg: cfg}
}

func (p *DirectProvider) Name() string { return p.cfg.Name }

func (p *DirectProvider) helo() string {
	if p.cfg.HELO != "" {
		return p.cfg.HELO
	}
	return DirectHELO
}

// recipientDomain returns the (single) recipient domain for the job — relay jobs
// are keyed by recipient domain, so all RcptTo share it.
func recipientDomain(rcpts []string) string {
	for _, r := range rcpts {
		if i := strings.LastIndex(r, "@"); i >= 0 && i < len(r)-1 {
			return strings.ToLower(r[i+1:])
		}
	}
	return ""
}

// lookupMX resolves the domain's MX hosts in preference order. With no MX record
// the domain's A/AAAA is the implicit MX (RFC 5321 §5.1).
func lookupMX(ctx context.Context, domain string) []string {
	mxs, err := net.DefaultResolver.LookupMX(ctx, domain)
	if err != nil || len(mxs) == 0 {
		return []string{domain} // implicit MX
	}
	sort.SliceStable(mxs, func(i, j int) bool { return mxs[i].Pref < mxs[j].Pref })
	hosts := make([]string, 0, len(mxs))
	for _, mx := range mxs {
		hosts = append(hosts, strings.TrimSuffix(mx.Host, "."))
	}
	return hosts
}

// Send delivers the message to the recipient domain's MX hosts, trying each in
// preference order. A 5xx from a host is a permanent reject (Fail); transient
// failures move to the next host, and if all are transient the message Defers
// for the retry tiers.
func (p *DirectProvider) Send(ctx context.Context, m *Message) (Result, error) {
	domain := recipientDomain(m.Envelope.RcptTo)
	if domain == "" {
		return Result{Outcome: Fail, Detail: "no recipient domain"}, fmt.Errorf("direct: empty recipient domain")
	}
	// Buffer the body so it can be replayed across MX hosts on failover. Bounded
	// by the ingest message-size cap; with N concurrent handlers that is N×cap of
	// peak memory (the relay path streams instead, but it has no MX failover).
	body, err := io.ReadAll(m.Body)
	if err != nil {
		return Result{Outcome: Defer, Detail: err.Error()}, fmt.Errorf("direct: read body: %w", err)
	}

	var last Result
	var lastErr error
	for _, host := range lookupMX(ctx, domain) {
		res, derr := p.deliverTo(ctx, net.JoinHostPort(host, "25"), host, m.Envelope.MailFrom, m.Envelope.RcptTo, body)
		switch res.Outcome {
		case Delivered:
			return res, nil
		case Fail:
			return res, derr // permanent reject — other MX would reject too
		default:
			last, lastErr = res, derr // transient — try the next MX
		}
	}
	if last.Detail == "" {
		last = Result{Outcome: Defer, Detail: "no MX host reachable"}
	}
	return last, lastErr
}

// deliverTo performs one SMTP delivery attempt to a single MX. addr is the
// host:port to dial; host is used as the TLS ServerName for STARTTLS.
func (p *DirectProvider) deliverTo(ctx context.Context, addr, host, from string, to []string, body []byte) (Result, error) {
	nd := &net.Dialer{}
	if dl, ok := ctx.Deadline(); ok {
		nd.Deadline = dl
	}
	conn, err := nd.DialContext(ctx, "tcp", addr)
	if err != nil {
		return Result{Outcome: Defer, Detail: err.Error()}, fmt.Errorf("dial %s: %w", addr, err)
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	c, err := smtp.NewClient(conn, host)
	if err != nil {
		_ = conn.Close()
		return classifyDirect(err)
	}
	defer func() { _ = c.Close() }()

	if err := c.Hello(p.helo()); err != nil {
		return classifyDirect(err)
	}
	// Opportunistic STARTTLS (RFC 7435): upgrade if the MX offers it. If it's
	// offered but the handshake fails, Defer rather than continue — the session is
	// left mid-STARTTLS so we can't safely fall back to plaintext, and proceeding
	// would risk a silent downgrade. MX that don't offer STARTTLS get plaintext.
	if ok, _ := c.Extension("STARTTLS"); ok {
		minVer := p.cfg.MinTLSVersion
		if minVer == 0 {
			minVer = tls.VersionTLS12
		}
		if err := c.StartTLS(&tls.Config{ServerName: host, InsecureSkipVerify: true, MinVersion: minVer}); err != nil { //nolint:gosec // opportunistic TLS: unverified by design (RFC 7435)
			return Result{Outcome: Defer, Detail: "STARTTLS failed: " + err.Error()}, err
		}
	}
	if err := c.Mail(from); err != nil {
		return classifyDirect(err)
	}
	for _, rcpt := range to {
		if err := c.Rcpt(rcpt); err != nil {
			return classifyDirect(err)
		}
	}
	w, err := c.Data()
	if err != nil {
		return classifyDirect(err)
	}
	if _, err := io.Copy(w, bytes.NewReader(body)); err != nil {
		_ = w.Close()
		return Result{Outcome: Defer, Detail: err.Error()}, err
	}
	if err := w.Close(); err != nil {
		return classifyDirect(err)
	}
	_ = c.Quit()
	return Result{Outcome: Delivered, Detail: "250 ok (direct)"}, nil
}

// classifyDirect maps a stdlib SMTP/textproto error to Defer (4xx/network) or
// Fail (5xx).
func classifyDirect(err error) (Result, error) {
	var te *textproto.Error
	if errors.As(err, &te) {
		if te.Code >= 500 {
			return Result{Outcome: Fail, Detail: te.Error()}, err
		}
		return Result{Outcome: Defer, Detail: te.Error()}, err
	}
	return Result{Outcome: Defer, Detail: err.Error()}, err
}
