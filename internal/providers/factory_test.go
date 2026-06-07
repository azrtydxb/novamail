package providers

import (
	"testing"

	"github.com/azrtydxb/novamail/internal/model"
)

func TestFactoryTypes(t *testing.T) {
	cases := []struct {
		typ      string
		wantName string
		wantKind string // concrete type marker
	}{
		{"smtp", "p", "smtp"},
		{"ses", "p", "smtp"},
		{"m365", "p", "smtp"},
		{"gmail", "p", "gmail"},
	}
	for _, c := range cases {
		p, err := New(model.Provider{Name: "p", Type: c.typ}, Creds{Username: "u"}, DefaultTLSPolicy)
		if err != nil {
			t.Fatalf("New(%s): %v", c.typ, err)
		}
		if p.Name() != c.wantName {
			t.Errorf("%s: name=%q", c.typ, p.Name())
		}
		switch c.wantKind {
		case "smtp":
			if _, ok := p.(*SMTPProvider); !ok {
				t.Errorf("%s: want *SMTPProvider", c.typ)
			}
		case "gmail":
			if _, ok := p.(*GmailProvider); !ok {
				t.Errorf("%s: want *GmailProvider", c.typ)
			}
		}
	}
}

func TestFactoryUnknownType(t *testing.T) {
	if _, err := New(model.Provider{Type: "carrier-pigeon"}, Creds{}, DefaultTLSPolicy); err == nil {
		t.Fatal("expected error for unknown provider type")
	}
}

func TestSESDefaultsToSTARTTLS(t *testing.T) {
	p, _ := New(model.Provider{Name: "ses", Type: "ses"}, Creds{Username: "u", Password: "p"}, DefaultTLSPolicy)
	sp := p.(*SMTPProvider)
	if sp.cfg.TLSMode != "starttls" {
		t.Errorf("ses TLSMode=%q want starttls", sp.cfg.TLSMode)
	}
	if sp.cfg.Addr == "" {
		t.Error("ses should have a default endpoint")
	}
}
