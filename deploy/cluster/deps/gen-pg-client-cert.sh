#!/usr/bin/env bash
# Generate the app's Postgres client certificate (CN=novamail) signed by the
# CloudNativePG cluster CA, and store it as the secret `novamail-pg-client`.
# This is the client half of Postgres mutual TLS: the data-plane + admin-api
# present it, and CNPG's pg_hba (clientcert=verify-ca) requires it.
#
#   ./gen-pg-client-cert.sh [namespace]
set -euo pipefail
NS="${1:-novamail}"
CLUSTER=novamail-pg
ROLE=novamail
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# Pull the CNPG-managed CA (signs both server and client certs).
kubectl -n "$NS" get secret "${CLUSTER}-ca" -o jsonpath='{.data.ca\.crt}' | base64 -d > "$tmp/ca.crt"
kubectl -n "$NS" get secret "${CLUSTER}-ca" -o jsonpath='{.data.ca\.key}' | base64 -d > "$tmp/ca.key"

# Client key + CSR (CN = the DB role) and a clientAuth cert.
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$tmp/client.key"
openssl req -new -key "$tmp/client.key" -out "$tmp/client.csr" -subj "/CN=${ROLE}"
printf 'extendedKeyUsage = clientAuth\nkeyUsage = digitalSignature, keyEncipherment\n' > "$tmp/ext.cnf"
openssl x509 -req -in "$tmp/client.csr" -CA "$tmp/ca.crt" -CAkey "$tmp/ca.key" \
  -CAcreateserial -days 365 -out "$tmp/client.crt" -extfile "$tmp/ext.cnf"
openssl verify -CAfile "$tmp/ca.crt" "$tmp/client.crt"

kubectl -n "$NS" create secret tls novamail-pg-client \
  --cert="$tmp/client.crt" --key="$tmp/client.key" \
  --dry-run=client -o yaml | kubectl -n "$NS" apply -f -
echo "novamail-pg-client created/updated (CN=${ROLE}, signed by ${CLUSTER}-ca)."
