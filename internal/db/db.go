// Package db is the thin Postgres access layer for message metadata and the
// per-attempt event log that backs the tracing UI. Config/audit tables are
// owned by the Admin API (M4); this package covers the data-plane writes.
package db

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"

	"github.com/azrtydxb/novamail/internal/model"
)

// ErrAuth is returned when authentication fails (unknown user or bad password).
var ErrAuth = errors.New("authentication failed")

// DB wraps a pgx pool.
type DB struct{ pool *pgxpool.Pool }

// Open creates a connection pool from a DSN.
func Open(ctx context.Context, dsn string) (*DB, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("pgx pool: %w", err)
	}
	return &DB{pool: pool}, nil
}

func (d *DB) Close() { d.pool.Close() }

// Ping checks connectivity (for readiness).
func (d *DB) Ping(ctx context.Context) error { return d.pool.Ping(ctx) }

// Authenticate verifies a username/password against the accounts table and
// returns the account on success. Returns ErrAuth on unknown user or mismatch.
func (d *DB) Authenticate(ctx context.Context, username, password string) (*model.Account, error) {
	var (
		acc  model.Account
		hash string
	)
	err := d.pool.QueryRow(ctx,
		`SELECT id, username, password_hash, allowed_sender_domains,
		        coalesce(array(SELECT host(network(x))||'/'||masklen(x) FROM unnest(ip_allowlist) x), '{}')
		   FROM accounts WHERE username=$1 AND enabled = true`, username,
	).Scan(&acc.ID, &acc.Username, &hash, &acc.AllowedSenderDomains, &acc.IPAllowlist)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrAuth
	}
	if err != nil {
		return nil, fmt.Errorf("query account: %w", err)
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return nil, ErrAuth
	}
	return &acc, nil
}

// nullStr maps "" to a SQL NULL so optional text columns stay null, not empty.
func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// GetSettingInt returns an integer setting, or def if absent/unparseable.
func (d *DB) GetSettingInt(ctx context.Context, key string, def int64) int64 {
	var v int64
	err := d.pool.QueryRow(ctx, "SELECT (value#>>'{}')::bigint FROM settings WHERE key=$1", key).Scan(&v)
	if err != nil {
		return def
	}
	return v
}

// PruneOld deletes terminal messages and old events beyond the retention window.
// message_events cascade with their message; events for live messages are kept.
func (d *DB) PruneOld(ctx context.Context, days int) (int64, error) {
	tag, err := d.pool.Exec(ctx,
		`DELETE FROM messages
		  WHERE status IN ('relayed','bounced','failed')
		    AND updated_at < now() - make_interval(days => $1)`, days)
	if err != nil {
		return 0, fmt.Errorf("prune messages: %w", err)
	}
	return tag.RowsAffected(), nil
}

// ActiveBodyRefs returns the set of body keys still referenced by a non-terminal
// message (queued/deferred) — everything else on the body volume is an orphan.
func (d *DB) ActiveBodyRefs(ctx context.Context) (map[string]bool, error) {
	rows, err := d.pool.Query(ctx,
		`SELECT body_ref FROM messages WHERE status IN ('queued','deferred')`)
	if err != nil {
		return nil, fmt.Errorf("active body refs: %w", err)
	}
	defer rows.Close()
	set := map[string]bool{}
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		set[k] = true
	}
	return set, rows.Err()
}

// GetSecret returns the envelope-encrypted blob for a secret_ref, or "" if none.
func (d *DB) GetSecret(ctx context.Context, ref string) (string, error) {
	var env string
	err := d.pool.QueryRow(ctx, "SELECT envelope FROM secrets WHERE ref=$1", ref).Scan(&env)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("get secret: %w", err)
	}
	return env, nil
}

// GetRateLimits loads all enabled rate limits (both directions/all scopes).
func (d *DB) GetRateLimits(ctx context.Context) ([]model.RateLimit, error) {
	rows, err := d.pool.Query(ctx,
		`SELECT id::text, direction, scope, coalesce(scope_value,'*'), per_second, burst
		   FROM rate_limits WHERE enabled = true`)
	if err != nil {
		return nil, fmt.Errorf("query rate limits: %w", err)
	}
	defer rows.Close()
	var out []model.RateLimit
	for rows.Next() {
		var rl model.RateLimit
		if err := rows.Scan(&rl.ID, &rl.Direction, &rl.Scope, &rl.ScopeValue, &rl.PerSecond, &rl.Burst); err != nil {
			return nil, err
		}
		out = append(out, rl)
	}
	return out, rows.Err()
}

