// Package dkim signs outbound messages with DKIM. Forwarding/relaying breaks
// SPF/DKIM alignment otherwise. Load reads a single mounted PEM (fallback);
// LoadPEM builds a signer from an in-memory key for the DB-driven, per-domain
// multi-selector/rotation model (dkim_keys, keys decrypted from the secret store).
package dkim

import (
	"bytes"
	"crypto"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/emersion/go-msgauth/dkim"
)

// Signer signs messages for one domain/selector.
type Signer struct {
	domain   string
	selector string
	key      crypto.Signer
}

// Load reads a PEM private key and returns a Signer. If domain, selector, or
// keyPath is empty, signing is disabled and (nil, nil) is returned.
func Load(domain, selector, keyPath string) (*Signer, error) {
	if domain == "" || selector == "" || keyPath == "" {
		return nil, nil
	}
	pemBytes, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, fmt.Errorf("dkim: read key: %w", err)
	}
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("dkim: no PEM block in key file")
	}
	key, err := parseKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	return &Signer{domain: domain, selector: selector, key: key}, nil
}

// LoadPEM builds a Signer from an in-memory PEM private key (used by the
// DB-driven, per-domain DKIM path where keys are decrypted from the secret store).
func LoadPEM(domain, selector string, pemBytes []byte) (*Signer, error) {
	if domain == "" || selector == "" || len(pemBytes) == 0 {
		return nil, errors.New("dkim: domain, selector and key required")
	}
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("dkim: no PEM block in key")
	}
	key, err := parseKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	return &Signer{domain: domain, selector: selector, key: key}, nil
}

func parseKey(der []byte) (crypto.Signer, error) {
	if k, err := x509.ParsePKCS1PrivateKey(der); err == nil {
		return k, nil
	}
	if k, err := x509.ParsePKCS8PrivateKey(der); err == nil {
		if s, ok := k.(crypto.Signer); ok {
			return s, nil
		}
	}
	return nil, errors.New("dkim: unsupported private key (want PKCS#1 or PKCS#8)")
}

// Domain is the signing domain.
func (s *Signer) Domain() string { return s.domain }

// Sign reads the whole message and returns a reader of the DKIM-signed message
// (signature header prepended). DKIM must hash the body, so the message is
// buffered.
func (s *Signer) Sign(r io.Reader) (io.Reader, error) {
	var buf bytes.Buffer
	opts := &dkim.SignOptions{
		Domain:   s.domain,
		Selector: s.selector,
		Signer:   s.key,
		Hash:     crypto.SHA256,
		HeaderKeys: []string{
			"From", "To", "Subject", "Date", "Message-Id", "MIME-Version", "Content-Type",
		},
	}
	if err := dkim.Sign(&buf, r, opts); err != nil {
		return nil, fmt.Errorf("dkim: sign: %w", err)
	}
	return &buf, nil
}
