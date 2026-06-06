package secrets

import "testing"

// TestDecryptTSEnvelope pins the cross-language envelope contract: this envelope
// was produced by the admin-api TypeScript implementation
// (services/admin-api/src/secrets.ts) with the KEK below. The Go delivery worker
// must be able to decrypt what the admin-api wrote (provider creds + DKIM keys),
// so a divergence in nonce length / base64 / DEK wrapping breaks production
// silently — this test catches it.
func TestDecryptTSEnvelope(t *testing.T) {
	const (
		kek      = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" // base64("0123456789abcdef0123456789abcdef")
		envelope = `{"v":1,"dek":"/3CjX3qt3P6NR+GeL0LpAybvE/K6J4RUI3Yy2VdGPcMIT9T/QTUN3Mqte/VKmXpByTwDUkWhjpfte7be","data":"6+Agxkpa0aoCw+8zbGGwXZZP7vW6cy6S7Yz8FijpdEJo2NG8qYXvJRkTR/Odf8t7vho="}`
		want     = "interop-check-novamail"
	)
	c, err := New(kek)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	got, err := c.Decrypt(envelope)
	if err != nil {
		t.Fatalf("Decrypt of TS-produced envelope failed (cross-language contract broken): %v", err)
	}
	if string(got) != want {
		t.Fatalf("Decrypt = %q, want %q", string(got), want)
	}
}
