package providers

import "testing"

func TestSESSMTPPassword(t *testing.T) {
	// Deterministic + well-formed: 33 bytes (1 version + 32 HMAC) → 44 base64
	// chars, and the 0x04 version byte makes it start with 'B'.
	p := sesSMTPPassword("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1")
	if len(p) != 44 {
		t.Fatalf("SES SMTP password should be 44 base64 chars, got %d (%q)", len(p), p)
	}
	if p[0] != 'B' {
		t.Errorf("expected version-byte prefix 'B', got %q", p[:1])
	}
	if p2 := sesSMTPPassword("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1"); p2 != p {
		t.Error("derivation must be deterministic")
	}
	if p3 := sesSMTPPassword("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "eu-west-1"); p3 == p {
		t.Error("different region must yield a different password")
	}
}

func TestSESRegion(t *testing.T) {
	cases := map[string]string{
		"email-smtp.us-east-1.amazonaws.com:587": "us-east-1",
		"email-smtp.eu-west-1.amazonaws.com":     "eu-west-1",
		"smtp.example.com:587":                   "us-east-1", // non-SES → default
	}
	for in, want := range cases {
		if got := sesRegion(in); got != want {
			t.Errorf("sesRegion(%q) = %q, want %q", in, got, want)
		}
	}
}
