import { createRequire } from 'node:module';
import { createMetadataAuth } from './metadata-auth.mjs';
const require = createRequire(import.meta.url);
// Use the SDK's published CJS entry: it is also supported by Node.js 22.
const sdk = require('ydb-sdk');
const silentLogger = Object.fromEntries(['fatal', 'error', 'warn', 'info', 'debug', 'trace'].map((key) => [key, () => {}]));

export function createYdbTransactions({ driver, table = 'demo_chat_state', library = sdk }) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(table)) throw new Error('Invalid quota table name.');
  const { TypedValues, TypedData, Types, YdbError, StatusCode, OperationParams, ExecuteQuerySettings, BeginTransactionSettings, CommitTransactionSettings, RollbackTransactionSettings } = library;
  const settings = (Type) => new Type().withOperationParams(new OperationParams().withOperationTimeoutSeconds(2).withCancelAfterSeconds(2));
  return {
    async transaction(work) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          // Never put provider/network calls inside this retryable callback.
          return await driver.tableClient.withSession(async (session) => {
            const transaction = await session.beginTransaction({ serializableReadWrite: {} }, settings(BeginTransactionSettings));
            if (!transaction.id) throw new Error('No transaction ID.');
            const txControl = { txId: transaction.id };
            const tx = {
              async get(keys) {
                const query = `DECLARE $keys AS List<Utf8>; SELECT key, value, expires_at AS expires FROM \`${table}\` WHERE key IN $keys;`;
                const result = await session.executeQuery(query, { $keys: TypedValues.list(Types.UTF8, keys) }, txControl, settings(ExecuteQuerySettings));
                const rows = TypedData.createNativeObjects(result.resultSets[0]);
                return new Map(rows.map((row) => {
                  const expiresAt = new Date(row.expires).getTime();
                  if (typeof row.key !== 'string' || typeof row.value !== 'string' || !Number.isFinite(expiresAt)) throw new Error('Invalid quota storage row.');
                  return [row.key, { key: row.key, value: JSON.parse(row.value), expiresAt }];
                }));
              },
              async put(rows) {
                const declarations = []; const values = []; const params = {};
                rows.forEach((row, i) => {
                  declarations.push(`DECLARE $k${i} AS Utf8; DECLARE $v${i} AS Utf8; DECLARE $e${i} AS Timestamp;`);
                  values.push(`($k${i}, $v${i}, $e${i})`);
                  params[`$k${i}`] = TypedValues.utf8(row.key);
                  params[`$v${i}`] = TypedValues.utf8(JSON.stringify(row.value));
                  params[`$e${i}`] = TypedValues.timestamp(new Date(row.expiresAt));
                });
                await session.executeQuery(`${declarations.join('\n')} UPSERT INTO \`${table}\` (key, value, expires_at) VALUES ${values.join(', ')};`, params, txControl, settings(ExecuteQuerySettings));
              },
            };
            try {
              const result = await work(tx);
              await session.commitTransaction(txControl, settings(CommitTransactionSettings));
              return result;
            } catch (error) {
              try { await session.rollbackTransaction(txControl, settings(RollbackTransactionSettings)); } catch { /* Retain original failure. */ }
              throw error;
            }
          }, 2500);
        } catch (error) {
          // Only an explicit aborted transaction is known not to have committed.
          // Ambiguous transport/commit errors fail closed instead of replaying.
          if (!(error instanceof YdbError && error.constructor.status === StatusCode.ABORTED) || attempt === 3) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
        }
      }
      throw new Error('Transaction retry exhausted.');
    },
  };
}

export async function connectYdb(config) {
  if (!config.endpoint.startsWith('grpcs://') || !config.database.startsWith('/')) throw new Error('Invalid YDB endpoint.');
  const driver = new sdk.Driver({ endpoint: config.endpoint, database: config.database, authService: createMetadataAuth(), logger: silentLogger, poolSettings: { minLimit: 0, maxLimit: 3 } });
  if (!await driver.ready(5000)) { await driver.destroy(); throw new Error('Quota database unavailable.'); }
  return createYdbTransactions({ driver, table: config.table });
}
