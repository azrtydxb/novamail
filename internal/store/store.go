// Package store is the message-body store abstraction.
//
// Bodies are large (multi-MB) and must NOT travel on the message bus or live in
// the metadata tables; the bus and Postgres carry only a reference (the body
// id). The interface is deliberately backend-agnostic so the data plane can run
// against a shared filesystem (the default — a ReadWriteMany volume on kw) or a
// Postgres-bytea fallback for tiny/single-node deployments. There is no object
// store / S3 dependency.
//
// RWX matters: ingress writes the body and a separate delivery pod reads it, so
// the filesystem backend must be mounted ReadWriteMany.
package store

import (
	"context"
	"io"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Store persists and retrieves raw RFC822 message bodies by id. Backends: a
// Postgres bytea table (default — no shared filesystem needed) or a filesystem
// directory (RWX volume) for deployments that prefer it.
type Store interface {
	// Put streams a body to the backend and returns its reference id.
	Put(ctx context.Context, id string, r io.Reader) error
	// Get opens the body for reading; the caller must Close it.
	Get(ctx context.Context, id string) (io.ReadCloser, error)
	// Delete removes a body; deleting a missing body is not an error.
	Delete(ctx context.Context, id string) error
	// Walk calls fn for every stored body id (used by the retention sweep).
	Walk(fn func(id string)) error
}

// Open selects a backend: "postgres"/"pg"/"" → Postgres (pool required);
// anything else is treated as a filesystem directory.
func Open(spec string, pool *pgxpool.Pool) (Store, error) {
	switch spec {
	case "", "postgres", "pg":
		if pool == nil {
			return nil, errPoolRequired
		}
		return NewPgStore(pool), nil
	default:
		return NewFSStore(spec)
	}
}
