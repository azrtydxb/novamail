// Package ratelimit enforces token-bucket rate limits keyed by an arbitrary
// string (recipient domain, provider, account, source IP, …). The "*" key is a
// catch-all default. Used by both the inbound (ingress) and outbound (delivery)
// paths.
package ratelimit

import (
	"strings"
	"time"

	"golang.org/x/time/rate"
)

// Spec is one configured limit: a key with a sustained per-second rate + burst.
type Spec struct {
	Key       string // "*" = default for unmatched keys
	PerSecond float64
	Burst     int
}

// Limiter holds one token bucket per key, plus an optional "*" default.
type Limiter struct {
	byKey map[string]*rate.Limiter
	def   *rate.Limiter
}

// Build constructs a Limiter from specs.
func Build(specs []Spec) *Limiter {
	l := &Limiter{byKey: make(map[string]*rate.Limiter, len(specs))}
	for _, s := range specs {
		lim := rate.NewLimiter(rate.Limit(s.PerSecond), s.Burst)
		if s.Key == "*" {
			l.def = lim
		} else {
			l.byKey[strings.ToLower(s.Key)] = lim
		}
	}
	return l
}

func (l *Limiter) bucket(key string) *rate.Limiter {
	if b, ok := l.byKey[strings.ToLower(key)]; ok {
		return b
	}
	return l.def // may be nil (unlimited)
}

// Reserve attempts to consume one token for key. Returns the delay the caller
// must wait before proceeding, the reservation (Cancel it if not used), and
// ok=false when the key is unlimited (proceed immediately).
func (l *Limiter) Reserve(key string) (delay time.Duration, res *rate.Reservation, ok bool) {
	b := l.bucket(key)
	if b == nil {
		return 0, nil, false
	}
	r := b.Reserve()
	return r.Delay(), r, true
}

// Empty reports whether any limits are configured.
func (l *Limiter) Empty() bool { return len(l.byKey) == 0 && l.def == nil }
