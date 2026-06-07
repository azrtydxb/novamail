package providers

import (
	"context"
	"io"
	"net"
	"net/textproto"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"

	"github.com/azrtydxb/novamail/internal/model"
)

func TestRecipientDomain(t *testing.T) {
	cases := map[string]string{
		"user@example.com":    "example.com",
		"a.b+tag@Sub.Example": "sub.example",
		"":                    "",
		"noatsign":            "",
		"trailing@":           "",
	}
	for in, want := range cases {
		got := recipientDomain([]string{in})
		if got != want {
			t.Errorf("recipientDomain(%q)=%q want %q", in, got, want)
		}
	}
}

func TestClassifyDirect(t *testing.T) {
	// 5xx → Fail, 4xx → Defer, network → Defer.
	if r, _ := classifyDirect(&textproto.Error{Code: 550, Msg: "no user"}); r.Outcome != Fail {
		t.Errorf("550 → %v want Fail", r.Outcome)
	}
	if r, _ := classifyDirect(&textproto.Error{Code: 451, Msg: "try later"}); r.Outcome != Defer {
		t.Errorf("451 → %v want Defer", r.Outcome)
	}
	if r, _ := classifyDirect(io.EOF); r.Outcome != Defer {
		t.Errorf("network → %v want Defer", r.Outcome)
	}
}

// ── deliverTo against a local SMTP server ─────────────────────────────────────

type directBackend struct {
	sessions   int32
	rejectRcpt bool
}

func (b *directBackend) NewSession(_ *smtp.Conn) (smtp.Session, error) {
	atomic.AddInt32(&b.sessions, 1)
	return &directSession{b: b}, nil
}

type directSession struct{ b *directBackend }

func (s *directSession) AuthMechanisms() []string             { return nil }
func (s *directSession) Auth(string) (sasl.Server, error)     { return nil, smtp.ErrAuthUnsupported }
func (s *directSession) Mail(string, *smtp.MailOptions) error { return nil }
func (s *directSession) Rcpt(string, *smtp.RcptOptions) error {
	if s.b.rejectRcpt {
		return &smtp.SMTPError{Code: 550, EnhancedCode: smtp.EnhancedCode{5, 1, 1}, Message: "no such user"}
	}
	return nil
}
func (s *directSession) Data(r io.Reader) error { _, _ = io.Copy(io.Discard, r); return nil }
func (s *directSession) Reset()                 {}
func (s *directSession) Logout() error          { return nil }

func startTestMX(t *testing.T, be smtp.Backend) (addr string, stop func()) {
	t.Helper()
	srv := smtp.NewServer(be)
	srv.Domain = "mx.test"
	srv.AllowInsecureAuth = true
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() { _ = srv.Serve(l) }()
	return l.Addr().String(), func() { _ = l.Close() }
}

func TestDirectDeliverTo_Delivered(t *testing.T) {
	be := &directBackend{}
	addr, stop := startTestMX(t, be)
	defer stop()
	p := NewDirect(DirectConfig{Name: "direct", HELO: "relay.test"})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	res, err := p.deliverTo(ctx, addr, "localhost", "from@relay.test", []string{"to@mx.test"}, []byte("Subject: hi\r\n\r\nbody"))
	if err != nil {
		t.Fatalf("deliverTo: %v", err)
	}
	if res.Outcome != Delivered {
		t.Fatalf("outcome=%v want Delivered", res.Outcome)
	}
}

func TestDirectDeliverTo_PermanentReject(t *testing.T) {
	be := &directBackend{rejectRcpt: true}
	addr, stop := startTestMX(t, be)
	defer stop()
	p := NewDirect(DirectConfig{Name: "direct", HELO: "relay.test"})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	res, _ := p.deliverTo(ctx, addr, "localhost", "from@relay.test", []string{"to@mx.test"}, []byte("body"))
	if res.Outcome != Fail {
		t.Fatalf("outcome=%v want Fail (5xx RCPT reject)", res.Outcome)
	}
}

func TestDirectDeliverTo_Unreachable(t *testing.T) {
	p := NewDirect(DirectConfig{Name: "direct", HELO: "relay.test"})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	// 127.0.0.1:1 is not listening → connection refused → Defer (transient).
	res, _ := p.deliverTo(ctx, "127.0.0.1:1", "localhost", "from@relay.test", []string{"to@mx.test"}, []byte("body"))
	if res.Outcome != Defer {
		t.Fatalf("outcome=%v want Defer (unreachable)", res.Outcome)
	}
}

func TestDirectSend_NoRecipient(t *testing.T) {
	p := NewDirect(DirectConfig{Name: "direct"})
	res, _ := p.Send(context.Background(), &Message{Envelope: model.Envelope{MailFrom: "a@b.c", RcptTo: nil}, Body: strings.NewReader("x")})
	if res.Outcome != Fail {
		t.Fatalf("no recipient → %v want Fail", res.Outcome)
	}
}
