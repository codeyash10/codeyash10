const express = require('express');
const { connect } = require('./models');
const { createWithdrawHandler } = require('./withdraw');

async function createApp({ client, collections, gateway, log = console }) {
  const app = express();
  app.use(express.json());
  // Demo only. Production middleware verifies a JWT/session and sets this trusted identity.
  app.use((req, _res, next) => { req.auth = req.get('X-User-Id') ? { userId: req.get('X-User-Id') } : undefined; next(); });
  app.post('/api/wallet/withdraw', createWithdrawHandler({ client, collections, gateway, log }));
  return app;
}

if (require.main === module) {
  (async () => {
    const { client, collections } = await connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/funngro?replicaSet=rs0');
    const app = await createApp({ client, collections, gateway: { createPayout: async () => { throw new Error('configure gateway adapter'); } } });
    app.listen(process.env.PORT || 3000, () => console.log('listening'));
  })().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { createApp };
