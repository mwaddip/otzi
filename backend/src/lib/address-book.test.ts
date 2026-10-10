import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAddressBook } from './address-book.js';

const A = 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297';
const B = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

test('valid entries are trimmed and empty notes dropped', () => {
  const out = validateAddressBook([
    { label: '  Cold storage ', address: ` ${A}` },
    { label: 'Exchange', address: B, note: '  ' },
    { label: 'Exchange 2', address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', note: ' monthly ' },
  ], 'mainnet');
  assert.deepEqual(out, [
    { label: 'Cold storage', address: A },
    { label: 'Exchange', address: B },
    { label: 'Exchange 2', address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', note: 'monthly' },
  ]);
});

test('invalid entries are rejected with their index', () => {
  assert.throws(() => validateAddressBook('x', 'mainnet'), /array/);
  assert.throws(() => validateAddressBook([{ label: '', address: A }], 'mainnet'), /entry 0: label/);
  assert.throws(() => validateAddressBook([{ label: 'x'.repeat(65), address: A }], 'mainnet'), /entry 0: label longer/);
  assert.throws(() => validateAddressBook([{ label: 'a', address: A }, { label: 'b', address: A }], 'mainnet'), /entry 1: duplicate/);
  assert.throws(() => validateAddressBook([{ label: 'a', address: A }], 'signet'), /entry 0: invalid signet address/);
  assert.throws(() => validateAddressBook([{ label: 'a', address: A, note: 5 }], 'mainnet'), /note must be a string/);
});