// GetActiveDKIMKeys loads active DKIM signing keys (one active selector/domain).
func (d *DB) GetActiveDKIMKeys(ctx context.Context) ([]model.DKIMKey, error) {
	rows, err := d.pool.Query(ctx,
		`SELECT domain, selector, coalesce(private_ref,''), rotation
		   FROM dkim_keys WHERE rotation = 'active'`)
	if err != nil {
		return nil, fmt.Errorf("query dkim keys: %w", err)
	}
	defer rows.Close()
	var out []model.DKIMKey
	for rows.Next() {
		var k model.DKIMKey
		if err := rows.Scan(&k.Domain, &k.Selector, &k.PrivateRef, &k.Rotation); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// GetSuppressions loads the active suppression addresses (lowercased).
func (d *DB) GetSuppressions(ctx context.Context) ([]string, error) {
	rows, err := d.pool.Query(ctx,
		`SELECT address FROM suppressions WHERE expires_at IS NULL OR expires_at > now()`)
	if err != nil {
		return nil, fmt.Errorf("query suppressions: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var a string
		if err := rows.Scan(&a); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// AddSuppression inserts/refreshes a suppression for an address (lowercased).
func (d *DB) AddSuppression(ctx context.Context, address, reason, source, detail string) error {
	_, err := d.pool.Exec(ctx,
		`INSERT INTO suppressions (address, reason, source, detail) VALUES (lower($1),$2,$3,$4)
		 ON CONFLICT (address) DO UPDATE SET reason=EXCLUDED.reason, source=EXCLUDED.source, detail=EXCLUDED.detail, created_at=now()`,
		address, reason, source, detail)
	if err != nil {
		return fmt.Errorf("add suppression: %w", err)
	}
	return nil
}

// GetRelayDomains loads the set of permitted sender/relay domains (enabled).
// An empty result means "no domain gate" (accept any sender domain).
func (d *DB) GetRelayDomains(ctx context.Context) ([]string, error) {
	rows, err := d.pool.Query(ctx, `SELECT domain FROM relay_domains WHERE enabled = true`)
	if err != nil {
		return nil, fmt.Errorf("query relay domains: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// GetRelayClients loads all enabled trusted relay client ranges.
func (d *DB) GetRelayClients(ctx context.Context) ([]model.RelayClient, error) {
	rows, err := d.pool.Query(ctx,
		`SELECT id::text, host(network(cidr))||'/'||masklen(cidr), coalesce(description,''),
		        allowed_sender_domains, enabled
		   FROM relay_clients WHERE enabled = true`)
	if err != nil {
		return nil, fmt.Errorf("query relay clients: %w", err)
	}
	defer rows.Close()
	var out []model.RelayClient
	for rows.Next() {
		var c model.RelayClient
		if err := rows.Scan(&c.ID, &c.CIDR, &c.Description, &c.AllowedSenderDomains, &c.Enabled); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// GetProviders loads all enabled providers.
func (d *DB) GetProviders(ctx context.Context) ([]model.Provider, error) {
	rows, err := d.pool.Query(ctx,
		`SELECT id::text, name, type, coalesce(endpoint,''), coalesce(auth_mode,''), enabled, coalesce(secret_ref,'')
		   FROM providers WHERE enabled = true`)
	if err != nil {
		return nil, fmt.Errorf("query providers: %w", err)
	}
	defer rows.Close()
	var out []model.Provider
	for rows.Next() {
		var p model.Provider
		if err := rows.Scan(&p.ID, &p.Name, &p.Type, &p.Endpoint, &p.AuthMode, &p.Enabled, &p.SecretRef); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// GetRoutingRules loads all enabled rules, highest priority first.
func (d *DB) GetRoutingRules(ctx context.Context) ([]model.RoutingRule, error) {
	rows, err := d.pool.Query(ctx,
		`SELECT id::text, coalesce(recipient_domain,''), coalesce(sender_domain,''),
		        provider_chain::text[], priority, enabled
		   FROM routing_rules WHERE enabled = true
		  ORDER BY priority DESC, id`)
	if err != nil {
		return nil, fmt.Errorf("query routing rules: %w", err)
	}
	defer rows.Close()
	var out []model.RoutingRule
	for rows.Next() {
		var r model.RoutingRule
		var chain []string
		if err := rows.Scan(&r.ID, &r.RecipientDomain, &r.SenderDomain, &chain, &r.Priority, &r.Enabled); err != nil {
			return nil, err
		}
		r.ProviderChain = chain
		out = append(out, r)
	}
	return out, rows.Err()
}

// LastDetail returns the most recent event detail for a message (used by the
// DSN generator to quote the upstream diagnostic). Empty string if none.
func (d *DB) LastDetail(ctx context.Context, id string) (string, error) {
	var detail string
	err := d.pool.QueryRow(ctx,
		`SELECT coalesce(detail,'') FROM message_events
		  WHERE message_id=$1 ORDER BY at DESC LIMIT 1`, id,
	).Scan(&detail)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("last detail: %w", err)
	}
	return detail, nil
}

// InsertMessage records a newly accepted message in 'queued' status and logs a
// 'queued' event. The message id is generated by the caller (also the body key).
func (d *DB) InsertMessage(ctx context.Context, id string, env model.Envelope, bodyRef model.BodyRef, meta model.MessageMeta) error {
	tx, err := d.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // rollback after commit is a no-op

	if _, err := tx.Exec(ctx,
		`INSERT INTO messages (id, mail_from, rcpt_to, body_ref, body_backend, status, subject, message_id, size_bytes)
		 VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$8)`,
		id, env.MailFrom, env.RcptTo, bodyRef.Key, bodyRef.Backend,
		nullStr(meta.Subject), nullStr(meta.MessageID), meta.SizeBytes,
	); err != nil {
		return fmt.Errorf("insert message: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO message_events (message_id, kind) VALUES ($1,'queued')`, id,
	); err != nil {
		return fmt.Errorf("insert event: %w", err)
	}
	return tx.Commit(ctx)
}

// RecordAttempt updates the message status, bumps attempts, and appends an event.
func (d *DB) RecordAttempt(ctx context.Context, id, status, kind, provider, detail string) error {
	tx, err := d.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err := tx.Exec(ctx,
		`UPDATE messages SET status=$2, attempts=attempts+1, updated_at=now() WHERE id=$1`,
		id, status,
	); err != nil {
		return fmt.Errorf("update message: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO message_events (message_id, kind, provider, detail) VALUES ($1,$2,$3,$4)`,
		id, kind, provider, detail,
	); err != nil {
		return fmt.Errorf("insert event: %w", err)
	}
	return tx.Commit(ctx)
}
