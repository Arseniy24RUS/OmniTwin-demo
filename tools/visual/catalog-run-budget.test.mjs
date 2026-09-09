import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCatalogRunBudget, CITY_CATALOG_OUTPUT_BUDGET_BYTES } from './catalog-run-budget.mjs';

test('complete city run requires output budget plus working space before compiling',()=>{
  assert.throws(()=>assertCatalogRunBudget({availableBytes:20*1024**3}),/free space/);
  assert.deepEqual(assertCatalogRunBudget({availableBytes:24*1024**3}),{outputBudgetBytes:CITY_CATALOG_OUTPUT_BUDGET_BYTES,workingReserveBytes:2*1024**3,availableBytes:24*1024**3});
});
test('output and existing bytes cannot silently enlarge the declared disk budget',()=>{
  assert.throws(()=>assertCatalogRunBudget({availableBytes:100*1024**3,outputBudgetBytes:21*1024**3}),/budget/);
  assert.throws(()=>assertCatalogRunBudget({availableBytes:100*1024**3,outputBudgetBytes:NaN}),/budget/);
  assert.throws(()=>assertCatalogRunBudget({availableBytes:-1}),/available/);
});
