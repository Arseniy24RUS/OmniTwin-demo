// Test double only. Production always uses durable YDB transactions.
export class MemoryTransactions {
  rows = new Map();
  pending = Promise.resolve();
  async transaction(work) {
    const run = this.pending.then(async () => {
      const draft = new Map(this.rows);
      const result = await work({
        get: async (keys) => new Map(keys.filter((key) => draft.has(key)).map((key) => [key, draft.get(key)])),
        put: async (rows) => { for (const row of rows) draft.set(row.key, structuredClone(row)); },
      });
      this.rows = draft;
      return result;
    });
    this.pending = run.catch(() => {});
    return run;
  }
}
