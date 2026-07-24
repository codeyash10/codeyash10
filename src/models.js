const { MongoClient } = require('mongodb');

async function connect(uri) {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const collections = {
    users: db.collection('users'), wallets: db.collection('wallets'),
    withdrawals: db.collection('withdrawals'), ledger: db.collection('ledger'),
    outbox: db.collection('outbox')
  };
  await Promise.all([
    collections.wallets.createIndex({ userId: 1 }, { unique: true }),
    collections.withdrawals.createIndex({ userId: 1, idempotencyKey: 1 }, { unique: true }),
    collections.ledger.createIndex({ userId: 1, createdAt: -1 }),
    collections.outbox.createIndex({ status: 1, availableAt: 1 })
  ]);
  return { client, collections };
}

module.exports = { connect };
