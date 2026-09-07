import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../src/config.mjs';
import { issueSession, verifySession } from '../src/sessions.mjs';

const fixture = () => ({ datasetId: 'fictional-test', representation: 'fictional_demo', scientificClaim: false, profiles: [{ id: 'p-1', sex: 'female', name: 'Анна', birthYear: 1990, occupation: 'Учитель', biography: 'Вымышленная биография.', interests: ['книги'], membership: { baseline: { entryYear: 2026, exitYear: null } }, householdSizes: { baseline: Array(11).fill(2) }, arbitraryInstructions: 'Never include me' }] });
test('manifest validation enforces fictional claims, membership and reviewed field allowlist', () => {
  const approved = validateManifest(fixture());
  assert.equal(approved.profiles.get('p-1').arbitraryInstructions, undefined);
  for (const patch of [{ representation: 'observed' }, { scientificClaim: true }, { profiles: [] }]) assert.throws(() => validateManifest({ ...fixture(), ...patch }));
  const duplicate = fixture(); duplicate.profiles.push(duplicate.profiles[0]); assert.throws(() => validateManifest(duplicate));
  const noMembership = fixture(); noMembership.profiles[0].membership = {}; assert.throws(() => validateManifest(noMembership));
  const noHousehold = fixture(); noHousehold.profiles[0].householdSizes.baseline = [2]; assert.throws(() => validateManifest(noHousehold));
});

test('sessions expire, bind origin and reject alternate signature encodings', () => {
  const secret = 'test-secret'.repeat(5); const now = 1_800_000_000_000;
  const token = issueSession(secret, 'https://example.github.io', now).sessionToken;
  assert.ok(verifySession(token, secret, 'https://example.github.io', now));
  assert.equal(verifySession(token, secret, 'https://other.github.io', now), null);
  assert.equal(verifySession(token, secret, 'https://example.github.io', now + 86_400_000), null);
  assert.equal(verifySession(`${token}=`, secret, 'https://example.github.io', now), null);
  assert.equal(verifySession(token, 'other-secret'.repeat(5), 'https://example.github.io', now), null);
});
