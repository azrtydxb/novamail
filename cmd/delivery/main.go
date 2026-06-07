// Command delivery consumes relay jobs, fetches the body from the shared file
// store, relays it through the configured upstream provider, and acks only
// after a successful handoff. M1 routes everything to a single generic SMTP
// smarthost; the DB-driven routing engine + retry tiers arrive in M3/M2.
package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	amqp091 "github.com/rabbitmq/amqp091-go"

	"github.com/azrtydxb/novamail/internal/amqp"
	"github.com/azrtydxb/novamail/internal/db"
	"github.com/azrtydxb/novamail/internal/dkim"
	"github.com/azrtydxb/novamail/internal/model"
	"github.com/azrtydxb/novamail/internal/providers"
	"github.com/azrtydxb/novamail/internal/ratelimit"
	"github.com/azrtydxb/novamail/internal/routing"
	"github.com/azrtydxb/novamail/internal/secrets"
	"github.com/azrtydxb/novamail/internal/store"
	"github.com/azrtydxb/novamail/internal/tracing"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// maxRateBlock caps how long a worker will sleep to honor a rate limit before
// deferring the message to a wait tier instead (keeps the consumer flowing).
const maxRateBlock = 5 * time.Second

var (
	relayed  = promauto.NewCounter(prometheus.CounterOpts{Name: "novamail_delivery_relayed_total", Help: "Messages successfully relayed upstream."})
	deferred = promauto.NewCounter(prometheus.CounterOpts{Name: "novamail_delivery_deferred_total", Help: "Messages deferred (transient upstream failure)."})
	failed   = promauto.NewCounter(prometheus.CounterOpts{Name: "novamail_delivery_failed_total", Help: "Messages permanently failed."})

	// Per-provider attempt outcome (delivered|deferred|failed) — the core
	// operator signal for the multi-provider/failover design.
	providerOutcomes = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "novamail_delivery_provider_attempts_total",
		Help: "Per-provider delivery attempt outcomes.",
	}, []string{"provider", "outcome"})
	// Upstream send latency (the relay's primary SLI).
	sendDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "novamail_delivery_send_seconds",
		Help:    "Upstream send (handoff) duration in seconds.",
		Buckets: prometheus.DefBuckets,
	}, []string{"provider"})
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

