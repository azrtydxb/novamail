// Command dsn consumes permanently-failed messages from the DLQ and generates
// RFC 3464 delivery-status notifications (bounces), which it republishes through
// relay.work for delivery back to the original sender.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	amqp091 "github.com/rabbitmq/amqp091-go"

	"github.com/azrtydxb/novamail/internal/amqp"
	"github.com/azrtydxb/novamail/internal/db"
	"github.com/azrtydxb/novamail/internal/model"
	"github.com/azrtydxb/novamail/internal/store"
)

var (
	bounced    = promauto.NewCounter(prometheus.CounterOpts{Name: "novamail_dsn_bounced_total", Help: "DSN bounces generated (RFC 3464)."})
	suppressed = promauto.NewCounter(prometheus.CounterOpts{Name: "novamail_dsn_suppressed_total", Help: "DSNs suppressed (NOTIFY=NEVER / double-bounce)."})
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	hostname := env("NOVAMAIL_HOSTNAME", "novamail.local")

	initCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	database, err := db.Open(initCtx, os.Getenv("DSN"))
	if err != nil {
		logger.Error("init postgres", "err", err)
		os.Exit(1)
	}
	defer database.Close()
	bodies, err := store.Open(env("NOVAMAIL_BODY_STORE", "postgres"), database.Pool())
	if err != nil {
		logger.Error("init body store", "err", err)
		os.Exit(1)
	}
	bus, err := amqp.Dial(os.Getenv("AMQP_URL"), logger)
	if err != nil {
		logger.Error("init rabbitmq", "err", err)
		os.Exit(1)
	}
	defer func() { _ = bus.Close() }()

	g := &gen{store: bodies, db: database, bus: bus, host: hostname, log: logger}
	go serveHealth(env("NOVAMAIL_HTTP_ADDR", ":8080"), database, bus, logger)

	deliveries, err := bus.ConsumeQueue(amqp.DLQ, 10)
	if err != nil {
		logger.Error("consume dlq", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	logger.Info("dsn generator started")

	for {
		select {
		case <-ctx.Done():
			logger.Info("shutting down")
			return
		case d, ok := <-deliveries:
			if !ok {
				return
			}
			g.handle(context.Background(), d)
		}
	}
}

type gen struct {
	store store.Store
	db    *db.DB
	bus   *amqp.Conn
	host  string
	log   *slog.Logger
}

func (g *gen) handle(ctx context.Context, d amqp091.Delivery) {
	var job model.RelayJob
	if err := json.Unmarshal(d.Body, &job); err != nil {
		g.log.Error("bad dlq job", "err", err)
		_ = d.Reject(false)
		return
	}
	hctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	// Mark the original message bounced regardless of whether we can notify.
	detail, _ := g.db.LastDetail(hctx, job.MessageID)
	_ = g.db.RecordAttempt(hctx, job.MessageID, model.StatusBounced, "bounced", "dsn", detail)

	// Feedback loop: a real message reaching the DLQ is a hard bounce — suppress
	// its recipients so we stop sending to them, and notify the data plane.
	if job.Envelope.MailFrom != "" {
		for _, rcpt := range job.Envelope.RcptTo {
			_ = g.db.AddSuppression(hctx, rcpt, "hard_bounce", "dsn", detail)
		}
		_ = g.bus.PublishConfig(hctx, []byte(`{"v":1,"epoch":0,"slices":["suppressions"]}`))
	}

	// Null sender (<>) means this is already a bounce — never bounce a bounce.
	// NOTIFY=NEVER (DSNSuppress) means the sender asked for no failure notice.
	if job.Envelope.MailFrom == "" || job.DSNSuppress {
		suppressed.Inc()
		_ = g.store.Delete(hctx, job.BodyRef.Key)
		g.log.Warn("DSN suppressed", "id", job.MessageID, "reason", suppressReason(&job))
		_ = d.Ack(false)
		return
	}

	dsnID := newID()
	body := buildDSN(g.host, dsnID, job.Envelope.MailFrom, job.Envelope.RcptTo, detail)
	if err := g.store.Put(hctx, dsnID, bytes.NewReader(body)); err != nil {
		g.log.Error("store dsn", "err", err)
		_ = d.Nack(false, true)
		return
	}
	env := model.Envelope{MailFrom: "", RcptTo: []string{job.Envelope.MailFrom}}
	bodyRef := model.BodyRef{Backend: "fs", Key: dsnID}
	meta := model.MessageMeta{Subject: "Delivery Status Notification (Failure)", SizeBytes: int64(len(body))}
	if err := g.db.InsertMessage(hctx, dsnID, env, bodyRef, meta); err != nil {
		g.log.Error("insert dsn message", "err", err)
		_ = d.Nack(false, true)
		return
	}
	dsnJob := &model.RelayJob{
		V:            model.RelayJobVersion,
		MessageID:    dsnID,
		BodyRef:      bodyRef,
		Envelope:     env,
		RoutingHints: model.RoutingHints{RecipientDomain: domainOf(job.Envelope.MailFrom)},
		Attempt:      0,
		EnqueuedAt:   time.Now().UTC(),
	}
	if err := g.bus.Publish(hctx, dsnJob); err != nil {
		g.log.Error("publish dsn", "err", err)
		_ = d.Nack(false, true)
		return
	}
	// GC: the original message is terminal (bounced); drop its body.
	_ = g.store.Delete(hctx, job.BodyRef.Key)
	bounced.Inc()
	g.log.Info("bounce generated", "original", job.MessageID, "dsn", dsnID, "to", job.Envelope.MailFrom)
	_ = d.Ack(false)
}

func suppressReason(job *model.RelayJob) string {
	if job.Envelope.MailFrom == "" {
		return "null return-path (double-bounce)"
	}
	return "NOTIFY=NEVER"
}

func domainOf(addr string) string {
	if i := strings.LastIndex(addr, "@"); i >= 0 {
		return strings.ToLower(addr[i+1:])
	}
	return ""
}

func serveHealth(addr string, database *db.DB, bus *amqp.Conn, logger *slog.Logger) {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") })
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		if database.Ping(ctx) != nil || bus.Ping() != nil {
			http.Error(w, "deps unreachable", http.StatusServiceUnavailable)
			return
		}
		_, _ = io.WriteString(w, "ready")
	})
	mux.Handle("/metrics", promhttp.Handler())
	if err := http.ListenAndServe(addr, mux); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("http server", "err", err)
	}
}

