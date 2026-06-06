// Package routing resolves which provider chain delivers a message. Precedence
// (spec §7): recipient-domain rule → sender-domain rule → default rule. Each
// rule carries an ordered provider chain (primary + failover).
package routing

import (
	"strings"

	"github.com/azrtydxb/novamail/internal/model"
)

// Engine resolves provider chains from a snapshot of routing rules. It is
// immutable after Build; M4 hot-reload swaps in a new Engine.
type Engine struct {
	recipient map[string][]string // recipient domain → provider chain
	sender    map[string][]string // sender domain → provider chain
	def       []string            // default chain (rule with no domains)
}

// Build indexes enabled rules. Rules are assumed pre-sorted by priority desc,
// so the first rule seen for a domain wins.
func Build(rules []model.RoutingRule) *Engine {
	e := &Engine{recipient: map[string][]string{}, sender: map[string][]string{}}
	for _, r := range rules {
		if !r.Enabled || len(r.ProviderChain) == 0 {
			continue
		}
		switch {
		case r.RecipientDomain != "":
			if _, ok := e.recipient[lower(r.RecipientDomain)]; !ok {
				e.recipient[lower(r.RecipientDomain)] = r.ProviderChain
			}
		case r.SenderDomain != "":
			if _, ok := e.sender[lower(r.SenderDomain)]; !ok {
				e.sender[lower(r.SenderDomain)] = r.ProviderChain
			}
		default:
			if e.def == nil {
				e.def = r.ProviderChain
			}
		}
	}
	return e
}

// Resolve returns the ordered provider-id chain for a message, or nil if no
// rule matches (caller falls back to its static default).
func (e *Engine) Resolve(recipientDomain, senderDomain string) []string {
	if c, ok := e.recipient[lower(recipientDomain)]; ok {
		return c
	}
	if c, ok := e.sender[lower(senderDomain)]; ok {
		return c
	}
	return e.def
}

// Empty reports whether the engine has no rules at all.
func (e *Engine) Empty() bool {
	return len(e.recipient) == 0 && len(e.sender) == 0 && e.def == nil
}

func lower(s string) string { return strings.ToLower(s) }
