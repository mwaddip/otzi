import type { Request } from 'express';
import { consumeChallenge } from './auth.js';
import { verifyBitcoinMessage, isValidSignInAddress } from './btc-message.js';
import { verifyPasskeyRegistration, type RegistrationResponseJSON } from './passkey.js';
import type { Credential } from './users.js';

export type CredentialProof =
  | { type: 'passkey'; response: RegistrationResponseJSON }
  | { type: 'bitcoin'; address: string; challenge: string; signature: string };

/** Verify a Bitcoin sign-in signature over a server-issued challenge. Throws on failure. */
export function verifyBitcoinProof(address: unknown, challenge: unknown, signature: unknown): Credential {
  if (typeof address !== 'string' || typeof challenge !== 'string' || typeof signature !== 'string') {
    throw new Error('address, challenge and signature required');
  }
  const addr = address.trim();
  if (!isValidSignInAddress(addr)) throw new Error('Invalid Bitcoin address');
  const stored = consumeChallenge(challenge, 'bitcoin');
  if (!stored?.message) throw new Error('Invalid or expired challenge');
  if (!verifyBitcoinMessage(addr, stored.message, signature)) throw new Error('Signature verification failed');
  return { type: 'bitcoin', address: addr };
}

/** Verify proof of a new credential (passkey registration or signed Bitcoin challenge). */
export async function verifyCredentialProof(req: Request, proof: unknown): Promise<Credential> {
  if (!proof || typeof proof !== 'object') throw new Error('credential required');
  const p = proof as Partial<CredentialProof> & Record<string, unknown>;
  if (p.type === 'passkey') return verifyPasskeyRegistration(req, p.response as RegistrationResponseJSON);
  if (p.type === 'bitcoin') return verifyBitcoinProof(p.address, p.challenge, p.signature);
  throw new Error('credential.type must be "passkey" or "bitcoin"');
}
