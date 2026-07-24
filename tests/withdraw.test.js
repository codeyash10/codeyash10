const { createWithdrawHandler } = require('../src/withdraw');

function fixture({ balance = 10_000, gatewayFails = false } = {}) {
  const wallets = new Map([['u1', { userId: 'u1', balancePaise: balance }]]);
  const withdrawals = new Map(); const ledger = []; const outbox = []; let nextId = 1; let lock = Promise.resolve();
  const client = { startSession: () => ({
    async withTransaction(fn) { let release; const previous = lock; lock = new Promise(r => { release = r; }); await previous; try { return await fn(); } finally { release(); } },
    async endSession() {}
  }) };
  const collections = {
    users: { findOne: async ({ _id }) => _id === 'u1' ? { _id, bankAccount: 'bank_1' } : null },
    wallets: {
      findOneAndUpdate: async (filter, update) => {
        const wallet = wallets.get(filter.userId);
        if (!wallet || wallet.balancePaise < filter.balancePaise.$gte) return null;
        wallet.balancePaise += update.$inc.balancePaise; return { ...wallet };
      }
    },
    withdrawals: {
      findOneAndUpdate: async (filter, update) => {
        const key = `${filter.userId}:${filter.idempotencyKey}`; let value = withdrawals.get(key); const updatedExisting = !!value;
        if (!value) { value = { _id: String(nextId++), ...update.$setOnInsert }; withdrawals.set(key, value); }
        return { value: { ...value }, lastErrorObject: { updatedExisting } };
      },
      updateOne: async (filter, update) => {
        for (const value of withdrawals.values()) if (value._id === filter._id && (!filter.status || value.status === filter.status)) Object.assign(value, update.$set);
      }
    },
    ledger: { insertOne: async value => ledger.push(value) },
    outbox: { insertOne: async value => outbox.push(value), updateOne: async (_filter, update) => Object.assign(outbox[0] || {}, update.$set) }
  };
  const gateway = { createPayout: jest.fn(async () => { if (gatewayFails) throw new Error('gateway timeout'); return { id: 'pay_1' }; }) };
  const log = { error: jest.fn() };
  return { handler: createWithdrawHandler({ client, collections, gateway, log }), wallets, withdrawals, ledger, gateway };
}

async function call(handler, { amountPaise = 1_000, key = 'key-1' } = {}) {
  const req = { auth: { userId: 'u1' }, body: { amountPaise }, get: name => ({ 'Idempotency-Key': key, 'X-Request-Id': 'test' })[name] };
  const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler(req, response); return response;
}

test('successful withdrawal reserves funds, journals it, and submits once', async () => {
  const f = fixture(); const r = await call(f.handler);
  expect(r.statusCode).toBe(202); expect(r.body.status).toBe('submitted');
  expect(f.wallets.get('u1').balancePaise).toBe(9_000); expect(f.ledger).toHaveLength(1); expect(f.gateway.createPayout).toHaveBeenCalledTimes(1);
});

test('insufficient balance makes no debit or ledger entry', async () => {
  const f = fixture({ balance: 500 }); const r = await call(f.handler, { amountPaise: 1_000 });
  expect(r.statusCode).toBe(409); expect(r.body.error).toBe('INSUFFICIENT_BALANCE'); expect(f.wallets.get('u1').balancePaise).toBe(500); expect(f.ledger).toHaveLength(0);
});

test('duplicate idempotency key returns the original withdrawal without another payout', async () => {
  const f = fixture(); await call(f.handler, { key: 'same' }); const r = await call(f.handler, { key: 'same' });
  expect(r.statusCode).toBe(200); expect(r.body.duplicate).toBe(true); expect(f.wallets.get('u1').balancePaise).toBe(9_000); expect(f.gateway.createPayout).toHaveBeenCalledTimes(1);
});

test('gateway failure leaves a durable pending withdrawal for outbox retry', async () => {
  const f = fixture({ gatewayFails: true }); const r = await call(f.handler);
  expect(r.statusCode).toBe(202); expect(r.body.status).toBe('pending_gateway'); expect(f.wallets.get('u1').balancePaise).toBe(9_000); expect(f.ledger).toHaveLength(1);
});

test('concurrent requests cannot spend more than the balance', async () => {
  const f = fixture({ balance: 1_000 }); const [a, b] = await Promise.all([call(f.handler, { key: 'a' }), call(f.handler, { key: 'b' })]);
  expect([a.statusCode, b.statusCode].sort()).toEqual([202, 409]); expect(f.wallets.get('u1').balancePaise).toBe(0); expect(f.ledger).toHaveLength(1);
});
