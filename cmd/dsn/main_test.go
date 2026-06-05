package main

import (
	"strings"
	"testing"
)

func TestBuildDSN(t *testing.T) {
	out := string(buildDSN("relay.example", "abc123", "alice@example.com",
		[]string{"bob@downstream.test"}, "550 no such user"))

	for _, want := range []string{
		"From: MAILER-DAEMON@relay.example",
		"To: alice@example.com",
		"Content-Type: multipart/report; report-type=delivery-status;",
		"Content-Type: message/delivery-status",
		"Final-Recipient: rfc822; bob@downstream.test",
		"Action: failed",
		"Diagnostic-Code: smtp; 550 no such user",
		"--novamail-dsn-abc123--",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("DSN missing %q\n---\n%s", want, out)
		}
	}
	if !strings.HasSuffix(out, "\r\n") {
		t.Error("DSN should use CRLF line endings")
	}
}

func TestBuildDSNDefaultDiagnostic(t *testing.T) {
	out := string(buildDSN("h", "id", "a@b.com", []string{"c@d.com"}, ""))
	if !strings.Contains(out, "delivery to upstream provider failed") {
		t.Error("expected default diagnostic when detail empty")
	}
}
