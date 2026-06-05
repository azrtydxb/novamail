package main

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"

	"github.com/emersion/go-smtp"

	"github.com/azrtydxb/novamail/internal/amqp"
	"github.com/azrtydxb/novamail/internal/db"
	"github.com/azrtydxb/novamail/internal/model"
	"github.com/azrtydxb/novamail/internal/store"
)

// backend implements smtp.Backend. M1 accepts a submission, persists the body,
// records metadata in Postgres, and publishes a relay job. SMTP AUTH/TLS and
// inbound authorization are layered on next.
type backend struct {
	store *store.FSStore
	db    *db.DB
	bus   *amqp.Conn
	log   *slog.Logger
}

func (b *backend) NewSession(_ *smtp.Conn) (smtp.Session, error) {
	return &session{be: b}, nil
}

type session struct {
	be    *backend
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

// Data persists the body, records the message, and enqueues it for delivery.
// The body store write and the DB insert happen before the publish so a crash
// can never enqueue a job whose body/metadata is missing.
func (s *session) Data(r io.Reader) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	id := newID()
	if err := s.be.store.Put(ctx, id, r); err != nil {
		rejected.Inc()
		s.be.log.Error("persist body", "err", err, "from", s.from)
		return err
	}

	env := model.Envelope{MailFrom: s.from, RcptTo: append([]string(nil), s.rcpts...)}
	bodyRef := model.BodyRef{Backend: "fs", Key: id}
	if err := s.be.db.InsertMessage(ctx, id, env, bodyRef); err != nil {
		rejected.Inc()
		s.be.log.Error("insert message", "err", err, "id", id)
		return err
	}

	job := &model.RelayJob{
		V:            model.RelayJobVersion,
		MessageID:    id,
		BodyRef:      bodyRef,
		Envelope:     env,
		RoutingHints: model.RoutingHints{RecipientDomain: domainOf(s.rcpts), SenderDomain: domainOf([]string{s.from})},
		Attempt:      0,
		EnqueuedAt:   time.Now().UTC(),
	}
	if err := s.be.bus.Publish(ctx, job); err != nil {
		// Body + metadata are durable; the message is recoverable. Surface a
		// transient failure so the client retries rather than losing the mail.
		rejected.Inc()
		s.be.log.Error("publish job", "err", err, "id", id)
		return err
	}

	accepted.Inc()
	s.be.log.Info("accepted", "id", id, "from", s.from, "rcpts", len(s.rcpts))
	return nil
}

func (s *session) Reset() {
	s.from = ""
	s.rcpts = nil
}

func (s *session) Logout() error { return nil }

// domainOf returns the domain of the first address, lowercased.
func domainOf(addrs []string) string {
	if len(addrs) == 0 {
		return ""
	}
	if i := strings.LastIndex(addrs[0], "@"); i >= 0 {
		return strings.ToLower(addrs[0][i+1:])
	}
	return ""
}

// atomicBool is a tiny readiness flag.
type atomicBool struct{ v atomic.Bool }

func (a *atomicBool) set(b bool) { a.v.Store(b) }
func (a *atomicBool) get() bool  { return a.v.Load() }
