# Part 1 — payout review

## Problems, ordered by severity

1. **Non-atomic check then debit (critical).** Two withdrawals can both read the same balance, each pass `>=`, and overwrite one another or both trigger payouts. A user with ₹100 submits two ₹100 requests concurrently; both are paid. Use a transaction plus a conditional `$inc` (`balance >= amount`) as the debit decision.
2. **No idempotency (critical).** The mobile client retries a timeout after the first request has debited or called the gateway, creating another payout. Require a client idempotency key, unique per user, persist its request hash and return the original result.
3. **Gateway call is not awaited (critical).** `try/catch` only catches synchronous throws; rejection is unhandled and a failed payout is still ledgered/reported successful. Await it, persist a payout state, and retry through an outbox with the gateway idempotency key.
4. **Debit, gateway call, and ledger are not one recoverable workflow (critical).** A process crash after any step produces debit-without-ledger, gateway-without-ledger, or unknown payout state. Atomically reserve funds and write ledger/outbox in Mongo; submit from the outbox and reconcile gateway webhooks/statuses. Never blindly refund an unknown gateway result.
5. **No authorization / trusting body `userId` (critical).** Any authenticated caller can withdraw another user's wallet if IDs are guessable or leaked. Derive user ID from verified auth; authorize privileged support flows separately.
6. **Unsafe money representation and validation (high).** `amount * 1.0`, absent type/range/positive checks, and JavaScript numbers permit floats, NaN, negatives, and precision errors. Store and accept integer minor units (`amountPaise`) with safe-integer limits.
7. **No stable gateway idempotency reference (high).** `Date.now()` can collide and is regenerated on retry; provider retries may double pay. Use the persisted withdrawal ID as provider idempotency key and store provider payout ID.
8. **No transaction / error handling around writes (high).** A failed update/insert can leave inconsistent state; gateway errors are swallowed. Use majority-backed transaction, explicit state transitions, alerts, and a dead-letter/reconciliation path.
9. **Balance update can overwrite unrelated changes (high).** Writing a computed `newBalance` loses concurrent credits/debits. Use `$inc` with a balance predicate; never set a stale calculated balance.
10. **Ledger is mutable/ambiguous and may disagree with wallet (medium).** It lacks withdrawal ID, gateway status, idempotency key, currency, and immutable correlation. Use append-only entries with signed integer amount, balance-after, withdrawal ID, request ID, timestamps.
11. **Unbounded history query and missing index (medium).** A 40M-document collection with only `_id` makes the request slow and returns all user history. Create `{userId: 1, createdAt: -1}`, paginate with a limit/cursor, and do not return history from a write endpoint.
12. **No wallet index (medium).** `findOne({userId})` scans ~2M documents without an index. Create unique `{userId: 1}`.
13. **Weak bank-account and account-state checks (medium).** Missing/closed/unverified bank accounts are sent to the provider. Require a verified, active payout instrument and apply risk/KYC/withdrawal-limit policy.
14. **Observability/audit gaps (medium).** Console logging lacks correlation IDs, status transitions, metrics, and alerting. Emit structured logs and counters for reserve, submit, provider errors, pending age, retries, and reconciliation differences; redact account data.
15. **No rate limits, limits, or fraud controls (medium).** A compromised account can drain funds in many requests. Add authenticated rate limits, daily limits, velocity/risk checks, and a manual review state.

## Shipped rewrite

See [`src/withdraw.js`](../src/withdraw.js). It validates integer money and trusted identity, atomically reserves money, writes an immutable ledger entry and transactional outbox, handles idempotency, and records structured errors. The immediate gateway attempt is optional; the outbox worker is the reliable path.

## Overall design

I would model withdrawals as a durable state machine (`pending_gateway`, `submitted`, `paid`, `failed/reversed`) with an immutable double-entry-style ledger and a separate available/reserved balance. A transactional outbox and idempotent gateway adapter would make external side effects retryable, while webhooks plus scheduled reconciliation determine final settlement. I would add KYC/instrument verification, limits and risk checks before reservation, plus a finance reconciliation dashboard and alerts for aged pending withdrawals. Mongo transactions require a replica set, majority write concern, and tested failure recovery.
