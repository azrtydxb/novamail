package main

import (
	"context"
	"io"
	"log/slog"
	"sync/atomic"

	"github.com/emersion/go-smtp"

	"github.com/azrtydxb/novamail/internal/store"
)

// backend implements smtp.Backend. M0 accepts unauthenticated submissions and
// persists the body to the store; routing/auth/enqueue arrive in M1.
type backend struct {
	store *store.FSStore
	log   *slog.Logger
}

func (b *backend) NewSession(c *smtp.Conn) (smtp.Session, error) {
	return &session{store: b.store, log: b.log}, nil
}

type session struct {
	store *store.FSStore
	log   *slog.Logger
	from  string
	rcpts []string
}

func (s *session) Mail(from string, _ *smtp.MailOptions) error {
	s.from = from
	return nil
}

func (s *session) Rcpt(to string, _ *smtp.RcptOptions) error {
	s.rcpts = append(s.rcpts, to)
	return nil
}

func (s *session) Data(r io.Reader) error {
	id := newID()
	if err := s.store.Put(context.Background(), id, r); err != nil {
		rejected.Inc()
		s.log.Error("persist body", "err", err, "from", s.from)
		return err
	}
	accepted.Inc()
	s.log.Info("accepted", "id", id, "from", s.from, "rcpts", len(s.rcpts))
	return nil
}

func (s *session) Reset() {
	s.from = ""
	s.rcpts = nil
}

func (s *session) Logout() error { return nil }

// atomicBool is a tiny readiness flag.
type atomicBool struct{ v atomic.Bool }

func (a *atomicBool) set(b bool) { a.v.Store(b) }
func (a *atomicBool) get() bool  { return a.v.Load() }
