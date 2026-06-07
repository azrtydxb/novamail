package providers

import (
	"context"
	"io"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"

	"github.com/azrtydxb/novamail/internal/model"
)

// countingBackend counts how many SMTP sessions (= TCP connections) are opened,
// so a test can assert that the provider reuses a pooled connection.
type countingBackend struct{ sessions int32 }

func (b *countingBackend) NewSession(_ *smtp.Conn) (smtp.Session, error) {
	atomic.AddInt32(&b.sessions, 1)
	return &countingSession{}, nil
}

type countingSession struct{}

func (s *countingSession) AuthMechanisms() []string             { return nil }
func (s *countingSession) Auth(string) (sasl.Server, error)     { return nil, smtp.ErrAuthUnsupported }
func (s *countingSession) Mail(string, *smtp.MailOptions) error { return nil }
func (s *countingSession) Rcpt(string, *smtp.RcptOptions) error { return nil }
func (s *countingSession) Data(r io.Reader) error               { _, _ = io.Copy(io.Discard, r); return nil }
func (s *countingSession) Reset()                               {}
func (s *countingSession) Logout() error                        { return nil }

// TestPoolReusesConnection sends several messages and asserts they all ride one
// connection — proving the provider doesn't re-handshake per message.
func TestPoolReusesConnection(t *testing.T) {
	be := &countingBackend{}
	srv := smtp.NewServer(be)
	srv.Domain = "localhost"
	srv.AllowInsecureAuth = true
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer func() { _ = l.Close() }()
	go func() { _ = srv.Serve(l) }()

	p := NewSMTP(SMTPConfig{Name: "test", Addr: l.Addr().String(), TLSMode: "none"})
	defer func() { _ = p.Close() }()

	const n = 5
	for i := range n {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		res, err := p.Send(ctx, &Message{
			Envelope: model.Envelope{MailFrom: "a@example.com", RcptTo: []string{"b@example.com"}},
			Body:     strings.NewReader("Subject: hi\r\n\r\nbody"),
		})
		cancel()
		if err != nil {
			t.Fatalf("send %d: %v", i, err)
		}
		if res.Outcome != Delivered {
			t.Fatalf("send %d outcome=%v want Delivered", i, res.Outcome)
		}
	}
	if got := atomic.LoadInt32(&be.sessions); got != 1 {
		t.Errorf("opened %d connections for %d messages; want 1 (pool not reusing)", got, n)
	}
}
