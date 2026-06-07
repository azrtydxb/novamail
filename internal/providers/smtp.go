package providers

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"
)

// defaultMaxIdle bounds how many warm connections a provider keeps per instance.
// Delivery handles messages sequentially per replica today, so 1 is enough in
// practice; the small headroom covers concurrent handling without unbounded fan-out.
const defaultMaxIdle = 4

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
	MaxIdleConns  int    // 0 ⇒ defaultMaxIdle
}

// SMTPProvider relays through a generic authenticated SMTP smarthost. It keeps a
// pool of warm, already-greeted+authenticated connections so the steady-state
// per-message cost is just MAIL/RCPT/DATA — not a fresh TCP+STARTTLS+AUTH
// handshake every time (the dominant cost under load).
type SMTPProvider struct {
	cfg SMTPConfig

	mu     sync.Mutex
	idle   []*pooledConn
	closed bool
}

// pooledConn pairs the SMTP client with its underlying net.Conn so we can refresh
// the per-message deadline on reuse (the deadline is a property of the socket,
// which the client does not expose directly).
type pooledConn struct {
	client *smtp.Client
	conn   net.Conn
}

// NewSMTP builds a generic SMTP provider.
func NewSMTP(cfg SMTPConfig) *SMTPProvider {
	if cfg.Name == "" {
		cfg.Name = "smtp"
	}
	return &SMTPProvider{cfg: cfg}
}

func (p *SMTPProvider) Name() string { return p.cfg.Name }

func (p *SMTPProvider) maxIdle() int {
	if p.cfg.MaxIdleConns > 0 {
		return p.cfg.MaxIdleConns
	}
	return defaultMaxIdle
}

// dialConn opens a TCP (or implicit-TLS) connection, applies STARTTLS when
// configured, and returns both the client and the raw conn (for deadline
// management). It honors the context deadline so a black-holed smarthost cannot
// hang past the per-message timeout.
func (p *SMTPProvider) dialConn(ctx context.Context) (*smtp.Client, net.Conn, error) {
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
		return nil, nil, err
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	if p.cfg.TLSMode == "starttls" {
		c, terr := smtp.NewClientStartTLS(conn, tlsCfg)
		if terr != nil {
			_ = conn.Close()
			return nil, nil, terr
		}
		return c, conn, nil
	}
	return smtp.NewClient(conn), conn, nil
}

// greet performs the once-per-connection HELO + AUTH so a pooled connection is
// ready to accept MAIL transactions on reuse.
func (p *SMTPProvider) greet(c *smtp.Client) error {
	if p.cfg.HELO != "" {
		if err := c.Hello(p.cfg.HELO); err != nil {
			return err
		}
	}
	if p.cfg.Username != "" {
		if err := c.Auth(sasl.NewPlainClient("", p.cfg.Username, p.cfg.Password)); err != nil {
			return err
		}
	}
	return nil
}

// acquire returns a ready connection: a live pooled one (deadline refreshed,
// liveness-checked) or a freshly dialed+greeted one.
func (p *SMTPProvider) acquire(ctx context.Context) (*pooledConn, error) {
	for {
		p.mu.Lock()
		n := len(p.idle)
		if n == 0 {
			p.mu.Unlock()
			break
		}
		pc := p.idle[n-1]
		p.idle = p.idle[:n-1]
		p.mu.Unlock()

		// Refresh the deadline for this message, then NOOP to confirm the server
		// hasn't dropped the idle connection. A failed NOOP ⇒ stale; discard and
		// try the next (or dial fresh). NOOP before consuming the body keeps the
		// send idempotent — we never half-send on a dead socket.
		if dl, ok := ctx.Deadline(); ok {
			_ = pc.conn.SetDeadline(dl)
		}
		if err := pc.client.Noop(); err == nil {
			return pc, nil
		}
		_ = pc.client.Close()
	}

	c, conn, err := p.dialConn(ctx)
	if err != nil {
		return nil, err
	}
	if err := p.greet(c); err != nil {
		_ = c.Close()
		return nil, err
	}
	return &pooledConn{client: c, conn: conn}, nil
}

// release returns a warm connection to the pool, or closes it if the pool is full
// or shut down. Clears the deadline so it doesn't expire while idle.
func (p *SMTPProvider) release(pc *pooledConn) {
	_ = pc.conn.SetDeadline(time.Time{})
	p.mu.Lock()
	if p.closed || len(p.idle) >= p.maxIdle() {
		p.mu.Unlock()
		_ = pc.client.Close()
		return
	}
	p.idle = append(p.idle, pc)
	p.mu.Unlock()
}

// Send relays the message over a pooled connection and maps the upstream reply to
// an Outcome. On any error the connection is closed (never reused mid-transaction);
// on success the transaction is RSET and the warm connection is pooled.
func (p *SMTPProvider) Send(ctx context.Context, m *Message) (Result, error) {
	// Never send credentials in cleartext: refuse PLAIN auth without TLS.
	if p.cfg.Username != "" && p.cfg.TLSMode == "none" {
		return Result{Outcome: Fail, Detail: "refusing PLAIN auth over a non-TLS connection"},
			fmt.Errorf("provider %s: PLAIN auth requires TLS (starttls/implicit)", p.cfg.Name)
	}
	pc, err := p.acquire(ctx)
	if err != nil {
		// A greet/auth failure carries an SMTP code (classify it); a dial/network
		// failure is transient.
		var se *smtp.SMTPError
		if errors.As(err, &se) {
			return classify(err)
		}
		return Result{Outcome: Defer, Detail: err.Error()}, fmt.Errorf("dial %s: %w", p.cfg.Addr, err)
	}
	if err := pc.client.SendMail(m.Envelope.MailFrom, m.Envelope.RcptTo, m.Body); err != nil {
		_ = pc.client.Close()
		return classify(err)
	}
	// Reset the transaction so the connection can carry the next message; if RSET
	// fails the connection is suspect, so drop it rather than pool it.
	if err := pc.client.Reset(); err != nil {
		_ = pc.client.Close()
	} else {
		p.release(pc)
	}
	return Result{Outcome: Delivered, Detail: "250 ok"}, nil
}

// Verify checks reachability + authentication without sending a message (and
// without touching the pool). Used by the Admin API "test connection" action.
func (p *SMTPProvider) Verify(ctx context.Context) error {
	if p.cfg.Username != "" && p.cfg.TLSMode == "none" {
		return fmt.Errorf("refusing PLAIN auth over a non-TLS connection")
	}
	c, _, err := p.dialConn(ctx)
	if err != nil {
		return fmt.Errorf("dial %s: %w", p.cfg.Addr, err)
	}
	defer func() { _ = c.Close() }()
	return p.greet(c)
}

// Close drains the idle pool. Call when retiring a provider instance (e.g. on a
// config reload) so warm connections don't leak.
func (p *SMTPProvider) Close() error {
	p.mu.Lock()
	p.closed = true
	idle := p.idle
	p.idle = nil
	p.mu.Unlock()
	for _, pc := range idle {
		_ = pc.client.Close()
	}
	return nil
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

// hostOnly returns the host portion of a host:port for the TLS ServerName,
// handling bracketed IPv6 (e.g. "[2001:db8::1]:587" → "2001:db8::1").
func hostOnly(addr string) string {
	if h, _, err := net.SplitHostPort(addr); err == nil {
		return h
	}
	return addr // no port (or unparseable): use as-is
}
