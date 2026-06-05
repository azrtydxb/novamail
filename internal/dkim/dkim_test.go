package dkim

import (
	"crypto/rand"
	"crypto/rsa"
	"io"
	"strings"
	"testing"
)

func TestSignAddsSignatureHeader(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	s := &Signer{domain: "example.com", selector: "s1", key: key}

	msg := "From: alice@example.com\r\n" +
		"To: bob@downstream.test\r\n" +
		"Subject: hi\r\n" +
		"Date: Mon, 01 Jan 2026 00:00:00 +0000\r\n" +
		"\r\n" +
		"body\r\n"

	out, err := s.Sign(strings.NewReader(msg))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	signed, _ := io.ReadAll(out)
	if !strings.Contains(string(signed), "DKIM-Signature:") {
		t.Fatalf("expected DKIM-Signature header, got:\n%s", signed)
	}
	if !strings.Contains(string(signed), "d=example.com") {
		t.Fatal("expected signing domain in signature")
	}
}

func TestLoadDisabledWhenUnset(t *testing.T) {
	s, err := Load("", "", "")
	if err != nil || s != nil {
		t.Fatalf("expected disabled signer (nil,nil), got %v,%v", s, err)
	}
}
