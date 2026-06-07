#!/usr/bin/env bash
# Build the novamail-rabbitmq-keda secret KEDA uses to read the relay.work.q
# depth via RabbitMQ's HTTP management API. It derives the broker credentials
# from the existing AMQP_URL (the operator generates them) and points at the
# management-TLS port (15671) by FQDN so KEDA (in the keda namespace) can resolve
# it.
#
#   ./gen-keda-secret.sh [namespace]
set -euo pipefail
NS="${1:-novamail}"

AMQP="$(kubectl -n "$NS" get secret novamail-rabbitmq -o jsonpath='{.data.AMQP_URL}' | base64 -d)"
creds="$(printf '%s' "$AMQP" | sed -E 's#^amqps?://([^@]+)@.*#\1#')"   # user:pass
host="https://${creds}@nova-bus.${NS}.svc.cluster.local:15671"

kubectl -n "$NS" create secret generic novamail-rabbitmq-keda \
  --from-literal=host="$host" --dry-run=client -o yaml | kubectl -n "$NS" apply -f -
echo "novamail-rabbitmq-keda created (HTTP management host for the KEDA scaler)."
