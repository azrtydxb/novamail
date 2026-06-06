package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var errPoolRequired = errors.New("store: postgres backend requires a pool")

// PgStore stores bodies in a Postgres bytea table (message_bodies). No shared
// filesystem required; the body is written once and read once, then deleted.
type PgStore struct{ pool *pgxpool.Pool }

// NewPgStore returns a Postgres-backed body store over an existing pool.
func NewPgStore(pool *pgxpool.Pool) *PgStore { return &PgStore{pool: pool} }

func (s *PgStore) Put(ctx context.Context, id string, r io.Reader) error {
	body, err := io.ReadAll(r)
	if err != nil {
		return fmt.Errorf("store: read body: %w", err)
	}
	if _, err := s.pool.Exec(ctx,
		`INSERT INTO message_bodies (id, body) VALUES ($1,$2)
		 ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body`, id, body); err != nil {
		return fmt.Errorf("store: insert body: %w", err)
	}
	return nil
}

func (s *PgStore) Get(ctx context.Context, id string) (io.ReadCloser, error) {
	var body []byte
	err := s.pool.QueryRow(ctx, `SELECT body FROM message_bodies WHERE id=$1`, id).Scan(&body)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("store: body %q not found", id)
	}
	if err != nil {
		return nil, fmt.Errorf("store: get body: %w", err)
	}
	return io.NopCloser(bytes.NewReader(body)), nil
}

func (s *PgStore) Delete(ctx context.Context, id string) error {
	if _, err := s.pool.Exec(ctx, `DELETE FROM message_bodies WHERE id=$1`, id); err != nil {
		return fmt.Errorf("store: delete body: %w", err)
	}
	return nil
}

func (s *PgStore) Walk(fn func(id string)) error {
	rows, err := s.pool.Query(context.Background(), `SELECT id FROM message_bodies`)
	if err != nil {
		return fmt.Errorf("store: walk bodies: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		fn(id)
	}
	return rows.Err()
}
