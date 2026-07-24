# Funngro Backend Assessment

Requires Node.js 20+ and MongoDB with replica-set support (transactions require it).

```bash
npm install
MONGODB_URI='mongodb://localhost:27017/?replicaSet=rs0' npm start
npm test
```

`POST /api/wallet/withdraw` expects an authenticated user supplied by middleware as `req.auth.userId`, an integer `amountPaise`, and an `Idempotency-Key` header. `src/app.js` contains deliberately small demo auth middleware; replace it with verified JWT/session middleware in production.

The request atomically reserves funds, writes the immutable ledger entry, and creates an outbox-backed withdrawal. The gateway call uses the withdrawal ID as its idempotency key. A failed call remains retryable rather than being marked paid or silently refunded.
