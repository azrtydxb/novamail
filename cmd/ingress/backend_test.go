package main

import "testing"

func TestDomainOf(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"alice@Example.COM", "example.com"},
		{"bob@mail.example.net", "mail.example.net"},
		{"noatsign", ""},
		{"", ""},
	} {
		if got := domainOf([]string{c.in}); got != c.want {
			t.Errorf("domainOf(%q)=%q want %q", c.in, got, c.want)
		}
	}
	if got := domainOf(nil); got != "" {
		t.Errorf("domainOf(nil)=%q want empty", got)
	}
}
