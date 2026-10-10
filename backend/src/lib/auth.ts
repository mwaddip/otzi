import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { ConfigStore } from './config-store.js';
import type { UserStore, Role } from './users.js';

// ── Password hashing (password mode) ──

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const computed = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return timingSafeEqual(Buffer.from(hash), Buffer.from(computed));
}

// ── Session tokens ──

export type TokenRole = Role | 'password-admin';

export interface TokenInfo {
  role: TokenRole;
  userId?: string;
  expiresAt: number;
}

const tokens = new Map<string, TokenInfo>();
const TOKEN_EXPIRY = 6 * 60 * 60 * 1000; // 6 hours

export function createToken(role: TokenRole, userId?: string): string {
  const token = randomBytes(32).toString('hex');
  tokens.set(token, { role, userId, expiresAt: Date.now() + TOKEN_EXPIRY });
  return token;
}

export function getTokenInfo(token: string): TokenInfo | null {
  const info = tokens.get(token);
  if (!info) return null;
  if (Date.now() > info.expiresAt) {
    tokens.delete(token);
    return null;
  }
  return info;
}

export function revokeAllTokens(): void {
  tokens.clear();
}

export function extractToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

export function requestTokenInfo(req: Request): TokenInfo | null {
  const token = extractToken(req);
  return token ? getTokenInfo(token) : null;
}

// ── One-use challenges ──

export type ChallengeKind = 'bitcoin' | 'passkey-register' | 'passkey-login';

interface Challenge {
  kind: ChallengeKind;
  message?: string;   // bitcoin: the exact text to be signed
  rpId?: string;      // passkey: RP ID the options were issued for
  expiresAt: number;
}

const challenges = new Map<string, Challenge>();
const CHALLENGE_EXPIRY = 5 * 60 * 1000;

export function storeChallenge(value: string, challenge: Omit<Challenge, 'expiresAt'>): void {
  challenges.set(value, { ...challenge, expiresAt: Date.now() + CHALLENGE_EXPIRY });
}

/** Remove and return a challenge of the given kind, or null if unknown/expired/wrong kind. */
export function consumeChallenge(value: string, kind: ChallengeKind): Challenge | null {
  const c = challenges.get(value);
  if (!c) return null;
  challenges.delete(value);
  if (c.kind !== kind || Date.now() > c.expiresAt) return null;
  return c;
}

/** Issue a Bitcoin sign-in challenge bound to the request host. */
export function createBitcoinChallenge(host: string): { challenge: string; message: string } {
  const challenge = randomBytes(32).toString('hex');
  const message = `Sign in to Otzi\nHost: ${host}\nChallenge: ${challenge}`;
  storeChallenge(challenge, { kind: 'bitcoin', message });
  return { challenge, message };
}

// ── Role-aware middleware ──

export interface AuthMiddleware {
  requireAdmin: RequestHandler;
  requireUser: RequestHandler;
  requireRead: RequestHandler;
}

export function createAuthMiddleware(store: ConfigStore, userStore: UserStore): AuthMiddleware {
  function guard(check: (info: TokenInfo | null) => string | null): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (!store.isLoaded()) {
        res.status(503).json({ error: 'Instance not ready' });
        return;
      }
      // An unknown or expired token counts as no token
      const info = requestTokenInfo(req);
      const error = check(info);
      if (error) {
        res.status(info ? 403 : 401).json({ error });
        return;
      }
      next();
    };
  }

  const isPasswordMode = () => store.get().authMode === 'password';

  const requireAdmin = guard(info => {
    if (isPasswordMode()) return info?.role === 'password-admin' ? null : 'Admin authentication required';
    return info?.role === 'admin' ? null : 'Admin role required';
  });

  const requireUser = guard(info => {
    if (isPasswordMode()) return info?.role === 'password-admin' ? null : 'Admin authentication required';
    return info?.role === 'admin' || info?.role === 'user' ? null : 'Sign-in required';
  });

  const requireRead = guard(info => {
    if (isPasswordMode()) return null;
    if (userStore.getEverybodyCanRead()) return null;
    return info ? null : 'Sign-in required';
  });

  return { requireAdmin, requireUser, requireRead };
}

// ── Periodic cleanup ──

setInterval(() => {
  const now = Date.now();
  for (const [key, info] of tokens) if (now > info.expiresAt) tokens.delete(key);
  for (const [key, c] of challenges) if (now > c.expiresAt) challenges.delete(key);
}, 5 * 60 * 1000).unref();
