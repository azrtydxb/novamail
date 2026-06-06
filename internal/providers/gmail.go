package providers

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-smtp"
)

// xoauth2Client implements the non-standard XOAUTH2 SASL mechanism Google uses.
type xoauth2Client struct {
	user  string
	token string
}

func (c *xoauth2Client) Start() (mech string, ir []byte, err error) {
	ir = []byte("user=" + c.user + "\x01auth=Bearer " + c.token + "\x01\x01")
	return "XOAUTH2", ir, nil
}

func (c *xoauth2Client) Next(challenge []byte) ([]byte, error) {
	// A challenge here means the server rejected the token; return empty to
	// surface the error response.
	return []byte(""), nil
}

// GmailConfig configures the Gmail/Workspace XOAUTH2 provider. Google OAuth
// access tokens expire ~1h, so we refresh proactively from the refresh token.
type GmailConfig struct {
	Name         string
	Addr         string // default smtp.gmail.com:587
	User         string // the sending mailbox
	ClientID     string
	ClientSecret string
	RefreshToken string
	TokenURL     string // default https://oauth2.googleapis.com/token
}

// GmailProvider relays through Gmail using SMTP + XOAUTH2.
type GmailProvider struct {
	cfg    GmailConfig
	client *http.Client

	mu      sync.Mutex
	token   string
	expires time.Time
}

// NewGmail builds a Gmail XOAUTH2 provider.
func NewGmail(cfg GmailConfig) *GmailProvider {
	if cfg.Name == "" {
		cfg.Name = "gmail"
	}
	if cfg.Addr == "" {
		cfg.Addr = "smtp.gmail.com:587"
	}
	if cfg.TokenURL == "" {
		cfg.TokenURL = "https://oauth2.googleapis.com/token"
	}
	return &GmailProvider{cfg: cfg, client: &http.Client{Timeout: 15 * time.Second}}
}

func (p *GmailProvider) Name() string { return p.cfg.Name }

// accessToken returns a valid token, refreshing if it expires within 60s.
func (p *GmailProvider) accessToken(ctx context.Context) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.token != "" && time.Until(p.expires) > 60*time.Second {
		return p.token, nil
	}
	form := url.Values{
		"client_id":     {p.cfg.ClientID},
		"client_secret": {p.cfg.ClientSecret},
		"refresh_token": {p.cfg.RefreshToken},
		"grant_type":    {"refresh_token"},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.cfg.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := p.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("oauth refresh: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("oauth refresh: status %d", resp.StatusCode)
	}
	var tr struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		return "", fmt.Errorf("oauth decode: %w", err)
	}
	p.token = tr.AccessToken
	p.expires = time.Now().Add(time.Duration(tr.ExpiresIn) * time.Second)
	return p.token, nil
}

// Send relays via Gmail SMTP with XOAUTH2.
func (p *GmailProvider) Send(ctx context.Context, m *Message) (Result, error) {
	tok, err := p.accessToken(ctx)
	if err != nil {
		return Result{Outcome: Defer, Detail: err.Error()}, err
	}
	c, err := smtp.DialStartTLS(p.cfg.Addr, &tls.Config{ServerName: hostOnly(p.cfg.Addr), MinVersion: tls.VersionTLS12})
	if err != nil {
		return Result{Outcome: Defer, Detail: err.Error()}, fmt.Errorf("dial gmail: %w", err)
	}
	defer func() { _ = c.Close() }()

	if err := c.Auth(&xoauth2Client{user: p.cfg.User, token: tok}); err != nil {
		return classify(err)
	}
	if err := c.SendMail(m.Envelope.MailFrom, m.Envelope.RcptTo, m.Body); err != nil {
		return classify(err)
	}
	return Result{Outcome: Delivered, Detail: "250 ok"}, nil
}
