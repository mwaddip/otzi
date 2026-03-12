/**
 * PERMAFROST share file decryption + V2 deserialization.
 * Mirrors ceremony/src/lib/crypto.ts decrypt() and serialize.ts deserialize().
 */

import type { ThresholdKeyShare, SecretShare } from '@btc-vision/post-quantum/threshold-ml-dsa.js';

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

function buf(arr: Uint8Array): ArrayBuffer {
  return new Uint8Array(arr).buffer as ArrayBuffer;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: buf(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function decrypt(encoded: string, password: string): Promise<Uint8Array> {
  const combined = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  const salt = combined.slice(0, SALT_BYTES);
  const iv = combined.slice(SALT_BYTES, SALT_BYTES + IV_BYTES);
  const ciphertext = combined.slice(SALT_BYTES + IV_BYTES);
  const key = await deriveKey(password, salt);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: buf(iv) },
    key,
    buf(ciphertext),
  );
  return new Uint8Array(plaintext);
}

// ---------------------------------------------------------------------------
// V2 binary deserialization (from ceremony/src/lib/serialize.ts)
// ---------------------------------------------------------------------------

const SERIALIZE_VERSION = 0x02;
const N_COEFFS = 256;
const BITS_PER_COEFF = 23;
const POLY_BYTES = Math.ceil((N_COEFFS * BITS_PER_COEFF) / 8); // 736

/** Unpack 736 bytes into a polynomial of 256 coefficients mod Q. */
function unpackPoly(data: Uint8Array, offset: number): Int32Array {
  const coeffs = new Int32Array(N_COEFFS);
  const mask = (1 << BITS_PER_COEFF) - 1; // 0x7FFFFF
  let bitPos = 0;
  for (let i = 0; i < N_COEFFS; i++) {
    const byteIdx = (bitPos >>> 3) + offset;
    const bitOff = bitPos & 7;
    const b0 = data[byteIdx] ?? 0;
    const b1 = data[byteIdx + 1] ?? 0;
    const b2 = data[byteIdx + 2] ?? 0;
    const b3 = data[byteIdx + 3] ?? 0;
    let val = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> bitOff;
    val &= mask;
    coeffs[i] = val;
    bitPos += BITS_PER_COEFF;
  }
  return coeffs;
}

/** Deserialize a V2 binary blob back into a ThresholdKeyShare. */
function deserializeKeyShare(bytes: Uint8Array): {
  share: ThresholdKeyShare;
  K: number;
  L: number;
} {
  let pos = 0;

  const version = bytes[pos++]!;
  if (version !== SERIALIZE_VERSION) {
    throw new Error(`Unknown share version: ${version}`);
  }

  const id = bytes[pos++]!;
  const K = bytes[pos++]!;
  const L = bytes[pos++]!;

  const rho = bytes.slice(pos, pos + 32); pos += 32;
  const key = bytes.slice(pos, pos + 32); pos += 32;
  const tr = bytes.slice(pos, pos + 64); pos += 64;

  const numShares = bytes[pos]! | (bytes[pos + 1]! << 8);
  pos += 2;

  const shares = new Map<number, SecretShare>();

  for (let n = 0; n < numShares; n++) {
    const bitmask = bytes[pos]! | (bytes[pos + 1]! << 8);
    pos += 2;

    const s1: Int32Array[] = [];
    for (let i = 0; i < L; i++) {
      s1.push(unpackPoly(bytes, pos));
      pos += POLY_BYTES;
    }

    const s2: Int32Array[] = [];
    for (let i = 0; i < K; i++) {
      s2.push(unpackPoly(bytes, pos));
      pos += POLY_BYTES;
    }

    const s1Hat: Int32Array[] = [];
    for (let i = 0; i < L; i++) {
      s1Hat.push(unpackPoly(bytes, pos));
      pos += POLY_BYTES;
    }

    const s2Hat: Int32Array[] = [];
    for (let i = 0; i < K; i++) {
      s2Hat.push(unpackPoly(bytes, pos));
      pos += POLY_BYTES;
    }

    shares.set(bitmask, { s1, s2, s1Hat, s2Hat });
  }

  return {
    share: { id, rho, key, tr, shares },
    K,
    L,
  };
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Parsed share file (JSON on disk). */
export interface ShareFile {
  version: number;
  publicKey: string;
  partyId: number;
  threshold: number;
  parties: number;
  level: number;
  encrypted: string;
}

/** Decrypted share ready for signing. */
export interface DecryptedShare {
  publicKey: string;
  partyId: number;
  threshold: number;
  parties: number;
  level: number;
  shareBytes: Uint8Array;
  keyShare: ThresholdKeyShare;
  K: number;
  L: number;
}

/** Parse and decrypt a share file. Throws on wrong password. */
export async function decryptShareFile(
  file: ShareFile,
  password: string,
): Promise<DecryptedShare> {
  const shareBytes = await decrypt(file.encrypted, password);
  const { share: keyShare, K, L } = deserializeKeyShare(shareBytes);
  return {
    publicKey: file.publicKey,
    partyId: file.partyId,
    threshold: file.threshold,
    parties: file.parties,
    level: file.level,
    shareBytes,
    keyShare,
    K,
    L,
  };
}