// tlsVersion maps a tls_policy.min_version string to a crypto/tls constant.
// Unknown values fall back to TLS 1.2 and are logged (the column is free-form).
func tlsVersion(s string, log *slog.Logger) uint16 {
	switch s {
	case "1.3":
		return tls.VersionTLS13
	case "1.2", "":
		return tls.VersionTLS12
	default:
		log.Warn("unknown tls_policy.min_version; defaulting to 1.2", "value", s)
		return tls.VersionTLS12
	}
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	// Per-replica concurrency: how many messages a single delivery pod handles in
	// parallel. Delivery is I/O-bound on the upstream send, so concurrency (not
	// CPU) is what fills the pipeline. Size the per-provider warm-connection pool
	// to match, so concurrent sends reuse connections instead of churning them.
	concurrency := envInt("NOVAMAIL_DELIVERY_CONCURRENCY", 16)
	providers.DefaultMaxIdleConns = concurrency

	// EHLO/HELO name for direct-to-MX providers. For good deliverability it must
	// be a real FQDN with matching forward + reverse (PTR) DNS.
	if helo := os.Getenv("NOVAMAIL_DELIVERY_HELO"); helo != "" {
		providers.DirectHELO = helo
	}

	initCtx, initCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer initCancel()
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

	// Routing/rate-limit config is DB-driven (Postgres is the single source of
	// truth). secretDir resolves credentials referenced by a provider's
	// secret_ref (file fallback). The snapshot is hot-reloaded on config.changed.
	secretDir := env("NOVAMAIL_PROVIDER_SECRETS", "/etc/novamail/provider-secrets")

	// Envelope-encryption key (KEK) for credentials stored in Postgres. Optional;
	// when unset, only the file-mounted secret fallback is used.
	var cipher *secrets.Cipher
	if k := os.Getenv("NOVAMAIL_SECRET_KEY"); k != "" {
		cipher, err = secrets.New(k)
		if err != nil {
			logger.Error("init secrets cipher", "err", err)
			os.Exit(1)
		}
		logger.Info("envelope encryption enabled")
	}

	signer, err := dkim.Load(
		os.Getenv("NOVAMAIL_DKIM_DOMAIN"),
		os.Getenv("NOVAMAIL_DKIM_SELECTOR"),
		os.Getenv("NOVAMAIL_DKIM_KEY"),
	)
	if err != nil {
		logger.Error("init dkim", "err", err)
		os.Exit(1)
	}
	if signer != nil {
		logger.Info("dkim signing enabled", "domain", signer.Domain())
	}

	shutdownTracing, tracer := tracing.Init(initCtx, "novamail-delivery", logger)
	defer func() { _ = shutdownTracing(context.Background()) }()

	w := &worker{store: bodies, db: database, bus: bus, secretDir: secretDir, signer: signer, log: logger, tracer: tracer}
	w.state.Store(buildState(initCtx, database, cipher, secretDir, logger))

	// Hot reload: rebuild the routing/rate-limit snapshot on each config.changed.
	if err := bus.SubscribeConfig(func(body []byte) {
		var ev model.ConfigChanged
		_ = json.Unmarshal(body, &ev)
		logger.Info("config.changed received; reloading", "epoch", ev.Epoch, "slices", ev.Slices)
		rctx, rcancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer rcancel()
		w.state.Store(buildState(rctx, database, cipher, secretDir, logger))
	}); err != nil {
		logger.Error("subscribe config.changed", "err", err)
		os.Exit(1)
	}

	// Health/metrics server.
	go serveHealth(env("NOVAMAIL_HTTP_ADDR", ":8080"), database, bus, w, logger)

	// Prefetch matches concurrency so each parallel handler has a message to work
	// (QoS still bounds unacked in-flight to `concurrency` per replica, which keeps
	// the queue-depth signal KEDA scales on meaningful and work fairly distributed).
	deliveries, err := bus.Consume(concurrency)
	if err != nil {
		logger.Error("consume", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	logger.Info("delivery worker started", "concurrency", concurrency, "smarthost", os.Getenv("NOVAMAIL_SMARTHOST_ADDR"))

	// A bounded pool of handlers consumes the shared delivery channel in parallel.
	// Acks are per-message and order-independent (quorum queues), so out-of-order
	// completion is fine. Graceful drain: on signal each worker stops pulling new
	// work but finishes its in-flight message (bounded by the per-message timeout);
	// anything still unacked is redelivered to another consumer.
	var wg sync.WaitGroup
	for range concurrency {
		wg.Go(func() {
			for {
				select {
				case <-ctx.Done():
					return
				case d, ok := <-deliveries:
					if !ok {
						return
					}
					w.handle(context.Background(), d)
				}
			}
		})
	}
	<-ctx.Done()
	logger.Info("draining; waiting for in-flight handlers")
	wg.Wait()
	logger.Info("drained; shutting down")
}

// routeState is an immutable snapshot of the DB-driven config, swapped
// atomically on config.changed so handle() never reads a half-updated map.
type routeState struct {
	engine       *routing.Engine
	instances    map[string]providers.Provider // provider id → instance
	limiter      *ratelimit.Limiter            // per recipient domain (scope=recipient_domain)
	provLimiter  *ratelimit.Limiter            // per provider name (scope=provider)
	dkimByDomain map[string]*dkim.Signer       // DB-driven DKIM signers, by sender domain
}

type worker struct {
	store     store.Store
	db        *db.DB
	bus       *amqp.Conn
	secretDir string
	state     atomic.Pointer[routeState]
	signer    *dkim.Signer
	log       *slog.Logger
	tracer    trace.Tracer
}

// chain returns the ordered providers to try for a job, resolved from the
// current snapshot. An empty result means "no route" (the message is deferred).
func (w *worker) chain(st *routeState, job *model.RelayJob) []providers.Provider {
	ids := st.engine.Resolve(job.RoutingHints.RecipientDomain, job.RoutingHints.SenderDomain)
	out := make([]providers.Provider, 0, len(ids))
	for _, id := range ids {
		if p, ok := st.instances[id]; ok {
			out = append(out, p)
		}
	}
	return out
}

func (w *worker) handle(ctx context.Context, d amqp091.Delivery) {
	var job model.RelayJob
	if err := json.Unmarshal(d.Body, &job); err != nil {
		// Unparseable job: drop it (no requeue) so it doesn't poison the queue.
		w.log.Error("bad job", "err", err)
		_ = d.Reject(false)
		return
	}

	// Link this message's spans to the ingress submission (carried in the job) and
	// open the root delivery span.
	ctx = tracing.Extract(ctx, job.Trace)
	ctx, span := w.tracer.Start(ctx, "delivery.handle", trace.WithAttributes(
		attribute.String("message.id", job.MessageID),
		attribute.String("recipient.domain", job.RoutingHints.RecipientDomain),
		attribute.Int("attempt", job.Attempt),
	))
	defer span.End()

	hctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	// Read the body once (DKIM-signed if applicable) into memory so it can be
	// replayed across providers in a failover chain.
	raw, err := w.materialize(hctx, &job)
	if err != nil {
		w.log.Error("materialize body", "err", err, "id", job.MessageID)
		_ = d.Nack(false, true)
		return
	}

	st := w.state.Load()
	chain := w.chain(st, &job)
	if len(chain) == 0 {
		// No route configured (yet): defer so it retries when config arrives.
		w.defer_(hctx, d, &job, "no matching routing rule")
		return
	}

	// Per-domain rate limiting: reserve a token for the recipient domain. Sleep
	// for small delays; defer to a wait tier if the backlog is large so the
	// consumer keeps flowing.
	if delay, res, limited := st.limiter.Reserve(job.RoutingHints.RecipientDomain); limited {
		if delay > maxRateBlock {
			res.Cancel()
			w.defer_(hctx, d, &job, "rate limited: "+job.RoutingHints.RecipientDomain)
			return
		}
		if delay > 0 {
			select {
			case <-time.After(delay):
			case <-hctx.Done():
				res.Cancel()
				_ = d.Nack(false, true)
				return
			}
		}
	}

	// Try the chain in order. A Delivered ends it; a Defer or Fail advances to
	// the next provider. After exhausting the chain we fall back to the retry
	// tiers (if any provider was transient) or the DLQ (all permanent).
	sawDefer := false
	var lastProvider, lastDetail string
	for _, p := range chain {
		// Per-provider outbound rate limit: pace small delays, skip this provider
		// (defer / advance the chain) when its budget is exhausted.
		if delay, pres, limited := st.provLimiter.Reserve(p.Name()); limited {
			if delay > maxRateBlock {
				pres.Cancel()
				sawDefer = true
				lastProvider, lastDetail = p.Name(), "provider rate limit exceeded"
				w.log.Warn("provider rate limited", "id", job.MessageID, "provider", p.Name())
				continue
			}
			if delay > 0 {
				select {
				case <-time.After(delay):
				case <-hctx.Done():
					pres.Cancel()
					_ = d.Nack(false, true)
					return
				}
			}
		}
		sendStart := time.Now()
		sctx, sendSpan := w.tracer.Start(hctx, "provider.send", trace.WithAttributes(
			attribute.String("provider.name", p.Name()),
		))
		res, serr := p.Send(sctx, &providers.Message{Envelope: job.Envelope, Body: bytes.NewReader(raw)})
		sendSpan.SetAttributes(attribute.String("outcome", res.Outcome.String()))
		if serr != nil {
			sendSpan.RecordError(serr)
			sendSpan.SetStatus(codes.Error, serr.Error())
		}
		sendSpan.End()
		sendDuration.WithLabelValues(p.Name()).Observe(time.Since(sendStart).Seconds())
		// A non-nil error must never be read as a successful delivery: if a
		// provider returns an error with a zero-value (Delivered) outcome, treat
		// it as a transient defer so we never GC the body / ack a failed send.
		if serr != nil && res.Outcome == providers.Delivered {
			res.Outcome = providers.Defer
			if res.Detail == "" {
				res.Detail = serr.Error()
			}
		}
		providerOutcomes.WithLabelValues(p.Name(), res.Outcome.String()).Inc()
		lastProvider, lastDetail = p.Name(), res.Detail
		if res.Outcome == providers.Delivered {
			relayed.Inc()
			_ = w.db.RecordAttempt(hctx, job.MessageID, model.StatusRelayed, "relayed", p.Name(), res.Detail)
			// GC: relayed successfully, the body is no longer needed.
			_ = w.store.Delete(hctx, job.BodyRef.Key)
			_ = d.Ack(false)
			w.log.Info("relayed", "id", job.MessageID, "provider", p.Name())
			return
		}
		if res.Outcome == providers.Defer {
			sawDefer = true
		}
		w.log.Warn("provider failed over", "id", job.MessageID, "provider", p.Name(), "outcome", res.Outcome.String())
	}

	if sawDefer {
		w.defer_(hctx, d, &job, fmt.Sprintf("%s: %s", lastProvider, lastDetail))
		return
	}
	// Whole chain permanently failed.
	failed.Inc()
	_ = w.db.RecordAttempt(hctx, job.MessageID, model.StatusFailed, "failed", lastProvider, lastDetail)
	w.toDLQ(hctx, d, &job)
	w.log.Warn("chain failed", "id", job.MessageID, "detail", lastDetail)
}

// materialize fetches the body and applies DKIM signing, returning the bytes to
// relay (buffered so failover can replay them). Spans split body-fetch vs DKIM
// signing so the trace shows which dominates.
func (w *worker) materialize(ctx context.Context, job *model.RelayJob) ([]byte, error) {
	ctx, span := w.tracer.Start(ctx, "delivery.materialize")
	defer span.End()

	_, fetchSpan := w.tracer.Start(ctx, "store.get_body")
	body, err := w.store.Get(ctx, job.BodyRef.Key)
	fetchSpan.End()
	if err != nil {
		span.RecordError(err)
		return nil, err
	}
	defer func() { _ = body.Close() }()

	var src io.Reader = body
	if sgn := w.signerFor(job.RoutingHints.SenderDomain); sgn != nil {
		_, signSpan := w.tracer.Start(ctx, "dkim.sign")
		signed, serr := sgn.Sign(body)
		signSpan.End()
		if serr != nil {
			span.RecordError(serr)
			return nil, serr
		}
		src = signed
	}
	return io.ReadAll(src)
}

// signerFor resolves the DKIM signer for a sender domain: a DB-driven key
// (dkim_keys) takes precedence, falling back to the mounted single key.
func (w *worker) signerFor(domain string) *dkim.Signer {
	if st := w.state.Load(); st != nil {
		if s, ok := st.dkimByDomain[strings.ToLower(domain)]; ok {
			return s
		}
	}
	if w.signer != nil && strings.EqualFold(w.signer.Domain(), domain) {
		return w.signer
	}
	return nil
}

// defer_ records a deferral and escalates the job through the retry tiers, or
// dead-letters it once the tiers are exhausted.
func (w *worker) defer_(ctx context.Context, d amqp091.Delivery, job *model.RelayJob, detail string) {
	deferred.Inc()
	_ = w.db.RecordAttempt(ctx, job.MessageID, model.StatusDeferred, "deferred", "", detail)
	job.Attempt++
	if tier, ok := amqp.TierForAttempt(job.Attempt); ok {
		if err := w.bus.Requeue(ctx, tier, job); err != nil {
			w.log.Error("requeue", "err", err, "id", job.MessageID)
			_ = d.Nack(false, true)
			return
		}
		_ = d.Ack(false)
		w.log.Warn("deferred", "id", job.MessageID, "tier", tier.Queue, "attempt", job.Attempt, "detail", detail)
		return
	}
	w.toDLQ(ctx, d, job)
	w.log.Warn("retries exhausted", "id", job.MessageID)
}

// buildState reads providers + routing rules + rate limits from Postgres and
// builds an immutable snapshot. On a DB error it logs and returns whatever it
// could build (so a transient blip never crashes the worker mid-run).
func buildState(ctx context.Context, database *db.DB, cipher *secrets.Cipher, secretDir string, logger *slog.Logger) *routeState {
	provs, err := database.GetProviders(ctx)
	if err != nil {
		logger.Error("load providers", "err", err)
	}
	rules, err := database.GetRoutingRules(ctx)
	if err != nil {
		logger.Error("load routing rules", "err", err)
	}
	limits, err := database.GetRateLimits(ctx)
	if err != nil {
		logger.Error("load rate limits", "err", err)
	}
	// Outbound limits, split by scope: per recipient domain and per provider.
	var domainSpecs, provSpecs []ratelimit.Spec
	for _, rl := range limits {
		if rl.Direction != "out" {
			continue
		}
		spec := ratelimit.Spec{Key: rl.ScopeValue, PerSecond: rl.PerSecond, Burst: rl.Burst}
		switch rl.Scope {
		case "recipient_domain":
			domainSpecs = append(domainSpecs, spec)
		case "provider":
			provSpecs = append(provSpecs, spec)
		}
	}
	// Resolve TLS policy per provider (per-provider row overrides the global "" row).
	tlsPols, perr := database.GetTLSPolicies(ctx)
	if perr != nil {
		logger.Error("load tls policies", "err", perr)
	}
	globalPol := providers.DefaultTLSPolicy
	byProvider := map[string]providers.TLSPolicy{}
	for _, t := range tlsPols {
		pol := providers.TLSPolicy{MinVersion: tlsVersion(t.MinVersion, logger), STARTTLSRequired: t.STARTTLSRequired}
		if t.ProviderID == "" {
			globalPol = pol
		} else {
			byProvider[t.ProviderID] = pol
		}
	}

	instances := make(map[string]providers.Provider, len(provs))
	for _, p := range provs {
		pol := globalPol
		if pp, ok := byProvider[p.ID]; ok {
			pol = pp
		}
		inst, err := providers.New(p, resolveCreds(ctx, database, cipher, secretDir, p.SecretRef), pol)
		if err != nil {
			logger.Error("build provider", "err", err, "provider", p.Name)
			continue
		}
		instances[p.ID] = inst
	}
	// DB-driven DKIM signers (per domain, active selector). Private keys are
	// decrypted from the secret store with the KEK.
	dkimByDomain := map[string]*dkim.Signer{}
	if cipher != nil {
		keys, kerr := database.GetActiveDKIMKeys(ctx)
		if kerr != nil {
			logger.Error("load dkim keys", "err", kerr)
		}
		for _, k := range keys {
			if k.PrivateRef == "" {
				continue
			}
			env, gerr := database.GetSecret(ctx, k.PrivateRef)
			if gerr != nil || env == "" {
				continue
			}
			pemBytes, derr := cipher.Decrypt(env)
			if derr != nil {
				logger.Error("decrypt dkim key", "domain", k.Domain, "err", derr)
				continue
			}
			sgn, serr := dkim.LoadPEM(k.Domain, k.Selector, pemBytes)
			if serr != nil {
				logger.Error("load dkim signer", "domain", k.Domain, "err", serr)
				continue
			}
			dkimByDomain[strings.ToLower(k.Domain)] = sgn
		}
	}

	logger.Info("routing loaded", "providers", len(instances), "rules", len(rules), "rateLimitSpecs", len(domainSpecs), "dkimDomains", len(dkimByDomain))
	return &routeState{
		engine:       routing.Build(rules),
		instances:    instances,
		limiter:      ratelimit.Build(domainSpecs),
		provLimiter:  ratelimit.Build(provSpecs),
		dkimByDomain: dkimByDomain,
	}
}

// resolveCreds resolves a provider's credentials by secret_ref. It prefers the
// envelope-encrypted secret stored in Postgres (decrypted with the KEK); failing
// that it falls back to a JSON file under secretDir. The DB never holds
// plaintext — only the encrypted envelope. Empty ref → no credentials.
func resolveCreds(ctx context.Context, database *db.DB, cipher *secrets.Cipher, secretDir, secretRef string) providers.Creds {
	if secretRef == "" {
		return providers.Creds{}
	}
	// 1) Encrypted secret in Postgres.
	if cipher != nil {
		if env, err := database.GetSecret(ctx, secretRef); err == nil && env != "" {
			if pt, derr := cipher.Decrypt(env); derr == nil {
				var c providers.Creds
				if json.Unmarshal(pt, &c) == nil {
					return c
				}
			}
		}
	}
	// 2) File fallback.
	b, err := os.ReadFile(filepath.Join(secretDir, secretRef))
	if err != nil {
		return providers.Creds{}
	}
	var c providers.Creds
	_ = json.Unmarshal(b, &c)
	return c
}

// toDLQ moves a job to the DLQ and acks the original delivery.
func (w *worker) toDLQ(ctx context.Context, d amqp091.Delivery, job *model.RelayJob) {
	if err := w.bus.DeadLetter(ctx, job); err != nil {
		w.log.Error("dead-letter", "err", err, "id", job.MessageID)
		_ = d.Nack(false, true)
		return
	}
	_ = d.Ack(false)
}

func serveHealth(addr string, database *db.DB, bus *amqp.Conn, wk *worker, logger *slog.Logger) {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok")
	})
	// Test a provider's connectivity + auth without sending (Admin API action).
	// This triggers outbound SMTP dials, so it must not be callable by anything
	// in-cluster: require the shared admin token (the Admin API forwards it).
	// Fail closed if no token is configured.
	testToken := os.Getenv("NOVAMAIL_ADMIN_API_KEY")
	mux.HandleFunc("/test/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if testToken == "" || r.Header.Get("X-Internal-Auth") != testToken {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "unauthorized"})
			return
		}
		id := strings.TrimPrefix(r.URL.Path, "/test/")
		st := wk.state.Load()
		p, ok := st.instances[id]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "unknown or disabled provider"})
			return
		}
		t, ok := p.(providers.Tester)
		if !ok {
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "provider type does not support testing"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		if err := t.Verify(ctx); err != nil {
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "provider": p.Name()})
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
