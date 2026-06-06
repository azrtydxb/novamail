package amqp

import "testing"

// TierForAttempt maps a (already-incremented) attempt number to a wait tier;
// past the schedule it returns ok=false so the message dead-letters. An
// off-by-one here changes the whole retry/bounce behavior.
func TestTierForAttempt(t *testing.T) {
	if _, ok := TierForAttempt(0); ok {
		t.Error("attempt 0 (idx -1) must be out of range")
	}
	want := []string{"wait.30s", "wait.5m", "wait.30m"}
	for i, q := range want {
		tier, ok := TierForAttempt(i + 1)
		if !ok || tier.Queue != q {
			t.Errorf("attempt %d: got (%q, %v), want (%q, true)", i+1, tier.Queue, ok, q)
		}
	}
	if _, ok := TierForAttempt(len(want) + 1); ok {
		t.Errorf("attempt %d should exhaust the schedule (→ DLQ)", len(want)+1)
	}
}
