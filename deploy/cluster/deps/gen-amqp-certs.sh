#!/usr/bin/env bash
# Provision RabbitMQ (nova-bus) mutual-TLS material:
#   nova-bus-ca           Opaque   ca.crt            (the CA clients trust)
#   nova-bus-server-tls   tls       tls.crt/tls.key/ca.crt  (broker server cert)
#   novamail-amqp-client  tls       tls.crt/tls.key   (app client cert)
# The RabbitMQ Cluster Operator's spec.tls references the server + CA secrets.
#
#   ./gen-amqp-certs.sh [namespace]
set -euo pipefail
NS="${1:-novamail}"
SVC=nova-bus
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cd "$tmp"

# Self-signed CA.
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ca.key
openssl req -x509 -new -key ca.key -days 3650 -subj "/CN=novamail-amqp-ca" -out ca.crt

gen() { # name CN extfile
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$1.key"
  openssl req -new -key "$1.key" -subj "/CN=$2" -out "$1.csr"
  openssl x509 -req -in "$1.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -days 730 \
    -out "$1.crt" -extfile "$3"
}

# Server cert: SANs for the nova-bus client service.
cat > server.ext <<EOF
subjectAltName = DNS:${SVC}, DNS:${SVC}.${NS}, DNS:${SVC}.${NS}.svc, DNS:${SVC}.${NS}.svc.cluster.local
extendedKeyUsage = serverAuth
EOF
gen server "${SVC}.${NS}.svc" server.ext

# Client cert (app).
printf 'extendedKeyUsage = clientAuth\n' > client.ext
gen client novamail-amqp client.ext

kubectl -n "$NS" create secret generic nova-bus-ca \
  --from-file=ca.crt --dry-run=client -o yaml | kubectl -n "$NS" apply -f -
kubectl -n "$NS" create secret tls nova-bus-server-tls --cert=server.crt --key=server.key \
  --dry-run=client -o yaml | kubectl -n "$NS" apply -f -
# CNPG-style: include ca.crt in the server secret so the operator can wire peer verification.
kubectl -n "$NS" patch secret nova-bus-server-tls --type merge \
  -p "{\"data\":{\"ca.crt\":\"$(base64 < ca.crt | tr -d '\n')\"}}"
kubectl -n "$NS" create secret tls novamail-amqp-client --cert=client.crt --key=client.key \
  --dry-run=client -o yaml | kubectl -n "$NS" apply -f -
echo "AMQP TLS secrets created in ${NS}."
