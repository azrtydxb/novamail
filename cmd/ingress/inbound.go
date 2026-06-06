package main

import (
	"context"
	"log/slog"
	"net"
	"strings"

	"github.com/azrtydxb/novamail/internal/db"
	"github.com/azrtydxb/novamail/internal/ratelimit"
)

// inboundPolicy is an immutable snapshot of submission-side authorization config
// (trusted relay clients, the relay-domain gate, inbound rate limits). It is
// rebuilt and atomically swapped on config.changed.
type inboundPolicy struct {
	clients      []trustedClient
	relayDomains map[string]bool // empty ⇒ no domain gate (accept any sender domain)
	limiter      *ratelimit.Limiter
}

type trustedClient struct {
	net     *net.IPNet
	senders []string // allowed sender domains ("*"/empty ⇒ any)
}

// buildInbound loads the submission policy from Postgres.
func buildInbound(ctx context.Context, database *db.DB, logger *slog.Logger) *inboundPolicy {
	p := &inboundPolicy{relayDomains: map[string]bool{}}

	clients, err := database.GetRelayClients(ctx)
	if err != nil {
		logger.Error("load relay clients", "err", err)
	}
	for _, c := range clients {
		_, ipnet, perr := net.ParseCIDR(c.CIDR)
		if perr != nil {
			logger.Warn("bad relay client cidr", "cidr", c.CIDR, "err", perr)
			continue
		}
		p.clients = append(p.clients, trustedClient{net: ipnet, senders: c.AllowedSenderDomains})
	}

	domains, err := database.GetRelayDomains(ctx)
	if err != nil {
		logger.Error("load relay domains", "err", err)
	}
	for _, d := range domains {
		p.relayDomains[strings.ToLower(d)] = true
	}

	limits, err := database.GetRateLimits(ctx)
	if err != nil {
		logger.Error("load rate limits", "err", err)
	}
	var specs []ratelimit.Spec
	for _, rl := range limits {
		if rl.Direction == "in" {
			specs = append(specs, ratelimit.Spec{Key: rl.ScopeValue, PerSecond: rl.PerSecond, Burst: rl.Burst})
		}
	}
	p.limiter = ratelimit.Build(specs)

	logger.Info("inbound policy loaded", "trustedClients", len(p.clients), "relayDomains", len(p.relayDomains), "inboundLimits", len(specs))
	return p
}

// matchClient returns the trusted client whose range contains ip, or nil.
func (p *inboundPolicy) matchClient(ip net.IP) *trustedClient {
	if ip == nil {
		return nil
	}
	for i := range p.clients {
		if p.clients[i].net.Contains(ip) {
			return &p.clients[i]
		}
	}
	return nil
}

// relayDomainOK reports whether the sender domain passes the relay-domain gate.
func (p *inboundPolicy) relayDomainOK(domain string) bool {
	if len(p.relayDomains) == 0 {
		return true // no gate configured
	}
	return p.relayDomains[strings.ToLower(domain)]
}

// sendersAllow reports whether the allowed-sender set permits the domain.
// Empty set or "*" means any.
func sendersAllow(allowed []string, domain string) bool {
	if len(allowed) == 0 {
		return true
	}
	for _, a := range allowed {
		if a == "*" || strings.EqualFold(a, domain) {
			return true
		}
	}
	return false
}

// ipInAny reports whether ip is within any of the CIDRs.
func ipInAny(ip net.IP, cidrs []string) bool {
	for _, c := range cidrs {
		if _, n, err := net.ParseCIDR(c); err == nil && n.Contains(ip) {
			return true
		}
	}
	return false
}

// remoteIP extracts the IP from a "host:port" remote address.
func remoteIP(addr string) net.IP {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	return net.ParseIP(host)
}
