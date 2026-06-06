// Command delivery consumes relay jobs, fetches the body from the shared file
// store, relays it through the configured upstream provider, and acks only
// after a successful handoff. M1 routes everything to a single generic SMTP
// smarthost; the DB-driven routing engine + retry tiers arrive in M3/M2.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
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
)

// maxRateBlock caps how long a worker will sleep to honor a rate limit before
// deferring the message to a wait tier instead (keeps the consumer flowing).
const maxRateBlock = 5 * time.Second

var (
	relayed  = promauto.NewCounter(prometheus.CounterOpts{Name: "novamail_delivery_relayed_total", Help: "Messages successfully relayed upstream."})
	deferred = promauto.NewCounter(prometheus.CounterOpts{Name: "novamail_delivery_deferred_total", Help: "Messages deferred (transient upstream failure)."})
	failed   = promauto.NewCounter(prometheus.CounterOpts{Name: "novamail_delivery_failed_total", Help: "Messages permanently failed."})
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

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

	bus, err := amqp.Dial(os.Getenv("AMQP_URL"))
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

	w := &worker{store: bodies, db: database, bus: bus, secretDir: secretDir, signer: signer, log: logger}
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
	go serveHealth(env("NOVAMAIL_HTTP_ADDR", ":8080"), database, bus, logger)

	deliveries, err := bus.Consume(20)
	if err != nil {
		logger.Error("consume", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	logger.Info("delivery worker started", "smarthost", os.Getenv("NOVAMAIL_SMARTHOST_ADDR"))

	// Graceful drain: stop accepting new work on signal, but let the message
	// currently being handled finish (it runs on a background context bounded by
	// its own per-message timeout). Anything unacked is redelivered.
	for {
		select {
		case <-ctx.Done():
			logger.Info("draining; shutting down")
			return
		case d, ok := <-deliveries:
			if !ok {
				logger.Error("delivery channel closed")
				return
			}
			w.handle(context.Background(), d)
		}
	}
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
		res, _ := p.Send(hctx, &providers.Message{Envelope: job.Envelope, Body: bytes.NewReader(raw)})
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
// relay (buffered so failover can replay them).
func (w *worker) materialize(ctx context.Context, job *model.RelayJob) ([]byte, error) {
	body, err := w.store.Get(ctx, job.BodyRef.Key)
	if err != nil {
		return nil, err
	}
	defer func() { _ = body.Close() }()

	var src io.Reader = body
	if sgn := w.signerFor(job.RoutingHints.SenderDomain); sgn != nil {
		signed, serr := sgn.Sign(body)
		if serr != nil {
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
	instances := make(map[string]providers.Provider, len(provs))
	for _, p := range provs {
		inst, err := providers.New(p, resolveCreds(ctx, database, cipher, secretDir, p.SecretRef))
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
