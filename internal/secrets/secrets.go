// Package secrets implements envelope encryption for provider credentials and
// DKIM keys stored in Postgres (spec §10): a random per-secret data key (DEK)
// encrypts the plaintext, and the master key (KEK, from env/k8s Secret) wraps
// the DEK. Nothing is ever stored as plaintext in Postgres. The wire format
// matches the Admin API's TypeScript implementation so either side can produce
// envelopes the other reads.
//
// Envelope JSON: {"v":1,"dek":b64(nonce||AESGCM(KEK,DEK)),"data":b64(nonce||AESGCM(DEK,plaintext))}
// where each AES-256-GCM output is ciphertext||tag and the 12-byte nonce is
// prepended.
package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
)

type envelope struct {
	V    int    `json:"v"`
	DEK  string `json:"dek"`
	Data string `json:"data"`
}

// Cipher seals/opens envelopes with a 32-byte master key (KEK).
type Cipher struct{ kek []byte }

// New builds a Cipher from a base64-encoded 32-byte master key.
func New(kekB64 string) (*Cipher, error) {
	kek, err := base64.StdEncoding.DecodeString(kekB64)
	if err != nil {
		return nil, fmt.Errorf("secrets: decode master key: %w", err)
	}
	if len(kek) != 32 {
		return nil, fmt.Errorf("secrets: master key must be 32 bytes, got %d", len(kek))
	}
	return &Cipher{kek: kek}, nil
}

func sealGCM(key, plaintext []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	ct := gcm.Seal(nil, nonce, plaintext, nil)
	return base64.StdEncoding.EncodeToString(append(nonce, ct...)), nil
}

func openGCM(key []byte, b64 string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	ns := gcm.NonceSize()
	if len(raw) < ns {
		return nil, errors.New("secrets: ciphertext too short")
	}
	return gcm.Open(nil, raw[:ns], raw[ns:], nil)
}

// Encrypt produces an envelope for plaintext.
func (c *Cipher) Encrypt(plaintext []byte) (string, error) {
	dek := make([]byte, 32)
	if _, err := rand.Read(dek); err != nil {
		return "", err
	}
	data, err := sealGCM(dek, plaintext)
	if err != nil {
		return "", err
	}
	wrapped, err := sealGCM(c.kek, dek)
	if err != nil {
		return "", err
	}
	out, err := json.Marshal(envelope{V: 1, DEK: wrapped, Data: data})
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// Decrypt opens an envelope.
func (c *Cipher) Decrypt(envJSON string) ([]byte, error) {
	var e envelope
	if err := json.Unmarshal([]byte(envJSON), &e); err != nil {
		return nil, fmt.Errorf("secrets: parse envelope: %w", err)
	}
	dek, err := openGCM(c.kek, e.DEK)
	if err != nil {
		return nil, fmt.Errorf("secrets: unwrap dek: %w", err)
	}
	pt, err := openGCM(dek, e.Data)
	if err != nil {
		return nil, fmt.Errorf("secrets: decrypt: %w", err)
	}
	return pt, nil
}
