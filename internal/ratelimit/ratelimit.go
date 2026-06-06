// Package ratelimit enforces per-recipient-domain delivery rate limits using a
// token bucket per domain (spec §6: "per-domain rate limits ... token budget").
package ratelimit

import (
	"strings"
	"time"

	"golang.org/x/time/rate"

	"github.com/azrtydxb/novamail/internal/model"
)

// Limiter holds one token bucket per configured domain, plus an optional "*"
// default. Domains with no matching bucket are unlimited.
type Limiter struct {
	byDomain map[string]*rate.Limiter
	def      *rate.Limiter
}

// Build constructs a Limiter from rate-limit config.
func Build(limits []model.RateLimit) *Limiter {
	l := &Limiter{byDomain: make(map[string]*rate.Limiter, len(limits))}
	for _, rl := range limits {
		lim := rate.NewLimiter(rate.Limit(rl.PerSecond), rl.Burst)
		if rl.Domain == "*" {
			l.def = lim
		} else {
			l.byDomain[strings.ToLower(rl.Domain)] = lim
		}
	}
	return l
}

func (l *Limiter) bucket(domain string) *rate.Limiter {
	if b, ok := l.byDomain[strings.ToLower(domain)]; ok {
		return b
	}
	return l.def // may be nil (unlimited)
}

// Reserve attempts to consume one token for the domain now. It returns the delay
// the caller must wait before sending, and ok=false if the domain is unlimited
// (send immediately). If the caller cannot wait that long it must call Cancel.
func (l *Limiter) Reserve(domain string) (delay time.Duration, res *rate.Reservation, ok bool) {
	b := l.bucket(domain)
	if b == nil {
		return 0, nil, false
	}
	r := b.Reserve()
	return r.Delay(), r, true
}

// Empty reports whether any limits are configured.
func (l *Limiter) Empty() bool { return len(l.byDomain) == 0 && l.def == nil }
