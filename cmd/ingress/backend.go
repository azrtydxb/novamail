package main

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/textproto"
	"strings"
	"sync/atomic"
	"time"

	"github.com/emersion/go-sasl"
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
	auth  *model.Account
	from  string
	rcpts []string
}

// AuthMechanisms advertises PLAIN (offered only after TLS; see AllowInsecureAuth).
func (s *session) AuthMechanisms() []string { return []string{sasl.Plain} }

// Auth validates credentials against the accounts table and binds the account
// to the session.
func (s *session) Auth(string) (sasl.Server, error) {
	return sasl.NewPlainServer(func(_, username, password string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		acc, err := s.be.db.Authenticate(ctx, username, password)
		if err != nil {
			s.be.log.Warn("auth failed", "username", username)
			return smtp.ErrAuthFailed
		}
		s.auth = acc
		return nil
	}), nil
}

func (s *session) Mail(from string, _ *smtp.MailOptions) error {
	if s.auth == nil {
		return &smtp.SMTPError{Code: 530, EnhancedCode: smtp.EnhancedCode{5, 7, 0}, Message: "Authentication required"}
	}
	if !s.auth.AllowsSender(domainOf([]string{from})) {
		return &smtp.SMTPError{Code: 550, EnhancedCode: smtp.EnhancedCode{5, 7, 1}, Message: "Sender domain not permitted for this account"}
	}
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
	// Tee the body into a capped header buffer + byte counter while storing it,
	// so we can record subject/message-id/size without a second pass.
	cap := &captureWriter{limit: 64 << 10}
	if err := s.be.store.Put(ctx, id, io.TeeReader(r, cap)); err != nil {
		rejected.Inc()
		s.be.log.Error("persist body", "err", err, "from", s.from)
		return err
	}
	meta := model.MessageMeta{SizeBytes: cap.n}
	if tp := textproto.NewReader(bufio.NewReader(bytes.NewReader(cap.hdr.Bytes()))); tp != nil {
		if mh, herr := tp.ReadMIMEHeader(); herr == nil || mh != nil {
			meta.Subject = mh.Get("Subject")
			meta.MessageID = mh.Get("Message-Id")
		}
	}

	env := model.Envelope{MailFrom: s.from, RcptTo: append([]string(nil), s.rcpts...)}
	bodyRef := model.BodyRef{Backend: "fs", Key: id}
	if err := s.be.db.InsertMessage(ctx, id, env, bodyRef, meta); err != nil {
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

// captureWriter counts every byte written and keeps the first `limit` bytes
// (the header block) for parsing subject/message-id.
type captureWriter struct {
	hdr   bytes.Buffer
	n     int64
	limit int
}

func (c *captureWriter) Write(p []byte) (int, error) {
	c.n += int64(len(p))
	if rem := c.limit - c.hdr.Len(); rem > 0 {
		if len(p) <= rem {
			c.hdr.Write(p)
		} else {
			c.hdr.Write(p[:rem])
		}
	}
	return len(p), nil
}

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
