// Command ingress is the SMTP submission front door of the relay.
//
// M0 walking skeleton: it accepts submissions on the SMTP listener, writes the
// raw body to the shared file store, and exposes health + Prometheus endpoints.
// SMTP AUTH/TLS, inbound authorization, Postgres metadata, and publishing to
// RabbitMQ land in M1 (see TODO.md).
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/emersion/go-smtp"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/azrtydxb/novamail/internal/store"
)

// config is the bootstrap config (env/flags only; operational config is in
// Postgres per the spec). Just enough to start and reach dependencies.
type config struct {
	smtpAddr  string
	httpAddr  string
	bodyStore string
}

func loadConfig() config {
	return config{
		smtpAddr:  env("NOVAMAIL_SMTP_ADDR", ":2525"),
		httpAddr:  env("NOVAMAIL_HTTP_ADDR", ":8080"),
		bodyStore: env("NOVAMAIL_BODY_STORE", "/var/lib/novamail/bodies"),
	}
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

var (
	accepted = promauto.NewCounter(prometheus.CounterOpts{
		Name: "novamail_ingress_accepted_total",
		Help: "Messages accepted and persisted to the body store.",
	})
	rejected = promauto.NewCounter(prometheus.CounterOpts{
		Name: "novamail_ingress_rejected_total",
		Help: "Messages rejected during ingress.",
	})
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg := loadConfig()

	bodies, err := store.NewFSStore(cfg.bodyStore)
	if err != nil {
		logger.Error("init body store", "err", err)
		os.Exit(1)
	}

	be := &backend{store: bodies, log: logger}
	smtpSrv := smtp.NewServer(be)
	smtpSrv.Addr = cfg.smtpAddr
	smtpSrv.Domain = env("NOVAMAIL_HOSTNAME", "novamail.local")
	smtpSrv.ReadTimeout = 60 * time.Second
	smtpSrv.WriteTimeout = 60 * time.Second
	smtpSrv.MaxMessageBytes = 50 << 20 // 50 MiB
	smtpSrv.AllowInsecureAuth = true   // M0 only; TLS + AUTH enforced in M1

	ready := &atomicBool{}
	httpSrv := &http.Server{Addr: cfg.httpAddr, Handler: healthMux(ready)}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		logger.Info("smtp listening", "addr", cfg.smtpAddr)
		if err := smtpSrv.ListenAndServe(); err != nil && !errors.Is(err, smtp.ErrServerClosed) {
			logger.Error("smtp server", "err", err)
			stop()
		}
	}()
	go func() {
		logger.Info("http listening", "addr", cfg.httpAddr)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("http server", "err", err)
			stop()
		}
	}()
	ready.set(true)

	<-ctx.Done()
	logger.Info("shutting down")
	ready.set(false)

	shutCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_ = smtpSrv.Shutdown(shutCtx)
	_ = httpSrv.Shutdown(shutCtx)
}

func healthMux(ready *atomicBool) http.Handler {
	mux := http.NewServeMux()
	// Liveness: process is up.
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok")
	})
	// Readiness: serving traffic. (M1 will also check Postgres/RabbitMQ.)
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		if !ready.get() {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = io.WriteString(w, "not ready")
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ready")
	})
	mux.Handle("/metrics", promhttp.Handler())
	return mux
}

// newID returns a random hex body id.
func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
