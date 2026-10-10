import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionFingerprint } from './relay-crypto';

test('session fingerprint is 96 bits in six groups and depends on every key and its slot', async () => {
  const k = (b: number) => new Uint8Array(65).fill(b);
  const fp = await sessionFingerprint(new Map([[0, k(1)], [1, k(2)], [2, k(3)]]));
  assert.match(fp, /^[0-9a-f]{4}(-[0-9a-f]{4}){5}$/);
  assert.equal(fp, await sessionFingerprint(new Map([[2, k(3)], [0, k(1)], [1, k(2)]])));
  assert.notEqual(fp, await sessionFingerprint(new Map([[0, k(1)], [1, k(2)], [2, k(4)]])));
  assert.notEqual(fp, await sessionFingerprint(new Map([[0, k(2)], [1, k(1)], [2, k(3)]])));
});
