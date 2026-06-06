package ratelimit

import "testing"

func TestUnlimitedWhenNoConfig(t *testing.T) {
	l := Build(nil)
	if !l.Empty() {
		t.Fatal("expected empty limiter")
	}
	if _, _, limited := l.Reserve("anything.com"); limited {
		t.Fatal("unconfigured key should be unlimited")
	}
}

func TestBurstThenThrottle(t *testing.T) {
	l := Build([]Spec{{Key: "slow.test", PerSecond: 1, Burst: 2}})
	for i := 0; i < 2; i++ {
		d, _, limited := l.Reserve("slow.test")
		if !limited || d > 0 {
			t.Fatalf("burst token %d should be immediate (limited=%v delay=%v)", i, limited, d)
		}
	}
	d, res, limited := l.Reserve("slow.test")
	if !limited || d <= 0 {
		t.Fatalf("third token should require a delay, got delay=%v limited=%v", d, limited)
	}
	res.Cancel()
}

func TestDefaultStar(t *testing.T) {
	l := Build([]Spec{{Key: "*", PerSecond: 5, Burst: 1}})
	if _, _, limited := l.Reserve("unmatched.com"); !limited {
		t.Fatal("'*' default should apply to unmatched keys")
	}
}

func TestCaseInsensitive(t *testing.T) {
	l := Build([]Spec{{Key: "Slow.Test", PerSecond: 1, Burst: 1}})
	if _, _, limited := l.Reserve("slow.test"); !limited {
		t.Fatal("key match should be case-insensitive")
	}
}
