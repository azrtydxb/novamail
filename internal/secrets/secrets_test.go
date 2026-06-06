package secrets

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"testing"
)

func newKey(t *testing.T) string {
	t.Helper()
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(k)
}

func TestRoundTrip(t *testing.T) {
	c, err := New(newKey(t))
	if err != nil {
		t.Fatal(err)
	}
	plain := []byte(`{"username":"ses-user","password":"s3cr3t"}`)
	env, err := c.Encrypt(plain)
	if err != nil {
		t.Fatal(err)
	}
	// Envelope must not leak plaintext.
	if bytes.Contains([]byte(env), []byte("s3cr3t")) {
		t.Fatal("plaintext leaked into envelope")
	}
	got, err := c.Decrypt(env)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatalf("round-trip mismatch: %s", got)
	}
}

func TestWrongKeyFails(t *testing.T) {
	c1, _ := New(newKey(t))
	c2, _ := New(newKey(t))
	env, _ := c1.Encrypt([]byte("hello"))
	if _, err := c2.Decrypt(env); err == nil {
		t.Fatal("decrypt with wrong KEK should fail")
	}
}

func TestRejectsShortKey(t *testing.T) {
	if _, err := New(base64.StdEncoding.EncodeToString([]byte("short"))); err == nil {
		t.Fatal("expected error for non-32-byte key")
	}
}
