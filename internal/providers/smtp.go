package providers

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"

	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"
)

// SMTPConfig configures the generic SMTP smarthost provider.
type SMTPConfig struct {
	Name     string
	Addr     string // host:port
	TLSMode  string // "none" | "starttls" | "implicit"
	Username string // optional; enables PLAIN auth when set
	Password string
	HELO     string
	Insecure bool // skip TLS verification (lab/self-signed upstreams)
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

func (p *SMTPProvider) dial() (*smtp.Client, error) {
	tlsCfg := &tls.Config{ServerName: hostOnly(p.cfg.Addr), InsecureSkipVerify: p.cfg.Insecure} //nolint:gosec // lab smarthosts may be self-signed; gated by config
	switch p.cfg.TLSMode {
	case "implicit":
		return smtp.DialTLS(p.cfg.Addr, tlsCfg)
	case "starttls":
		return smtp.DialStartTLS(p.cfg.Addr, tlsCfg)
	default:
		return smtp.Dial(p.cfg.Addr)
	}
}

// Send relays the message and maps the upstream reply to an Outcome.
func (p *SMTPProvider) Send(ctx context.Context, m *Message) (Result, error) {
	c, err := p.dial()
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
