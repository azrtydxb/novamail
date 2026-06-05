// Command delivery consumes relay jobs, fetches the body from the shared file
// store, relays it through the configured upstream provider, and acks only
// after a successful handoff. M1 routes everything to a single generic SMTP
// smarthost; the DB-driven routing engine + retry tiers arrive in M3/M2.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	amqp091 "github.com/rabbitmq/amqp091-go"

	"github.com/azrtydxb/novamail/internal/amqp"
	"github.com/azrtydxb/novamail/internal/db"
	"github.com/azrtydxb/novamail/internal/model"
	"github.com/azrtydxb/novamail/internal/providers"
	"github.com/azrtydxb/novamail/internal/store"
)

var (
	relayed = promauto.NewCounter(prometheus.CounterOpts{Name: "novamail_delivery_relayed_total", Help: "Messages successfully relayed upstream."})
	deferred = promauto.NewCounter(prometheus.CounterOpts{Name: "novamail_delivery_deferred_total", Help: "Messages deferred (transient upstream failure)."})
	failed  = promauto.NewCounter(prometheus.CounterOpts{Name: "novamail_delivery_failed_total", Help: "Messages permanently failed."})
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	bodies, err := store.NewFSStore(env("NOVAMAIL_BODY_STORE", "/var/lib/novamail/bodies"))
	if err != nil {
		logger.Error("init body store", "err", err)
		os.Exit(1)
	}

	initCtx, initCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer initCancel()
	database, err := db.Open(initCtx, os.Getenv("DSN"))
	if err != nil {
		logger.Error("init postgres", "err", err)
		os.Exit(1)
	}
	defer database.Close()

	bus, err := amqp.Dial(os.Getenv("AMQP_URL"))
	if err != nil {
		logger.Error("init rabbitmq", "err", err)
		os.Exit(1)
	}
	defer func() { _ = bus.Close() }()

	// M1: a single generic SMTP smarthost from env. M3 reads providers/routing
	// from Postgres.
	provider := providers.NewSMTP(providers.SMTPConfig{
		Name:     env("NOVAMAIL_SMARTHOST_NAME", "smarthost"),
		Addr:     os.Getenv("NOVAMAIL_SMARTHOST_ADDR"),
		TLSMode:  env("NOVAMAIL_SMARTHOST_TLS", "none"),
		Username: os.Getenv("NOVAMAIL_SMARTHOST_USER"),
		Password: os.Getenv("NOVAMAIL_SMARTHOST_PASS"),
		HELO:     env("NOVAMAIL_HELO", "novamail.local"),
		Insecure: env("NOVAMAIL_SMARTHOST_INSECURE", "false") == "true",
	})

	w := &worker{store: bodies, db: database, provider: provider, log: logger}

	// Health/metrics server.
	go serveHealth(env("NOVAMAIL_HTTP_ADDR", ":8080"), database, bus, logger)

	deliveries, err := bus.Consume(20)
	if err != nil {
		logger.Error("consume", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	logger.Info("delivery worker started", "smarthost", os.Getenv("NOVAMAIL_SMARTHOST_ADDR"))

	for {
		select {
		case <-ctx.Done():
			logger.Info("shutting down")
			return
		case d, ok := <-deliveries:
			if !ok {
				logger.Error("delivery channel closed")
				return
			}
			w.handle(ctx, d)
		}
	}
}

type worker struct {
	store    *store.FSStore
	db       *db.DB
	provider providers.Provider
	log      *slog.Logger
}

func (w *worker) handle(ctx context.Context, d amqp091.Delivery) {
	var job model.RelayJob
	if err := json.Unmarshal(d.Body, &job); err != nil {
		// Unparseable job: drop it (no requeue) so it doesn't poison the queue.
		w.log.Error("bad job", "err", err)
		_ = d.Reject(false)
		return
	}

	hctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	body, err := w.store.Get(hctx, job.BodyRef.Key)
	if err != nil {
		w.log.Error("fetch body", "err", err, "id", job.MessageID)
		_ = d.Nack(false, true) // requeue; body may appear (eventual consistency)
		return
	}
	defer func() { _ = body.Close() }()

	res, sendErr := w.provider.Send(hctx, &providers.Message{
		Envelope: job.Envelope,
		Body:     body,
	})

	switch res.Outcome {
	case providers.Delivered:
		relayed.Inc()
		_ = w.db.RecordAttempt(hctx, job.MessageID, model.StatusRelayed, "relayed", w.provider.Name(), res.Detail)
		_ = d.Ack(false)
		w.log.Info("relayed", "id", job.MessageID, "provider", w.provider.Name())
	case providers.Fail:
		failed.Inc()
		_ = w.db.RecordAttempt(hctx, job.MessageID, model.StatusFailed, "failed", w.provider.Name(), res.Detail)
		_ = d.Reject(false) // permanent → will go to the DLQ once wired (M2)
		w.log.Warn("failed", "id", job.MessageID, "detail", res.Detail)
	default: // Defer
		deferred.Inc()
		_ = w.db.RecordAttempt(hctx, job.MessageID, model.StatusDeferred, "deferred", w.provider.Name(), res.Detail)
		_ = d.Nack(false, true) // requeue; retry tiers (TTL+DLX) replace this in M2
		w.log.Warn("deferred", "id", job.MessageID, "err", sendErr)
	}
}

func serveHealth(addr string, database *db.DB, bus *amqp.Conn, logger *slog.Logger) {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok")
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		if err := database.Ping(ctx); err != nil {
			http.Error(w, "postgres unreachable", http.StatusServiceUnavailable)
			return
		}
		if err := bus.Ping(); err != nil {
			http.Error(w, "rabbitmq unreachable", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ready")
	})
	mux.Handle("/metrics", promhttp.Handler())
	if err := http.ListenAndServe(addr, mux); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("http server", "err", err)
	}
}
