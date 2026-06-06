package providers

import (
	"fmt"

	"github.com/azrtydxb/novamail/internal/model"
)

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
func New(p model.Provider, c Creds) (Provider, error) {
	switch p.Type {
	case "smtp":
		return NewSMTP(SMTPConfig{
			Name: p.Name, Addr: p.Endpoint, TLSMode: tlsModeFor(p.AuthMode),
			Username: c.Username, Password: c.Password,
		}), nil
	case "ses":
		return NewSMTP(SMTPConfig{
			Name: p.Name, Addr: orDefault(p.Endpoint, "email-smtp.us-east-1.amazonaws.com:587"),
			TLSMode: "starttls", Username: c.Username, Password: c.Password,
		}), nil
	case "m365":
		return NewSMTP(SMTPConfig{
			Name: p.Name, Addr: orDefault(p.Endpoint, "smtp.office365.com:587"),
			TLSMode: "starttls", Username: c.Username, Password: c.Password,
		}), nil
	case "gmail":
		return NewGmail(GmailConfig{
			Name: p.Name, Addr: orDefault(p.Endpoint, "smtp.gmail.com:587"),
			User: c.Username, ClientID: c.ClientID, ClientSecret: c.ClientSecret,
			RefreshToken: c.RefreshToken,
		}), nil
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
