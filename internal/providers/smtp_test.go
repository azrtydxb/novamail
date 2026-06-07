package providers

import (
	"errors"
	"testing"

	"github.com/emersion/go-smtp"
)

func TestClassify(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want Outcome
	}{
		{"transient 4xx", &smtp.SMTPError{Code: 451, Message: "try later"}, Defer},
		{"permanent 5xx", &smtp.SMTPError{Code: 550, Message: "no such user"}, Fail},
		{"network error", errors.New("connection refused"), Defer},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res, err := classify(c.err)
			if err == nil {
				t.Fatal("classify should propagate the error")
			}
			if res.Outcome != c.want {
				t.Fatalf("got %s, want %s", res.Outcome, c.want)
			}
		})
	}
}

func TestHostOnly(t *testing.T) {
	for in, want := range map[string]string{
		"mail.example.com:587": "mail.example.com",
		"10.0.0.1:25":          "10.0.0.1",
		"hostonly":             "hostonly",
		"[2001:db8::1]:587":    "2001:db8::1", // bracketed IPv6 host:port
		"[fe80::1]:465":        "fe80::1",
		"2001:db8::1":          "2001:db8::1", // bare IPv6, no port
	} {
		if got := hostOnly(in); got != want {
			t.Errorf("hostOnly(%q)=%q want %q", in, got, want)
		}
	}
}
