// Package providers defines the delivery provider abstraction and its built-in
// implementations. By default every message exits through an authenticated
// upstream provider (SMTP/SES/M365/Gmail); a `direct` provider additionally
// supports direct-to-MX delivery (resolve MX, deliver on :25) when configured.
package providers

import (
	"context"
	"io"

	"github.com/azrtydxb/novamail/internal/model"
)

// Outcome is how an upstream handoff resolved.
type Outcome int

const (
	Delivered Outcome = iota // accepted by upstream
	Defer                    // transient (4xx) — retry later
	Fail                     // permanent (5xx / max attempts) — dead-letter
)

func (o Outcome) String() string {
	switch o {
	case Delivered:
		return "delivered"
	case Defer:
		return "defer"
	default:
		return "fail"
	}
}

// Result is the outcome plus a human-readable detail (e.g. the upstream reply).
type Result struct {
	Outcome Outcome
	Detail  string
}

// Message is what a provider needs to relay one message.
type Message struct {
	Envelope model.Envelope
	// Body is the raw RFC822 stream; providers must not assume it is seekable.
	Body io.Reader
}

// Provider is a pluggable upstream relay target.
type Provider interface {
	// Send relays the message through the upstream. A non-nil error is treated
	// as a Defer unless the Result says otherwise.
	Send(ctx context.Context, m *Message) (Result, error)
	Name() string
}

// Tester is an optional capability: verify connectivity + auth without sending
// (the Admin API "test connection" action). Providers that can't be tested
// safely simply don't implement it.
type Tester interface {
	Verify(ctx context.Context) error
}
