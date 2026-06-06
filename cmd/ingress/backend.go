package main

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"log/slog"
	"net"
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

// backend implements smtp.Backend: authorizes submissions (SMTP AUTH against
// accounts OR trusted source IP via relay_clients), persists the body, records
// metadata, and publishes a relay job. The inbound policy is hot-reloaded.
type backend struct {
	store  *store.FSStore
	db     *db.DB
	bus    *amqp.Conn
	policy atomic.Pointer[inboundPolicy]
	log    *slog.Logger
}

func (b *backend) NewSession(c *smtp.Conn) (smtp.Session, error) {
	s := &session{be: b}
	if c != nil && c.Conn() != nil {
		s.ip = remoteIP(c.Conn().RemoteAddr().String())
	}
	// Trusted source IP ⇒ relay without AUTH (IP-authenticated).
	if p := b.policy.Load(); p != nil {
		s.client = p.matchClient(s.ip)
	}
	return s, nil
}

type session struct {
	be     *backend
	ip     net.IP
	auth   *model.Account // set on successful SMTP AUTH
	client *trustedClient // set when the source IP is a trusted relay client
	from   string
	rcpts  []string
	// RFC 3461 DSN params
	dsnReturn string
	rcptN     int
	neverN    int
}

// AuthMechanisms advertises PLAIN (offered only after TLS; see AllowInsecureAuth).
func (s *session) AuthMechanisms() []string { return []string{sasl.Plain} }

// Auth validates credentials against the accounts table, enforces the account's
// IP allowlist (if any), and binds the account to the session.
func (s *session) Auth(string) (sasl.Server, error) {
	return sasl.NewPlainServer(func(_, username, password string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		acc, err := s.be.db.Authenticate(ctx, username, password)
		if err != nil {
			s.be.log.Warn("auth failed", "username", username)
			return smtp.ErrAuthFailed
		}
		if len(acc.IPAllowlist) > 0 && !ipInAny(s.ip, acc.IPAllowlist) {
			s.be.log.Warn("auth rejected: source IP not in allowlist", "username", username, "ip", s.ip)
			return smtp.ErrAuthFailed
		}
		s.auth = acc
		return nil
	}), nil
}

// allowedSenders returns the effective allowed-sender set for the session.
func (s *session) allowedSenders() []string {
	if s.auth != nil {
		return s.auth.AllowedSenderDomains
	}
	if s.client != nil {
		return s.client.senders
	}
	return nil
}

func (s *session) Mail(from string, opts *smtp.MailOptions) error {
	if opts != nil {
		s.dsnReturn = string(opts.Return)
	}
	// Authorization: a valid SMTP AUTH session OR a trusted source IP.
	if s.auth == nil && s.client == nil {
		return &smtp.SMTPError{Code: 530, EnhancedCode: smtp.EnhancedCode{5, 7, 0}, Message: "Authentication required (or relay from a trusted IP)"}
	}
	domain := domainOf([]string{from})
	if !sendersAllow(s.allowedSenders(), domain) {
		return &smtp.SMTPError{Code: 550, EnhancedCode: smtp.EnhancedCode{5, 7, 1}, Message: "Sender domain not permitted for this client"}
	}
	// Relay-domain gate (if configured).
	if p := s.be.policy.Load(); p != nil {
		if !p.relayDomainOK(domain) {
			return &smtp.SMTPError{Code: 550, EnhancedCode: smtp.EnhancedCode{5, 7, 1}, Message: "Sender domain is not a permitted relay domain"}
		}
		// Inbound rate limiting (per account / source IP / global).
		key := "*"
		if s.auth != nil {
			key = "acct:" + s.auth.ID
		} else if s.ip != nil {
			key = "ip:" + s.ip.String()
		}
		if delay, res, limited := p.limiter.Reserve(key); limited && delay > 0 {
			res.Cancel()
			return &smtp.SMTPError{Code: 451, EnhancedCode: smtp.EnhancedCode{4, 7, 0}, Message: "Rate limit exceeded; try again later"}
		}
	}
	s.from = from
	return nil
}

func (s *session) Rcpt(to string, opts *smtp.RcptOptions) error {
	if p := s.be.policy.Load(); p != nil && p.suppressed[strings.ToLower(to)] {
		return &smtp.SMTPError{Code: 550, EnhancedCode: smtp.EnhancedCode{5, 1, 1}, Message: "Recipient is on the suppression list"}
	}
	s.rcpts = append(s.rcpts, to)
	s.rcptN++
	if opts != nil {
		for _, n := range opts.Notify {
			if n == smtp.DSNNotifyNever {
				s.neverN++
			}
		}
	}
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
		DSNReturn:    s.dsnReturn,
		// Suppress the bounce only if every recipient asked for NOTIFY=NEVER.
		DSNSuppress: s.rcptN > 0 && s.neverN == s.rcptN,
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
	s.dsnReturn = ""
	s.rcptN = 0
	s.neverN = 0
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
