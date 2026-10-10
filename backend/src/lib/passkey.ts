import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import { base64urlnopad } from '@scure/base';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { storeChallenge, consumeChallenge } from './auth.js';
import type { Credential, User, UserStore } from './users.js';

export type { RegistrationResponseJSON, AuthenticationResponseJSON };

/** Origin and RP ID of the browser page making the request. */
function requestOrigin(req: Request): { origin: string; rpId: string } {
  const origin = req.headers.origin;
  if (!origin) throw new Error('Missing Origin header');
  const url = new URL(origin);
  return { origin: url.origin, rpId: url.hostname };
}

function originMatchesRpId(origin: string, rpId: string): boolean {
  const host = new URL(origin).hostname;
  return host === rpId || host.endsWith(`.${rpId}`);
}

/** Challenge value carried in a WebAuthn response's clientDataJSON. */
function responseChallenge(clientDataJSON: string): string {
  const data = JSON.parse(new TextDecoder().decode(base64urlnopad.decode(clientDataJSON.replace(/=+$/, ''))));
  if (typeof data.challenge !== 'string') throw new Error('Invalid client data');
  return data.challenge;
}

export async function passkeyRegistrationOptions(req: Request, label: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const { rpId } = requestOrigin(req);
  const options = await generateRegistrationOptions({
    rpName: 'Ötzi',
    rpID: rpId,
    userName: label || 'Ötzi user',
    userID: randomBytes(16),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  storeChallenge(options.challenge, { kind: 'passkey-register', rpId });
  return options;
}

/** Verify a registration response; returns the credential to store. Throws on failure. */
export async function verifyPasskeyRegistration(req: Request, response: RegistrationResponseJSON): Promise<Credential> {
  const { origin } = requestOrigin(req);
  const challenge = responseChallenge(response?.response?.clientDataJSON);
  const stored = consumeChallenge(challenge, 'passkey-register');
  if (!stored?.rpId) throw new Error('Invalid or expired challenge');
  if (!originMatchesRpId(origin, stored.rpId)) throw new Error('Origin does not match RP ID');

  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: stored.rpId,
    requireUserVerification: false,
  });
  if (!result.verified) throw new Error('Passkey registration could not be verified');

  const { credential } = result.registrationInfo;
  return {
    type: 'passkey',
    id: credential.id,
    publicKey: base64urlnopad.encode(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports,
    rpId: stored.rpId,
  };
}

export async function passkeyLoginOptions(req: Request): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const { rpId } = requestOrigin(req);
  const options = await generateAuthenticationOptions({ rpID: rpId, userVerification: 'preferred' });
  storeChallenge(options.challenge, { kind: 'passkey-login', rpId });
  return options;
}

/** Verify a sign-in response; returns the user. Throws on failure. */
export async function verifyPasskeyLogin(req: Request, response: AuthenticationResponseJSON, userStore: UserStore): Promise<User> {
  const { origin } = requestOrigin(req);
  const challenge = responseChallenge(response?.response?.clientDataJSON);
  const stored = consumeChallenge(challenge, 'passkey-login');
  if (!stored?.rpId) throw new Error('Invalid or expired challenge');

  const user = userStore.findByPasskey(response.id);
  if (!user || user.credential.type !== 'passkey') throw new Error('Unknown passkey');
  const cred = user.credential;
  if (cred.rpId !== stored.rpId || !originMatchesRpId(origin, cred.rpId)) throw new Error('Passkey belongs to a different site');

  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: cred.rpId,
    credential: {
      id: cred.id,
      publicKey: new Uint8Array(base64urlnopad.decode(cred.publicKey)),
      counter: cred.counter,
      transports: cred.transports as never,
    },
    requireUserVerification: false,
  });
  if (!result.verified) throw new Error('Passkey could not be verified');

  userStore.updatePasskeyCounter(user.id, result.authenticationInfo.newCounter);
  return user;
}
