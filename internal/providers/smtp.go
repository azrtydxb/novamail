package providers

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"

	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"
)

// SMTPConfig configures the generic SMTP smarthost provider.
type SMTPConfig struct {
	Name          string
	Addr          string // host:port
	TLSMode       string // "none" | "starttls" | "implicit"
	Username      string // optional; enables PLAIN auth when set
	Password      string
	HELO          string
	Insecure      bool   // skip TLS verification (lab/self-signed upstreams)
	MinTLSVersion uint16 // 0 ⇒ TLS 1.2 (tls_policy.min_version)
}

// SMTPProvider relays through a generic authenticated SMTP smarthost.
type SMTPProvider struct{ cfg SMTPConfig }

// NewSMTP builds a generic SMTP provider.
func NewSMTP(cfg SMTPConfig) *SMTPProvider {
	if cfg.Name == "" {
		cfg.Name = "smtp"
	}
	return &SMTPProvider{cfg: cfg}
}

func (p *SMTPProvider) Name() string { return p.cfg.Name }

// dial establishes the SMTP client honoring the context deadline (a black-holed
// smarthost must not hang past the per-message timeout) and sets a connection
// deadline so the whole MAIL/RCPT/DATA exchange is bounded.
func (p *SMTPProvider) dial(ctx context.Context) (*smtp.Client, error) {
	minVer := p.cfg.MinTLSVersion
	if minVer == 0 {
		minVer = tls.VersionTLS12
	}
	tlsCfg := &tls.Config{ServerName: hostOnly(p.cfg.Addr), InsecureSkipVerify: p.cfg.Insecure, MinVersion: minVer} //nolint:gosec // lab smarthosts may be self-signed; gated by config
	nd := &net.Dialer{}
	if dl, ok := ctx.Deadline(); ok {
		nd.Deadline = dl
	}
	var conn net.Conn
	var err error
	if p.cfg.TLSMode == "implicit" {
		conn, err = (&tls.Dialer{NetDialer: nd, Config: tlsCfg}).DialContext(ctx, "tcp", p.cfg.Addr)
	} else {
		conn, err = nd.DialContext(ctx, "tcp", p.cfg.Addr)
	}
	if err != nil {
		return nil, err
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	if p.cfg.TLSMode == "starttls" {
		return smtp.NewClientStartTLS(conn, tlsCfg)
	}
	return smtp.NewClient(conn), nil
}

// Send relays the message and maps the upstream reply to an Outcome.
func (p *SMTPProvider) Send(ctx context.Context, m *Message) (Result, error) {
	// Never send credentials in cleartext: refuse PLAIN auth without TLS.
	if p.cfg.Username != "" && p.cfg.TLSMode == "none" {
		return Result{Outcome: Fail, Detail: "refusing PLAIN auth over a non-TLS connection"},
			fmt.Errorf("provider %s: PLAIN auth requires TLS (starttls/implicit)", p.cfg.Name)
	}
	c, err := p.dial(ctx)
	if err != nil {
		return Result{Outcome: Defer, Detail: err.Error()}, fmt.Errorf("dial %s: %w", p.cfg.Addr, err)
	}
	defer func() { _ = c.Close() }()

	if p.cfg.HELO != "" {
		if err := c.Hello(p.cfg.HELO); err != nil {
			return classify(err)
		}
	}
	if p.cfg.Username != "" {
		if err := c.Auth(sasl.NewPlainClient("", p.cfg.Username, p.cfg.Password)); err != nil {
			return classify(err)
		}
	}
	if err := c.SendMail(m.Envelope.MailFrom, m.Envelope.RcptTo, m.Body); err != nil {
		return classify(err)
	}
	return Result{Outcome: Delivered, Detail: "250 ok"}, nil
}

// classify maps an SMTP error to Defer (4xx / network) or Fail (5xx).
func classify(err error) (Result, error) {
	var se *smtp.SMTPError
	if errors.As(err, &se) {
		if se.Code >= 500 {
			return Result{Outcome: Fail, Detail: se.Error()}, err
		}
		return Result{Outcome: Defer, Detail: se.Error()}, err
	}
	// Network/protocol error → transient.
	return Result{Outcome: Defer, Detail: err.Error()}, err
}

func hostOnly(addr string) string {
	for i := 0; i < len(addr); i++ {
		if addr[i] == ':' {
			return addr[:i]
		}
	}
	return addr
}
