import { isValidAddress } from './bitcoin.js';
import type { AddressBookEntry, NetworkName } from './types.js';

export const MAX_ENTRIES = 1000;
export const MAX_LABEL = 64;
export const MAX_NOTE = 256;

/** Validate and normalize address book entries. Throws with the first offending entry. */
export function validateAddressBook(input: unknown, network: NetworkName): AddressBookEntry[] {
  if (!Array.isArray(input)) throw new Error('entries must be an array');
  if (input.length > MAX_ENTRIES) throw new Error(`at most ${MAX_ENTRIES} entries`);

  const seen = new Set<string>();
  return input.map((raw, i) => {
    const fail = (reason: string): never => { throw new Error(`entry ${i}: ${reason}`); };
    if (!raw || typeof raw !== 'object') fail('must be an object');
    const e = raw as Record<string, unknown>;

    const label = typeof e.label === 'string' ? e.label.trim() : '';
    if (!label) fail('label required');
    if (label.length > MAX_LABEL) fail(`label longer than ${MAX_LABEL} characters`);

    const address = typeof e.address === 'string' ? e.address.trim() : '';
    if (!isValidAddress(address, network)) fail(`invalid ${network} address`);
    if (seen.has(address)) fail('duplicate address');
    seen.add(address);

    let note: string | undefined;
    if (e.note !== undefined) {
      if (typeof e.note !== 'string') fail('note must be a string');
      note = (e.note as string).trim();
      if (note.length > MAX_NOTE) fail(`note longer than ${MAX_NOTE} characters`);
    }

    return note ? { label, address, note } : { label, address };
  });
}
