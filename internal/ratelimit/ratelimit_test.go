package ratelimit

import (
	"testing"

	"github.com/azrtydxb/novamail/internal/model"
)

func TestUnlimitedWhenNoConfig(t *testing.T) {
	l := Build(nil)
	if !l.Empty() {
		t.Fatal("expected empty limiter")
	}
	if _, _, limited := l.Reserve("anything.com"); limited {
		t.Fatal("unconfigured domain should be unlimited")
	}
}

func TestBurstThenThrottle(t *testing.T) {
	// 1 token/sec, burst 2: first two immediate, third must wait.
	l := Build([]model.RateLimit{{Domain: "slow.test", PerSecond: 1, Burst: 2}})

	for i := 0; i < 2; i++ {
		d, _, limited := l.Reserve("slow.test")
		if !limited {
			t.Fatalf("token %d: domain should be limited/tracked", i)
		}
		if d > 0 {
			t.Fatalf("burst token %d should be immediate, got delay %v", i, d)
		}
	}
	d, res, limited := l.Reserve("slow.test")
	if !limited || d <= 0 {
		t.Fatalf("third token should require a delay, got delay=%v limited=%v", d, limited)
	}
	res.Cancel()
}

func TestDefaultStar(t *testing.T) {
	l := Build([]model.RateLimit{{Domain: "*", PerSecond: 5, Burst: 1}})
	if _, _, limited := l.Reserve("unmatched.com"); !limited {
		t.Fatal("'*' default should apply to unmatched domains")
	}
}

func TestCaseInsensitive(t *testing.T) {
	l := Build([]model.RateLimit{{Domain: "Slow.Test", PerSecond: 1, Burst: 1}})
	if _, _, limited := l.Reserve("slow.test"); !limited {
		t.Fatal("domain match should be case-insensitive")
	}
}
