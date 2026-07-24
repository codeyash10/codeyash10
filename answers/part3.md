# Part 3 — first 30 minutes

**0–5 min: contain and establish scope.** Declare an incident, assign incident commander/comms/scribe, freeze deploys, and alert finance/support. I would put withdrawals behind a feature flag or return a clear temporary `503` *before* creating new reservations if I cannot establish gateway safety; I would not restart every service, drop traffic indiscriminately, or refund complaints yet because an unknown gateway request can still settle.

Check a real dashboard/time window and correlate IDs:
```bash
kubectl logs deploy/wallet-api --since=70m | jq 'select(.event|test("withdraw|payout"))'
kubectl top pods -n payments
mongosh "$MONGODB_URI" --eval 'db.currentOp({"command.aggregate":"ledger"})'
```
I inspect p50/p95/p99, timeout/5xx rate, request volume, pod CPU/memory/restarts, connection-pool wait time, Mongo operation latency/connections/CPU/IOPS/replication lag, slow-query logs, and gateway success/error/timeout latency. I sample complaints by withdrawal/request ID and compare wallet/ledger/outbox/gateway state.

**5–15 min: isolate the bottleneck and stop duplicate harm.** If gateway latency/errors rose with p95, stop synchronous submits, queue only once per idempotency key, and use gateway status lookup before retrying. If Atlas shows slow scans, inspect the profiler/explain and immediately pause the expensive history path; validate then add the required index during a safe window. If connection pools, CPU, or replica lag saturate, scale API consumers cautiously, reduce concurrency, and protect Mongo with backpressure. I check whether mobile retries lack idempotency and rate-limit/block repeats.

**15–30 min: reconcile and communicate.** Query reservations older than the incident start and join them to outbox/gateway records; classify each as not sent, provider accepted/paid, rejected, or unknown. Retry only confirmed-not-sent items using the original gateway idempotency key; escalate unknowns to provider support and keep them pending. Publish support guidance that records are being reconciled, update stakeholders every 15 minutes, and preserve logs/metrics/timeline. I would not bulk credit wallets, replay all requests, change money records by hand, or declare recovery based on latency alone; reconciliation and a falling pending/unknown count are the exit criteria.
