package store

import (
	"bytes"
	"context"
	"io"
	"strings"
	"testing"
)

func TestFSStoreRoundTrip(t *testing.T) {
	s, err := NewFSStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFSStore: %v", err)
	}
	ctx := context.Background()
	const id = "abc123"
	body := []byte("From: a@example.com\r\nTo: b@example.net\r\n\r\nhi\r\n")

	if err := s.Put(ctx, id, bytes.NewReader(body)); err != nil {
		t.Fatalf("Put: %v", err)
	}

	rc, err := s.Get(ctx, id)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	got, err := io.ReadAll(rc)
	rc.Close()
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Fatalf("round-trip mismatch: got %q want %q", got, body)
	}

	if err := s.Delete(ctx, id); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if err := s.Delete(ctx, id); err != nil {
		t.Fatalf("Delete missing should be nil, got: %v", err)
	}
	if _, err := s.Get(ctx, id); err == nil {
		t.Fatal("Get after delete: expected error")
	}
}

func TestFSStoreRejectsBadID(t *testing.T) {
	s, err := NewFSStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFSStore: %v", err)
	}
	for _, id := range []string{"", ".", "..", "a/b", "a\\b"} {
		if err := s.Put(context.Background(), id, strings.NewReader("x")); err == nil {
			t.Errorf("Put(%q): expected error", id)
		}
	}
}
