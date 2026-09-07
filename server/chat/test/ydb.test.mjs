import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createYdbTransactions } from '../src/ydb.mjs';
const { YdbError, StatusCode, TypedValues, Types } = createRequire(import.meta.url)('ydb-sdk');

function sdkError(status) { try { YdbError.checkStatus({ status }); } catch (error) { return error; } throw new Error('No error created'); }
function setup(commitError) {
  const calls = [];
  let commits = 0;
  const session = {
    async beginTransaction(settings) { calls.push(['begin', settings]); return { id: 'transaction-1' }; },
    async executeQuery(query, params, control, settings) {
      calls.push(['execute', query, params, control, settings]);
      return { resultSets: [{ columns: [{ name: 'key', type: Types.UTF8 }, { name: 'value', type: Types.UTF8 }, { name: 'expires', type: Types.TIMESTAMP }], rows: [{ items: [TypedValues.utf8('key').value, TypedValues.utf8('{"count":1}').value, TypedValues.timestamp(new Date(1_800_000_000_000)).value] }] }] };
    },
    async commitTransaction(control) { calls.push(['commit', control]); if (commits++ === 0 && commitError) throw commitError; },
    async rollbackTransaction(control) { calls.push(['rollback', control]); },
  };
  const driver = { tableClient: { async withSession(work, timeout) { assert.equal(timeout, 2500); return work(session); } } };
  return { calls, provider: createYdbTransactions({ driver }) };
}

test('SDK adapter keeps reads and writes in one explicit serializable transaction', async () => {
  const s = setup();
  await s.provider.transaction(async (tx) => {
    assert.deepEqual((await tx.get(['key'])).get('key'), { key: 'key', value: { count: 1 }, expiresAt: 1_800_000_000_000 });
    await tx.put([{ key: 'key', value: { count: 2 }, expiresAt: 1_800_000_000_000 }]);
  });
  assert.deepEqual(s.calls[0], ['begin', { serializableReadWrite: {} }]);
  for (const call of s.calls.filter((call) => call[0] === 'execute')) { assert.deepEqual(call[3], { txId: 'transaction-1' }); assert.equal(call[4].operationParams.operationTimeout.seconds, 2); }
  assert.deepEqual(s.calls.at(-1), ['commit', { txId: 'transaction-1' }]);
  assert.equal(s.calls.some((call) => call[0] === 'rollback'), false);
});

test('explicit ABORTED retries DB work but ambiguous commit never retries', async () => {
  const conflict = setup(sdkError(StatusCode.ABORTED)); let workCount = 0;
  await conflict.provider.transaction(async () => { workCount++; });
  assert.equal(workCount, 2);
  const ambiguous = setup(sdkError(StatusCode.UNDETERMINED)); workCount = 0;
  await assert.rejects(ambiguous.provider.transaction(async () => { workCount++; }));
  assert.equal(workCount, 1);
});

test('table identifier injection cannot become YQL', () => {
  assert.throws(() => createYdbTransactions({ driver: {}, table: 'table`; DROP TABLE other;' }));
});
