const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function requestHash(userId, amountPaise) {
  return crypto.createHash('sha256').update(`${userId}:${amountPaise}`).digest('hex');
}

function serialize(withdrawal) {
  return { withdrawalId: String(withdrawal._id), status: withdrawal.status, balancePaise: withdrawal.balanceAfterPaise };
}

function createWithdrawHandler({ client, collections, gateway, log }) {
  return async function withdraw(req, res) {
    const userId = req.auth?.userId;
    const amountPaise = req.body?.amountPaise;
    const idempotencyKey = req.get('Idempotency-Key');
    const requestId = req.get('X-Request-Id') || crypto.randomUUID();
    try {
      if (!userId) throw new HttpError(401, 'UNAUTHENTICATED', 'authentication required');
      if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new HttpError(400, 'INVALID_AMOUNT', 'amountPaise must be a positive integer');
      if (!idempotencyKey || idempotencyKey.length > 128) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'valid Idempotency-Key required');

      let result;
      const session = client.startSession();
      try {
        await session.withTransaction(async () => {
          const user = await collections.users.findOne({ _id: userId }, { session, projection: { bankAccount: 1 } });
          if (!user?.bankAccount) throw new HttpError(409, 'BANK_ACCOUNT_MISSING', 'bank account required');
          const now = new Date();
          const hash = requestHash(userId, amountPaise);
          const inserted = await collections.withdrawals.findOneAndUpdate(
            { userId, idempotencyKey },
            { $setOnInsert: { userId, idempotencyKey, requestHash: hash, amountPaise, bankAccount: user.bankAccount, status: 'reserving', createdAt: now, updatedAt: now } },
            { upsert: true, returnDocument: 'after', includeResultMetadata: true, session }
          );
          const withdrawal = inserted.value;
          if (withdrawal.requestHash !== hash) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'key was used with a different request');
          if (inserted.lastErrorObject.updatedExisting) { result = { withdrawal, duplicate: true }; return; }

          const wallet = await collections.wallets.findOneAndUpdate(
            { userId, balancePaise: { $gte: amountPaise } },
            { $inc: { balancePaise: -amountPaise }, $set: { updatedAt: now } },
            { returnDocument: 'after', session }
          );
          if (!wallet) throw new HttpError(409, 'INSUFFICIENT_BALANCE', 'insufficient balance');
          withdrawal.balanceAfterPaise = wallet.balancePaise;
          withdrawal.status = 'pending_gateway';
          await collections.withdrawals.updateOne({ _id: withdrawal._id }, { $set: { status: withdrawal.status, balanceAfterPaise: wallet.balancePaise, updatedAt: now } }, { session });
          await collections.ledger.insertOne({ userId, withdrawalId: withdrawal._id, type: 'withdrawal_reserved', amountPaise: -amountPaise, balanceAfterPaise: wallet.balancePaise, createdAt: now }, { session });
          await collections.outbox.insertOne({ type: 'PAYOUT_REQUESTED', withdrawalId: withdrawal._id, status: 'pending', availableAt: now, createdAt: now }, { session });
          result = { withdrawal, duplicate: false };
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      } finally { await session.endSession(); }

      if (result.duplicate) return res.status(200).json({ ok: true, duplicate: true, ...serialize(result.withdrawal) });

      // A worker normally consumes the transactional outbox. This immediate attempt reduces latency;
      // it is safe because the provider receives the stable withdrawal ID as its idempotency key.
      try {
        const payout = await gateway.createPayout({ withdrawalId: String(result.withdrawal._id), bankAccount: result.withdrawal.bankAccount, amountPaise });
        await collections.withdrawals.updateOne({ _id: result.withdrawal._id, status: 'pending_gateway' }, { $set: { status: 'submitted', gatewayPayoutId: payout.id, submittedAt: new Date() } });
        await collections.outbox.updateOne({ withdrawalId: result.withdrawal._id, status: 'pending' }, { $set: { status: 'sent', sentAt: new Date() } });
        result.withdrawal.status = 'submitted';
      } catch (err) {
        log.error({ event: 'payout_submit_failed', requestId, withdrawalId: String(result.withdrawal._id), err: err.message });
        // Do not debit again or call a compensating refund: the gateway outcome may be unknown.
      }
      return res.status(202).json({ ok: true, duplicate: false, ...serialize(result.withdrawal) });
    } catch (err) {
      const status = err.status || 500;
      log.error({ event: 'withdraw_failed', requestId, userId, code: err.code || 'INTERNAL', err: err.message });
      return res.status(status).json({ error: err.code || 'INTERNAL', message: status === 500 ? 'internal error' : err.message });
    }
  };
}

module.exports = { createWithdrawHandler, HttpError };
