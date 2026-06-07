#!/usr/bin/env bash
# Internal relay load test: ramp email volume through the relay and watch KEDA
# scale the delivery workers on the relay.work.q backlog, then report the
# throughput ceiling. Everything stays in-cluster (mail exits to Mailpit; the
# relay never does direct-to-MX).
#
#   TOTAL=5000 CONCURRENCY=60 ./run-loadtest.sh
#
# Requires kubectl access to the novamail namespace.
set -euo pipefail
NS="${NS:-novamail}"
TOTAL="${TOTAL:-3000}"
CONCURRENCY="${CONCURRENCY:-40}"
SAMPLE="${SAMPLE:-5}"          # seconds between samples
MAX_SAMPLES="${MAX_SAMPLES:-90}"
kc() { kubectl -n "$NS" "$@"; }

PGPOD="$(kc get pods -l cnpg.io/cluster=novamail-pg -o jsonpath='{.items[0].metadata.name}')"
RMQPOD="$(kc get pods -l app.kubernetes.io/name=nova-bus -o jsonpath='{.items[0].metadata.name}')"
PGPASS_ARGS=(env) # postgres superuser via local socket (peer auth), no password

relayed_count() { kc exec "$PGPOD" -- psql -U postgres -d novamail -tAc \
  "select count(*) from messages where status='relayed'" 2>/dev/null | tr -d '[:space:]'; }
queue_depth() { kc exec "$RMQPOD" -- rabbitmqctl list_queues name messages 2>/dev/null \
  | awk '$1=="relay.work.q"{print $2}'; }
delivery_replicas() { kc get deploy novamail-delivery -o jsonpath='{.status.readyReplicas}' 2>/dev/null; }

echo "=== NovaMail internal load test: TOTAL=$TOTAL CONCURRENCY=$CONCURRENCY ==="
echo "baseline: relayed=$(relayed_count) delivery_replicas=$(delivery_replicas) queue=$(queue_depth)"

# Ship the generator as a ConfigMap + Job.
kc delete job nm-loadgen --ignore-not-found >/dev/null 2>&1
kc create configmap nm-loadgen-src --from-file=loadsend.py="$(dirname "$0")/loadsend.py" \
  --dry-run=client -o yaml | kc apply -f - >/dev/null
cat <<YAML | kc apply -f - >/dev/null
apiVersion: batch/v1
kind: Job
metadata: { name: nm-loadgen }
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: loadgen
          image: python:3.12-alpine
          command: ["python3", "/src/loadsend.py"]
          env:
            - { name: TOTAL, value: "$TOTAL" }
            - { name: CONCURRENCY, value: "$CONCURRENCY" }
          volumeMounts: [{ name: src, mountPath: /src }]
      volumes: [{ name: src, configMap: { name: nm-loadgen-src } }]
YAML

base_relayed="$(relayed_count)"; t0=$(date +%s)
prev_relayed="$base_relayed"; prev_t=$t0
peak_q=0; peak_reps=0; peak_rate=0
printf "\n%-6s %-9s %-9s %-12s %s\n" "t(s)" "queue" "replicas" "relayed/s" "total_relayed"
for i in $(seq 1 "$MAX_SAMPLES"); do
  sleep "$SAMPLE"
  now=$(date +%s); el=$((now - t0))
  q="$(queue_depth)"; q="${q:-0}"
  reps="$(delivery_replicas)"; reps="${reps:-0}"
  rel="$(relayed_count)"; rel="${rel:-$prev_relayed}"
  dt=$((now - prev_t)); [ "$dt" -lt 1 ] && dt=1
  rate=$(( (rel - prev_relayed) / dt ))
  printf "%-6s %-9s %-9s %-12s %s\n" "$el" "$q" "$reps" "$rate" "$((rel - base_relayed))"
  [ "$q" -gt "$peak_q" ] && peak_q="$q"
  [ "$reps" -gt "$peak_reps" ] && peak_reps="$reps"
  [ "$rate" -gt "$peak_rate" ] && peak_rate="$rate"
  prev_relayed="$rel"; prev_t="$now"
  # stop once the generator finished AND the backlog has drained
  jobdone="$(kc get job nm-loadgen -o jsonpath='{.status.succeeded}' 2>/dev/null)"
  if [ "${jobdone:-0}" = "1" ] && [ "$q" -le 1 ]; then echo "(backlog drained)"; break; fi
done

submit_line="$(kc logs job/nm-loadgen 2>/dev/null | grep '^DONE' || echo 'DONE (sender log unavailable)')"
mailpit="$(kc exec "$RMQPOD" -- sh -c 'true' 2>/dev/null; kc run nm-mp-$RANDOM --rm -i --restart=Never \
  --image=curlimages/curl:8.10.1 --command -- sh -c 'curl -s http://novamail-mailpit:8025/api/v1/messages?limit=1' 2>/dev/null \
  | grep -oE "\"total\":[0-9]+" | head -1 || true)"

echo
echo "=== RESULTS ==="
echo "sender:            $submit_line"
echo "total relayed:     $(( $(relayed_count) - base_relayed ))"
echo "peak queue depth:  $peak_q"
echo "delivery scaled:   2 (min) -> $peak_reps replicas (KEDA on relay.work.q)"
echo "peak relay rate:   ${peak_rate} msg/s"
echo "mailpit received:  ${mailpit:-n/a} (internal sink — nothing left the cluster)"
kc delete job nm-loadgen --ignore-not-found >/dev/null 2>&1
kc delete configmap nm-loadgen-src --ignore-not-found >/dev/null 2>&1