// buildDSN renders a minimal RFC 3464 multipart/report bounce.
func buildDSN(host, id, sender string, rcpts []string, detail string) []byte {
	if detail == "" {
		detail = "delivery to upstream provider failed"
	}
	boundary := "novamail-dsn-" + id
	date := time.Now().UTC().Format(time.RFC1123Z)
	var b strings.Builder
	w := func(s string) { b.WriteString(s); b.WriteString("\r\n") }

	w("From: MAILER-DAEMON@" + host)
	w("To: " + sender)
	w("Subject: Delivery Status Notification (Failure)")
	w("Date: " + date)
	w("Message-Id: <dsn-" + id + "@" + host + ">")
	w("MIME-Version: 1.0")
	w("Auto-Submitted: auto-replied")
	w("Content-Type: multipart/report; report-type=delivery-status; boundary=\"" + boundary + "\"")
	w("")
	w("--" + boundary)
	w("Content-Type: text/plain; charset=utf-8")
	w("")
	w("This is the mail delivery system at " + host + ".")
	w("")
	w("Your message could not be delivered to the following recipient(s):")
	w("")
	for _, r := range rcpts {
		w("  " + r)
	}
	w("")
	w("Diagnostic: " + detail)
	w("")
	w("--" + boundary)
	w("Content-Type: message/delivery-status")
	w("")
	w("Reporting-MTA: dns; " + host)
	for _, r := range rcpts {
		w("")
		w("Final-Recipient: rfc822; " + r)
		w("Action: failed")
		w("Status: 5.0.0")
		w("Diagnostic-Code: smtp; " + detail)
	}
	w("")
	w("--" + boundary + "--")
	return []byte(b.String())
}
