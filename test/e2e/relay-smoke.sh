#!/usr/bin/env bash
# End-to-end relay smoke test: submit a message over SMTP (submission/587 with
# STARTTLS + AUTH) and assert it is accepted, queued, and relayed upstream —
# exercising ingress → RabbitMQ → delivery → provider end to end.
#
# Designed to run from a machine with kubectl access to the novamail namespace
# (e.g. the CI deploy job, in-cluster). It submits from an ephemeral pod and
# verifies the final message status in Postgres.
#
#   NS=novamail SMTP_USER=relaytest SMTP_PASS=relaypass ./relay-smoke.sh
#
# Exit codes: 0 relayed · 1 not relayed/timeout · 2 missing prerequisites (skip).
set -euo pipefail
NS="${NS:-novamail}"
SMTP_USER="${SMTP_USER:-relaytest}"
SMTP_PASS="${SMTP_PASS:-relaypass}"
FROM="${FROM:-alice@example.com}"
TO="${TO:-bob@downstream.test}"
TIMEOUT="${TIMEOUT:-90}"
SUBJECT="e2e-smoke-$(date +%s)-$RANDOM"

kc() { kubectl -n "$NS" "$@"; }

# Prerequisite: a test account must exist (else skip rather than fail the deploy).
if ! kc get secret novamail-pg-app >/dev/null 2>&1; then
  echo "SKIP: not connected to a novamail cluster"; exit 2
fi
PGPASS="$(kc get secret novamail-pg-app -o jsonpath='{.data.password}' | base64 -d)"
# Find any CNPG pod; query the primary through the -rw service (survives failover).
PGPOD="$(kc get pods -l cnpg.io/cluster=novamail-pg -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)"
psql_q() { kc exec "$PGPOD" -- env PGPASSWORD="$PGPASS" psql -h novamail-pg-rw -U novamail -d novamail -tAc "$1" 2>/dev/null | tr -d '[:space:]'; }
if [ -z "$PGPOD" ]; then echo "SKIP: no Postgres pod found"; exit 2; fi
if [ "$(psql_q "select 1 from accounts where username='${SMTP_USER}' and enabled")" != "1" ]; then
  echo "SKIP: test account '${SMTP_USER}' not present"; exit 2
fi

echo "submitting '${SUBJECT}' as ${SMTP_USER} (${FROM} -> ${TO})"
# Pass values to Python via the environment (os.environ) rather than interpolating
# them into the source — so a credential containing a quote can't break the script.
kc run e2e-submit-$RANDOM --rm -i --restart=Never --image=python:3.12-alpine \
  --env="SMTP_USER=$SMTP_USER" --env="SMTP_PASS=$SMTP_PASS" --env="FROM=$FROM" \
  --env="TO=$TO" --env="SUBJECT=$SUBJECT" --command -- \
  python3 -c '
import os, smtplib, ssl
from email.message import EmailMessage
ctx = ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
s = smtplib.SMTP("novamail-ingress", 587, timeout=20); s.starttls(context=ctx)
s.login(os.environ["SMTP_USER"], os.environ["SMTP_PASS"])
m = EmailMessage(); m["From"]=os.environ["FROM"]; m["To"]=os.environ["TO"]; m["Subject"]=os.environ["SUBJECT"]
m.set_content("novamail e2e smoke")
s.send_message(m); s.quit(); print("submitted")
' 2>&1 | grep -vE 'pod .* deleted|recorded' || { echo "FAIL: submission error"; exit 1; }

echo "polling for relayed status (timeout ${TIMEOUT}s)..."
deadline=$(( $(date +%s) + TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  status="$(psql_q "select status from messages where subject='${SUBJECT}' order by created_at desc limit 1")"
  case "$status" in
    relayed) echo "PASS: message relayed"; exit 0 ;;
    bounced|failed) echo "FAIL: message ${status}"; exit 1 ;;
  esac
  sleep 3
done
echo "FAIL: not relayed within ${TIMEOUT}s (last status: ${status:-none})"; exit 1
