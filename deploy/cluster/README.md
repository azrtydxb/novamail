# Cluster bootstrap (kw)

One-time platform setup the Helm release depends on. Apply in this order.

## 1. RBAC for the CI deployer
```
kubectl apply -f bootstrap-rbac.yaml
```
Lets the ARC runner ServiceAccount `helm upgrade --install` into the `novamail`
namespace (deployments, services, PVCs, secrets, ingresses, servicemonitors,
cert-manager Certificates).

## 2. Dependencies (`deps/`)
Postgres + the 3-node RabbitMQ cluster + the Mailpit test sink.

```
# HA Postgres via the CloudNativePG operator (1 primary + 2 replicas, quorum
# synchronous replication, automatic failover). Create the app-user secret first
# (novamail-pg-app: basic-auth username/password), then the Cluster:
kubectl apply --server-side -f https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.29/releases/cnpg-1.29.1.yaml
kubectl -n novamail create secret generic novamail-pg-app --type=kubernetes.io/basic-auth \
  --from-literal=username=novamail --from-literal=password=<pw>
kubectl apply -f deps/postgres-cnpg.yaml         # Cluster novamail-pg → services novamail-pg-{rw,ro,r}
# (deps/postgres.yaml is the retired single-node StatefulSet, kept for reference only)

# 3-node RabbitMQ via the RabbitMQ Cluster Operator:
kubectl apply -f https://github.com/rabbitmq/cluster-operator/releases/latest/download/cluster-operator.yml
kubectl apply -f deps/rabbitmq-cluster.yaml      # RabbitmqCluster nova-bus (3 replicas, quorum default)
kubectl apply -f deps/mailpit.yaml               # test upstream only
```

### Credentials (out-of-band; never committed)
```
# Postgres
kubectl -n novamail create secret generic novamail-postgres \
  --from-literal=POSTGRES_USER=novamail --from-literal=POSTGRES_PASSWORD=<pw> \
  --from-literal=POSTGRES_DB=novamail \
  --from-literal=DSN='postgres://novamail:<pw>@novamail-pg-rw:5432/novamail?sslmode=verify-full&sslrootcert=/etc/novamail/pgtls/ca.crt&sslcert=/etc/novamail/pgtls/tls.crt&sslkey=/etc/novamail/pgtls/tls.key'
# (DSN host is the CloudNativePG -rw service, which always points at the current primary)

# Bus: the operator creates nova-bus-default-user; expose it to the apps as AMQP_URL
NBU=$(kubectl -n novamail get secret nova-bus-default-user -o jsonpath='{.data.username}' | base64 -d)
NBP=$(kubectl -n novamail get secret nova-bus-default-user -o jsonpath='{.data.password}' | base64 -d)
kubectl -n novamail create secret generic novamail-rabbitmq \
  --from-literal=AMQP_URL="amqp://$NBU:$NBP@nova-bus:5672/"
```

DKIM signing keys are created and managed in the GUI (DKIM keys page) — they live
envelope-encrypted in the `dkim_keys`/`secrets` tables, not in a mounted Secret.
This requires the envelope-encryption KEK (`NOVAMAIL_SECRET_KEY`, provisioned via
the `secretKeySecret` Secret / Helm `secretKeySecret`): the Admin API needs it to
encrypt keys and delivery needs it to decrypt and sign. Without the KEK, outbound
mail is **not** DKIM-signed (delivery logs a warning).

The SMTP server TLS cert (`novamail-smtp-tls`) is issued by cert-manager via the
Helm chart's `Certificate`.

## 3. Migrations
Applied by the one-shot Job (runs every `migrations/*.sql` in order):
```
kubectl -n novamail create configmap novamail-migrations --from-file=../../migrations
kubectl apply -f deps/migrate-job.yaml
```


## Postgres mutual TLS

The data plane + admin-api connect with `sslmode=verify-full` and a client
certificate (the chart mounts the CNPG CA + `novamail-pg-client` at
`/etc/novamail/pgtls`). To (re)issue the client cert:

```sh
./deps/gen-pg-client-cert.sh novamail
```

To require client certs server-side (full mutual TLS enforcement), set the
CNPG pg_hba so app connections must present a CA-signed cert — run AFTER all
pods mount the cert (else live connections break):

```sh
kubectl -n novamail patch cluster novamail-pg --type merge -p \
  '{"spec":{"postgresql":{"pg_hba":["hostssl all all all scram-sha-256 clientcert=verify-ca"]}}}'
```


## RabbitMQ mutual TLS

Provision the bus CA + server/client certs, then point the operator at them:

```sh
./deps/gen-amqp-certs.sh novamail
kubectl -n novamail apply -f deps/rabbitmq-cluster.yaml   # adds spec.tls (AMQPS on 5671)
```

The chart mounts the CA + `novamail-amqp-client` at `/etc/novamail/amqptls`. Activate by flipping AMQP_URL to amqps (port 5671) — services then dial with the client cert (mutual TLS):

```sh
kubectl -n novamail patch secret novamail-rabbitmq --type merge \
  -p "{\"data\":{\"AMQP_URL\":\"$(printf 'amqps://USER:PASS@nova-bus:5671/' | base64)\"}}"
kubectl -n novamail rollout restart deploy/novamail-ingress deploy/novamail-delivery deploy/novamail-dsn deploy/novamail-admin-api
```

Once every client uses amqps, set `disableNonTLSListeners: true` to close 5672.
