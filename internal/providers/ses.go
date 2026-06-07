package providers

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strings"
)

// sesSMTPPassword derives an Amazon SES SMTP password from an IAM secret access
// key, per AWS's documented algorithm (a SigV4-style HMAC chain over the literal
// date "11111111", the region, service "ses", "aws4_request", then the message
// "SendRawEmail", with a 0x04 version byte prepended). The SMTP *username* is the
// IAM access key ID (used as-is). This lets operators paste IAM credentials
// (auth_mode=iam) instead of pre-derived SES SMTP credentials.
func sesSMTPPassword(secretAccessKey, region string) string {
	sign := func(key []byte, msg string) []byte {
		h := hmac.New(sha256.New, key)
		h.Write([]byte(msg))
		return h.Sum(nil)
	}
	const date = "11111111"
	const service = "ses"
	const terminal = "aws4_request"
	const message = "SendRawEmail"
	const version = 0x04

	sig := sign([]byte("AWS4"+secretAccessKey), date)
	sig = sign(sig, region)
	sig = sign(sig, service)
	sig = sign(sig, terminal)
	sig = sign(sig, message)

	out := append([]byte{version}, sig...)
	return base64.StdEncoding.EncodeToString(out)
}

// sesRegion extracts the AWS region from an SES SMTP endpoint
// (email-smtp.<region>.amazonaws.com[:port]); defaults to us-east-1.
func sesRegion(endpoint string) string {
	host := endpoint
	if i := strings.IndexByte(host, ':'); i >= 0 {
		host = host[:i]
	}
	parts := strings.Split(host, ".")
	// email-smtp.<region>.amazonaws.com
	if len(parts) >= 4 && parts[0] == "email-smtp" {
		return parts[1]
	}
	return "us-east-1"
}
