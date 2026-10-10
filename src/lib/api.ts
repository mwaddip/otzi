/**
 * Frontend API client. All methods call /api/* endpoints on the same origin.
 */

import type {
  VaultConfig, NetworkName, StorageMode, AuthMode, VaultKey, AddressBookEntry,
  SendProposal, UserPublic, Invite,
} from './vault-types';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/browser';

const BASE = '/api';
const SESSION_TOKEN_KEY = 'otzi-session-token';
const SESSION_ROLE_KEY = 'otzi-session-role';

export const RELAY_URL = import.meta.env.VITE_RELAY_URL as string
  || `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

// ── Session ──

export type SessionRole = 'password-admin' | 'admin' | 'user';

function getToken(): string | null {
  try { return sessionStorage.getItem(SESSION_TOKEN_KEY); } catch { return null; }
}

export function setSession(token: string, role: SessionRole): void {
  try {
    sessionStorage.setItem(SESSION_TOKEN_KEY, token);
    sessionStorage.setItem(SESSION_ROLE_KEY, role);
  } catch { /* ignore */ }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    sessionStorage.removeItem(SESSION_ROLE_KEY);
  } catch { /* ignore */ }
}

export function getSessionRole(): SessionRole | null {
  if (!getToken()) return null;
  try { return sessionStorage.getItem(SESSION_ROLE_KEY) as SessionRole | null; } catch { return null; }
}

export function isAdminSession(): boolean {
  const role = getSessionRole();
  return role === 'admin' || role === 'password-admin';
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) clearSession();
    throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  }
  return data as T;
}

const post = <T>(path: string, body: unknown = {}) => json<T>(path, { method: 'POST', body: JSON.stringify(body) });
const put = <T>(path: string, body: unknown) => json<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) => json<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const del = <T>(path: string) => json<T>(path, { method: 'DELETE' });

// ── Status + setup ──

export type StatusResponse =
  | { state: 'fresh' }
  | { state: 'locked' }
  | { state: 'ready'; network: NetworkName; storageMode: StorageMode; authMode: AuthMode; hasVault: boolean };

export const getStatus = () => json<StatusResponse>('/status');

export type CredentialProof =
  | { type: 'passkey'; response: RegistrationResponseJSON }
  | { type: 'bitcoin'; address: string; challenge: string; signature: string };

export interface InitRequest {
  network: NetworkName;
  storageMode: StorageMode;
  authMode: AuthMode;
  password?: string;
  adminPassword?: string;
  admin?: { label: string; credential: CredentialProof };
}

export const initInstance = (req: InitRequest) =>
  post<{ ok: boolean; token: string; role: SessionRole }>('/init', req);

export const unlock = (password: string) => post<{ ok: boolean }>('/unlock', { password });

export const adminUnlock = (password: string) => post<{ ok: boolean; token: string }>('/admin/unlock', { password });

export const getConfig = () => json<VaultConfig>('/config');

export const setChainApi = (esploraUrl: string | null) =>
  post<{ ok: boolean; chainApiUrl: string }>('/config/chain', { esploraUrl });

export const saveVault = (vault: VaultKey) => post<{ ok: boolean; vaultAddress: string }>('/dkg/save', { vault });

export const downloadBackup = (password: string) => post<{ encrypted: string }>('/backup', { password });

export const restoreBackup = (encrypted: string, password: string) => post<{ ok: boolean }>('/restore', { encrypted, password });

export const resetInstance = () => post<{ ok: boolean }>('/reset', { confirm: 'RESET' });

// ── Relay ──

export const getRelayInfo = () => json<{ active: number; maxParties: number }>('/relay/sessions');

// ── BTC ──

export const getBalance = () => json<{ address: string; confirmed: number; unconfirmed: number }>('/btc/balance');

export const getFeeRates = () => json<{ low: number; normal: number; high: number; fallback?: boolean }>('/btc/fees');

export interface PrepareResponse {
  challengeToken: string;
  proposal: SendProposal;
  amount: number;
  fee: number;
  change: number;
  vsize: number;
}

export const prepareSend = (to: string, amount: number | 'max', feeRate: number) =>
  post<PrepareResponse>('/btc/prepare', { to, amount, feeRate });

export const broadcastSend = (challengeToken: string, signatures: Array<{ index: number; signature: string }>) =>
  post<{ txid: string; alreadyBroadcast?: boolean }>('/btc/broadcast', { challengeToken, signatures });

// ── Address book ──

export const getAddressBook = () => json<{ entries: AddressBookEntry[] }>('/address-book');

export const saveAddressBook = (entries: AddressBookEntry[]) =>
  put<{ ok: boolean; entries: AddressBookEntry[] }>('/address-book', { entries });

// ── Hosting ──

export const getHosting = () =>
  json<{ hosting: VaultConfig['hosting'] | null; hasCaddy: boolean }>('/hosting');

export const updateHosting = (domain: string, httpsEnabled: boolean, port?: number, path?: string) =>
  post<{ ok: boolean; warning?: string; config: VaultConfig }>('/hosting', { domain, httpsEnabled, port, path });

export const removeHosting = () => del<{ ok: boolean }>('/hosting');

// ── Auth ──

export interface SignInResult {
  authenticated: boolean;
  token?: string;
  role?: SessionRole;
  label?: string;
  needsInvite?: boolean;
}

export const getAuthMe = () =>
  json<{ authenticated: boolean; role?: SessionRole; userId?: string; label?: string }>('/auth/me');

export const getBitcoinChallenge = () => post<{ challenge: string; message: string }>('/auth/challenge');

export const bitcoinLogin = (address: string, challenge: string, signature: string) =>
  post<SignInResult>('/auth/bitcoin/login', { address, challenge, signature });

export const bitcoinRegister = (address: string, challenge: string, signature: string, inviteCode: string, label?: string) =>
  post<SignInResult>('/auth/bitcoin/register', { address, challenge, signature, inviteCode, label });

export const passkeyRegisterOptions = (label: string) =>
  post<{ options: PublicKeyCredentialCreationOptionsJSON }>('/auth/passkey/register-options', { label });

export const passkeyRegister = (response: RegistrationResponseJSON, inviteCode: string, label?: string) =>
  post<SignInResult>('/auth/passkey/register', { response, inviteCode, label });

export const passkeyLoginOptions = () =>
  post<{ options: PublicKeyCredentialRequestOptionsJSON }>('/auth/passkey/login-options');

export const passkeyLogin = (response: AuthenticationResponseJSON) =>
  post<SignInResult>('/auth/passkey/login', { response });

// ── Users (accounts mode) ──

export const listUsers = () => json<{ users: UserPublic[] }>('/users');
export const addUser = (label: string, role: 'admin' | 'user', address: string) =>
  post<{ ok: boolean; user: UserPublic }>('/users', { label, role, address });
export const removeUser = (id: string) => del<{ ok: boolean }>(`/users/${encodeURIComponent(id)}`);
export const updateUserRole = (id: string, role: 'admin' | 'user') =>
  patch<{ ok: boolean }>(`/users/${encodeURIComponent(id)}`, { role });

export const listInvites = () => json<{ invites: Invite[] }>('/invites');
export const createInvite = (maxUses: number, expiresAt: number, role: 'admin' | 'user') =>
  post<{ ok: boolean; invite: Invite }>('/invites', { maxUses, expiresAt, role });
export const deleteInvite = (code: string) => del<{ ok: boolean }>(`/invites/${encodeURIComponent(code)}`);

export const getVisibility = () => json<{ everybodyCanRead: boolean }>('/invites/settings/visibility');
export const setVisibility = (everybodyCanRead: boolean) =>
  post<{ ok: boolean }>('/invites/settings/visibility', { everybodyCanRead });
