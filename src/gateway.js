// Adapter boundary. A real implementation calls the provider with an idempotency key.
function createGateway(client) {
  return {
    async createPayout({ withdrawalId, bankAccount, amountPaise }) {
      return client.createPayout({
        account: bankAccount,
        amount: amountPaise,
        idempotencyKey: withdrawalId
      });
    }
  };
}

module.exports = { createGateway };
