package store

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// FSStore writes bodies as files under a root directory, which on kw is a
// ReadWriteMany volume shared between ingress and delivery pods. Bodies are
// sharded by the first two id characters to avoid huge flat directories.
type FSStore struct {
	root string
}

// NewFSStore returns a filesystem-backed Store rooted at dir, creating it if needed.
func NewFSStore(dir string) (*FSStore, error) {
	if dir == "" {
		return nil, errors.New("store: empty filesystem root")
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("store: create root %q: %w", dir, err)
	}
	return &FSStore{root: dir}, nil
}

func (s *FSStore) path(id string) (string, error) {
	// Guard against path traversal and empty ids.
	if id == "" || strings.ContainsAny(id, "/\\") || id == "." || id == ".." {
		return "", fmt.Errorf("store: invalid body id %q", id)
	}
	shard := id
	if len(id) >= 2 {
		shard = id[:2]
	}
	return filepath.Join(s.root, shard, id), nil
}

// Put writes the body atomically: stream to a temp file, then rename into place.
func (s *FSStore) Put(ctx context.Context, id string, r io.Reader) error {
	dst, err := s.path(id)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o750); err != nil {
		return fmt.Errorf("store: mkdir: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".tmp-"+id+"-*")
	if err != nil {
		return fmt.Errorf("store: temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }() // no-op once renamed

	if _, err := io.Copy(tmp, r); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("store: write body: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("store: sync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("store: close: %w", err)
	}
	if err := os.Rename(tmpName, dst); err != nil {
		return fmt.Errorf("store: rename: %w", err)
	}
	return nil
}

// Get opens the body for reading.
func (s *FSStore) Get(ctx context.Context, id string) (io.ReadCloser, error) {
	p, err := s.path(id)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, fmt.Errorf("store: open %q: %w", id, err)
	}
	return f, nil
}

// Delete removes a body; a missing body is not an error.
func (s *FSStore) Delete(ctx context.Context, id string) error {
	p, err := s.path(id)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("store: delete %q: %w", id, err)
	}
	return nil
}
