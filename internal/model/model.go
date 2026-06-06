// Package model holds types shared across the data-plane services. The wire
// shapes here mirror the versioned JSON Schemas in /api — keep them in sync.
package model

import (
	"slices"
	"time"
)

// Status values for a message (mirrors the messages.status CHECK in migrations).
const (
	StatusQueued   = "queued"
	StatusRelayed  = "relayed"
	StatusDeferred = "deferred"
	StatusBounced  = "bounced"
	StatusFailed   = "failed"
)

// BodyRef points at the stored RFC822 body. Backend is "fs" (shared file store)
// or "pg" (Postgres bytea fallback).
type BodyRef struct {
	Backend string `json:"backend"`
	Key     string `json:"key"`
}

// Envelope is the SMTP envelope.
type Envelope struct {
	MailFrom string   `json:"mailFrom"`
	RcptTo   []string `json:"rcptTo"`
}

// RoutingHints are cheap hints carried on the job so the worker can route
// without re-parsing the body.
type RoutingHints struct {
	RecipientDomain string `json:"recipientDomain,omitempty"`
	SenderDomain    string `json:"senderDomain,omitempty"`
}

// RelayJob is published by ingress to relay.work. Mirrors api/relay-job.schema.json.
type RelayJob struct {
	V            int          `json:"v"`
	MessageID    string       `json:"messageId"`
	BodyRef      BodyRef      `json:"bodyRef"`
	Envelope     Envelope     `json:"envelope"`
	RoutingHints RoutingHints `json:"routingHints,omitempty"`
	Attempt      int          `json:"attempt"`
	EnqueuedAt   time.Time    `json:"enqueuedAt"`
}

// RelayJobVersion is the current schema version.
const RelayJobVersion = 1

// Account is a relay client (row in the accounts table). Credentials are
// validated by the data layer; PasswordHash never leaves the db package.
type Account struct {
	ID                   string
	Username             string
	AllowedSenderDomains []string
}

// RateLimit caps delivery throughput for a recipient domain (row in the
// rate_limits table). Domain "*" is the default for unmatched domains.
type RateLimit struct {
	Domain    string
	PerSecond float64
	Burst     int
}

// Provider is an upstream relay target (row in the providers table).
type Provider struct {
	ID        string
	Name      string
	Type      string // gmail | ses | m365 | smtp
	Endpoint  string // host:port
	AuthMode  string // xoauth2 | smtp-auth | ip | iam
	Enabled   bool
	SecretRef string // names the credential secret (resolved at startup)
}

// RoutingRule maps a recipient/sender domain to an ordered provider chain
// (row in the routing_rules table). A rule with both domains empty is the
// default. ProviderChain[0] is primary; the rest are failover.
type RoutingRule struct {
	ID              string
	RecipientDomain string
	SenderDomain    string
	ProviderChain   []string
	Priority        int
	Enabled         bool
}

// AllowsSender reports whether this account may use the given sender domain.
// An empty AllowedSenderDomains means "any" (single-tenant convenience).
func (a *Account) AllowsSender(domain string) bool {
	if len(a.AllowedSenderDomains) == 0 {
		return true
	}
	return slices.Contains(a.AllowedSenderDomains, domain)
}
