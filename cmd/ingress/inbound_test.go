package main

import (
	"net"
	"testing"
)

func TestSendersAllow(t *testing.T) {
	cases := []struct {
		allowed []string
		domain  string
		want    bool
	}{
		{nil, "example.com", true},                          // empty ⇒ any
		{[]string{}, "example.com", true},                   // empty ⇒ any
		{[]string{"*"}, "anything.test", true},              // wildcard ⇒ any
		{[]string{"example.com"}, "example.com", true},      // exact
		{[]string{"example.com"}, "EXAMPLE.COM", true},      // case-insensitive
		{[]string{"a.com", "b.com"}, "b.com", true},         // in set
		{[]string{"a.com", "b.com"}, "c.com", false},        // not in set
		{[]string{"example.com"}, "evil.com", false},        // mismatch rejected
	}
	for _, c := range cases {
		if got := sendersAllow(c.allowed, c.domain); got != c.want {
			t.Errorf("sendersAllow(%v, %q) = %v, want %v", c.allowed, c.domain, got, c.want)
		}
	}
}

func TestIPInAny(t *testing.T) {
	ip := net.ParseIP("10.1.2.3")
	if !ipInAny(ip, []string{"10.0.0.0/8"}) {
		t.Error("10.1.2.3 should be in 10.0.0.0/8")
	}
	if ipInAny(ip, []string{"192.168.0.0/16"}) {
		t.Error("10.1.2.3 should NOT be in 192.168.0.0/16")
	}
	// A malformed CIDR must be skipped, never accidentally match.
	if ipInAny(ip, []string{"not-a-cidr", "garbage/99"}) {
		t.Error("malformed CIDRs must not match")
	}
	// IPv6.
	if !ipInAny(net.ParseIP("2001:db8::1"), []string{"2001:db8::/32"}) {
		t.Error("IPv6 in-range should match")
	}
	if ipInAny(nil, []string{"10.0.0.0/8"}) {
		t.Error("nil IP must not match")
	}
}

func TestMatchClient(t *testing.T) {
	_, n1, _ := net.ParseCIDR("10.0.0.0/8")
	_, n2, _ := net.ParseCIDR("203.0.113.0/24")
	p := &inboundPolicy{clients: []trustedClient{
		{net: n1, senders: []string{"a.com"}},
		{net: n2, senders: []string{"b.com"}},
	}}
	if c := p.matchClient(net.ParseIP("10.9.9.9")); c == nil || c.senders[0] != "a.com" {
		t.Error("10.9.9.9 should match the 10/8 client")
	}
	if c := p.matchClient(net.ParseIP("203.0.113.5")); c == nil || c.senders[0] != "b.com" {
		t.Error("203.0.113.5 should match the 203.0.113/24 client")
	}
	if c := p.matchClient(net.ParseIP("8.8.8.8")); c != nil {
		t.Error("8.8.8.8 should match no trusted client")
	}
	if c := p.matchClient(nil); c != nil {
		t.Error("nil IP should match no client")
	}
}

func TestRelayDomainOK(t *testing.T) {
	// Empty gate ⇒ accept any (documented default).
	empty := &inboundPolicy{relayDomains: map[string]bool{}}
	if !empty.relayDomainOK("anything.com") {
		t.Error("empty relay-domain gate should accept any sender domain")
	}
	// Populated gate ⇒ only listed domains, case-insensitive.
	gated := &inboundPolicy{relayDomains: map[string]bool{"example.com": true}}
	if !gated.relayDomainOK("EXAMPLE.com") {
		t.Error("listed domain should pass (case-insensitive)")
	}
	if gated.relayDomainOK("other.com") {
		t.Error("unlisted domain should be rejected")
	}
}

func TestRemoteIP(t *testing.T) {
	cases := map[string]string{
		"10.0.0.1:54321":   "10.0.0.1",
		"203.0.113.7:25":   "203.0.113.7",
		"[2001:db8::1]:587": "2001:db8::1",
		"10.0.0.2":         "10.0.0.2", // bare host (no port)
	}
	for addr, want := range cases {
		if got := remoteIP(addr); got == nil || got.String() != want {
			t.Errorf("remoteIP(%q) = %v, want %v", addr, got, want)
		}
	}
}
