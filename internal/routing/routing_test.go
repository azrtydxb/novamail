package routing

import (
	"reflect"
	"testing"

	"github.com/azrtydxb/novamail/internal/model"
)

func TestResolvePrecedence(t *testing.T) {
	rules := []model.RoutingRule{
		{ID: "1", RecipientDomain: "vip.com", ProviderChain: []string{"p-recip"}, Enabled: true, Priority: 10},
		{ID: "2", SenderDomain: "me.com", ProviderChain: []string{"p-send"}, Enabled: true, Priority: 5},
		{ID: "3", ProviderChain: []string{"p-default"}, Enabled: true, Priority: 1},
	}
	e := Build(rules)

	cases := []struct {
		recip, sender string
		want          []string
	}{
		{"vip.com", "me.com", []string{"p-recip"}},   // recipient wins over sender
		{"other.com", "me.com", []string{"p-send"}},  // sender match
		{"other.com", "x.com", []string{"p-default"}}, // default
		{"VIP.COM", "X.com", []string{"p-recip"}},     // case-insensitive
	}
	for _, c := range cases {
		if got := e.Resolve(c.recip, c.sender); !reflect.DeepEqual(got, c.want) {
			t.Errorf("Resolve(%q,%q)=%v want %v", c.recip, c.sender, got, c.want)
		}
	}
}

func TestResolveNoMatchNoDefault(t *testing.T) {
	e := Build([]model.RoutingRule{
		{ID: "1", RecipientDomain: "vip.com", ProviderChain: []string{"p"}, Enabled: true},
	})
	if got := e.Resolve("other.com", "x.com"); got != nil {
		t.Errorf("expected nil chain, got %v", got)
	}
}

func TestDisabledAndEmptyChainsIgnored(t *testing.T) {
	e := Build([]model.RoutingRule{
		{ID: "1", ProviderChain: []string{"p"}, Enabled: false},
		{ID: "2", RecipientDomain: "a.com", ProviderChain: nil, Enabled: true},
	})
	if !e.Empty() {
		t.Error("engine should be empty (all rules disabled/empty)")
	}
}

func TestFailoverChainPreserved(t *testing.T) {
	e := Build([]model.RoutingRule{
		{ID: "1", RecipientDomain: "a.com", ProviderChain: []string{"primary", "backup"}, Enabled: true},
	})
	if got := e.Resolve("a.com", ""); !reflect.DeepEqual(got, []string{"primary", "backup"}) {
		t.Errorf("failover chain not preserved: %v", got)
	}
}
