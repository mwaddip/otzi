import { Router, type Request, type Response } from 'express';
import { createToken, createBitcoinChallenge, requestSession } from '../lib/auth.js';
import { verifyBitcoinProof } from '../lib/credentials.js';
import {
  passkeyRegistrationOptions, verifyPasskeyRegistration,
  passkeyLoginOptions, verifyPasskeyLogin,
  type RegistrationResponseJSON, type AuthenticationResponseJSON,
} from '../lib/passkey.js';
import type { ConfigStore } from '../lib/config-store.js';
import type { HostingConfig } from '../lib/types.js';
import type { Credential, User, UserStore } from '../lib/users.js';

function signedIn(res: Response, user: User): void {
  res.json({ authenticated: true, token: createToken(user.role, user.id), role: user.role, label: user.label });
}

/** Host of the page making the request (what the user sees in the address bar). */
function pageHost(req: Request): string {
  try {
    if (req.headers.origin) return new URL(req.headers.origin).host;
  } catch { /* fall through */ }
  const forwarded = req.headers['x-forwarded-host'];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded) || req.headers.host || 'unknown';
}

/** Host users reach the instance at, when hosting is configured. */
function configuredHost(hosting: HostingConfig | undefined): string | null {
  if (!hosting?.domain) return null;
  const port = hosting.port && hosting.port !== 80 && hosting.port !== 443 ? `:${hosting.port}` : '';
  return `${hosting.domain.toLowerCase()}${port}`;
}

function cleanLabel(label: unknown, fallback: string): string {
  const l = typeof label === 'string' ? label.trim().slice(0, 64) : '';
  return l || fallback;
}

export function authRoutes(store: ConfigStore, userStore: UserStore): Router {
  const r = Router();

  const accountsMode = () => store.isLoaded() && store.get().authMode === 'accounts';

  /** Redeem an invite for a verified credential, answering the request. */
  function redeem(res: Response, inviteCode: unknown, label: string, credential: Credential): void {
    if (typeof inviteCode !== 'string' || !inviteCode.trim()) {
      res.status(400).json({ error: 'inviteCode required' });
      return;
    }
    try {
      const user = userStore.redeemInvite(inviteCode.trim().toUpperCase(), label, credential);
      if (!user) { res.status(400).json({ error: 'Invalid, expired, or exhausted invite code' }); return; }
      signedIn(res, user);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  }

  /** GET /api/auth/me */
  r.get('/me', (req: Request, res: Response) => {
    const info = requestSession(req, userStore);
    if (!info) { res.json({ authenticated: false }); return; }
    const user = info.userId ? userStore.getUser(info.userId) : null;
    res.json({ authenticated: true, role: info.role, ...(user ? { userId: user.id, label: user.label } : {}) });
  });

  /** POST /api/auth/challenge — Bitcoin sign-in message */
  r.post('/challenge', (req: Request, res: Response) => {
    const host = pageHost(req);
    const expected = store.isLoaded() ? configuredHost(store.get().hosting) : null;
    if (expected && host.toLowerCase() !== expected) {
      res.status(400).json({ error: `Sign in from ${expected}` });
      return;
    }
    res.json(createBitcoinChallenge(host));
  });

  /** POST /api/auth/bitcoin/login */
  r.post('/bitcoin/login', (req: Request, res: Response) => {
    if (!accountsMode()) { res.status(400).json({ error: 'Accounts are not enabled' }); return; }
    const { address, challenge, signature } = req.body as Record<string, unknown>;
    let credential;
    try {
      credential = verifyBitcoinProof(address, challenge, signature);
    } catch (e) {
      const msg = (e as Error).message;
      res.status(msg === 'Signature verification failed' ? 401 : 400).json({ error: msg });
      return;
    }
    const user = credential.type === 'bitcoin' ? userStore.findByAddress(credential.address) : null;
    if (!user) { res.json({ authenticated: false, needsInvite: true }); return; }
    signedIn(res, user);
  });

  /** POST /api/auth/bitcoin/register — redeem an invite with a Bitcoin address */
  r.post('/bitcoin/register', (req: Request, res: Response) => {
    if (!accountsMode()) { res.status(400).json({ error: 'Accounts are not enabled' }); return; }
    const { address, challenge, signature, inviteCode, label } = req.body as Record<string, unknown>;
    let credential;
    try {
      credential = verifyBitcoinProof(address, challenge, signature);
    } catch (e) {
      const msg = (e as Error).message;
      res.status(msg === 'Signature verification failed' ? 401 : 400).json({ error: msg });
      return;
    }
    redeem(res, inviteCode, cleanLabel(label, (address as string).slice(0, 12)), credential);
  });

  /** POST /api/auth/passkey/register-options — usable before init and for invites */
  r.post('/passkey/register-options', async (req: Request, res: Response) => {
    if (store.isInitialized() && !accountsMode()) { res.status(400).json({ error: 'Accounts are not enabled' }); return; }
    try {
      const options = await passkeyRegistrationOptions(req, cleanLabel((req.body as { label?: unknown }).label, 'Ötzi user'));
      res.json({ options });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  /** POST /api/auth/passkey/register — redeem an invite with a new passkey */
  r.post('/passkey/register', async (req: Request, res: Response) => {
    if (!accountsMode()) { res.status(400).json({ error: 'Accounts are not enabled' }); return; }
    const { response, inviteCode, label } = req.body as { response?: RegistrationResponseJSON; inviteCode?: unknown; label?: unknown };
    if (typeof inviteCode !== 'string' || !userStore.peekInvite(inviteCode.trim().toUpperCase())) {
      res.status(400).json({ error: 'Invalid, expired, or exhausted invite code' });
      return;
    }
    let credential;
    try {
      credential = await verifyPasskeyRegistration(req, response as RegistrationResponseJSON);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
      return;
    }
    redeem(res, inviteCode, cleanLabel(label, 'Passkey user'), credential);
  });

  /** POST /api/auth/passkey/login-options */
  r.post('/passkey/login-options', async (req: Request, res: Response) => {
    if (!accountsMode()) { res.status(400).json({ error: 'Accounts are not enabled' }); return; }
    try {
      res.json({ options: await passkeyLoginOptions(req) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  /** POST /api/auth/passkey/login */
  r.post('/passkey/login', async (req: Request, res: Response) => {
    if (!accountsMode()) { res.status(400).json({ error: 'Accounts are not enabled' }); return; }
    try {
      const user = await verifyPasskeyLogin(req, (req.body as { response: AuthenticationResponseJSON }).response, userStore);
      signedIn(res, user);
    } catch (e) {
      res.status(401).json({ error: (e as Error).message });
    }
  });

  return r;
}
