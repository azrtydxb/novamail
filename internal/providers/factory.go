package providers

import (
	"crypto/tls"
	"fmt"

	"github.com/azrtydxb/novamail/internal/model"
)

// TLSPolicy is the resolved tls_policy for a provider: a minimum TLS version and
// whether STARTTLS is mandatory (an otherwise-plaintext provider is upgraded).
type TLSPolicy struct {
	MinVersion       uint16 // 0 ⇒ TLS 1.2
	STARTTLSRequired bool
}

// DefaultTLSPolicy is used when no tls_policy row matches a provider.
var DefaultTLSPolicy = TLSPolicy{MinVersion: tls.VersionTLS12}

// Creds holds resolved credentials for a provider (looked up by secret_ref).
// Fields are interpreted per provider type.
type Creds struct {
	Username string // SMTP-AUTH / SES / M365 user; Gmail mailbox
	Password string // SMTP-AUTH / SES / M365 password
	// Gmail XOAUTH2:
	ClientID     string
	ClientSecret string
	RefreshToken string
}

// New builds a Provider from a DB spec + resolved credentials.
//
//   - smtp  : generic SMTP smarthost (optional auth, configurable TLS)
//   - ses   : Amazon SES SMTP endpoint, STARTTLS + IAM-derived SMTP creds
//   - m365  : Microsoft 365 SMTP relay, STARTTLS + SMTP-AUTH
//   - gmail : Gmail/Workspace via SMTP + XOAUTH2 (token refresh)
func New(p model.Provider, c Creds, pol TLSPolicy) (Provider, error) {
	switch p.Type {
	case "smtp":
		mode := tlsModeFor(p.AuthMode)
		if pol.STARTTLSRequired && mode == "none" {
			mode = "starttls" // policy forbids plaintext
		}
		return NewSMTP(SMTPConfig{
			Name: p.Name, Addr: p.Endpoint, TLSMode: mode, MinTLSVersion: pol.MinVersion,
			Username: c.Username, Password: c.Password,
		}), nil
	case "ses":
		addr := orDefault(p.Endpoint, "email-smtp.us-east-1.amazonaws.com:587")
		pass := c.Password
		// auth_mode "iam" (AWS-SIGV4): the creds are an IAM access key ID + secret
		// access key; derive the SES SMTP password. Otherwise they are already SES
		// SMTP credentials, used as-is.
		if p.AuthMode == "iam" {
			pass = sesSMTPPassword(c.Password, sesRegion(addr))
		}
		return NewSMTP(SMTPConfig{
			Name: p.Name, Addr: addr, TLSMode: "starttls", MinTLSVersion: pol.MinVersion,
			Username: c.Username, Password: pass,
		}), nil
	case "m365":
		return NewSMTP(SMTPConfig{
			Name: p.Name, Addr: orDefault(p.Endpoint, "smtp.office365.com:587"),
			TLSMode: "starttls", MinTLSVersion: pol.MinVersion,
			Username: c.Username, Password: c.Password,
		}), nil
	case "gmail":
		return NewGmail(GmailConfig{
			Name: p.Name, Addr: orDefault(p.Endpoint, "smtp.gmail.com:587"),
			User: c.Username, ClientID: c.ClientID, ClientSecret: c.ClientSecret,
			RefreshToken: c.RefreshToken,
		}), nil
	case "direct":
		// Direct-to-MX: no endpoint/credentials — resolves the recipient domain's
		// MX per message and delivers on port 25 (opportunistic STARTTLS).
		return NewDirect(DirectConfig{Name: p.Name, HELO: DirectHELO, MinTLSVersion: pol.MinVersion}), nil
	default:
		return nil, fmt.Errorf("providers: unknown type %q", p.Type)
	}
}

// tlsModeFor maps a generic provider's auth mode to a TLS mode. Plaintext is
// only used for in-cluster test sinks (auth_mode "ip" or empty endpoint creds).
func tlsModeFor(authMode string) string {
	switch authMode {
	case "smtp-auth":
		return "starttls"
	case "ip", "":
		return "none"
	default:
		return "starttls"
	}
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}
