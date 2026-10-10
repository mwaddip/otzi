import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export type Role = 'admin' | 'user';

export type Credential =
  | { type: 'passkey'; id: string; publicKey: string; counter: number; transports?: string[]; rpId: string }
  | { type: 'bitcoin'; address: string };

export interface User {
  id: string;
  label: string;
  role: Role;
  credential: Credential;
}

/** User as returned by the API — no passkey key material. */
export type UserPublic = Omit<User, 'credential'> & {
  credential: { type: 'passkey' } | { type: 'bitcoin'; address: string };
};

export interface Invite {
  code: string;
  role: Role;
  usesLeft: number;
  expiresAt: number; // unix ms
}

export interface UserDB {
  users: User[];
  invites: Invite[];
  settings: { everybodyCanRead: boolean };
}

const DATA_DIR = process.env.DATA_DIR || '/data';
const USERS_PATH = `${DATA_DIR}/users.json`;

function emptyDB(): UserDB {
  return { users: [], invites: [], settings: { everybodyCanRead: true } };
}

export function toPublic(user: User): UserPublic {
  const credential = user.credential.type === 'passkey'
    ? { type: 'passkey' as const }
    : { type: 'bitcoin' as const, address: user.credential.address };
  return { id: user.id, label: user.label, role: user.role, credential };
}

export class UserStore {
  private db: UserDB = emptyDB();

  constructor() {
    this.load();
  }

  private load(): void {
    if (!existsSync(USERS_PATH)) return;
    try {
      this.db = JSON.parse(readFileSync(USERS_PATH, 'utf8'));
    } catch (e) {
      console.warn(`[users] Failed to parse ${USERS_PATH}, starting fresh:`, (e as Error).message);
    }
  }

  private save(): void {
    mkdirSync(dirname(USERS_PATH), { recursive: true });
    writeFileSync(USERS_PATH, JSON.stringify(this.db, null, 2));
  }

  // ── Users ──

  getUser(id: string): User | null {
    return this.db.users.find(u => u.id === id) ?? null;
  }

  findByPasskey(credentialId: string): User | null {
    return this.db.users.find(u => u.credential.type === 'passkey' && u.credential.id === credentialId) ?? null;
  }

  findByAddress(address: string): User | null {
    return this.db.users.find(u => u.credential.type === 'bitcoin' && u.credential.address === address) ?? null;
  }

  private assertCredentialFree(credential: Credential): void {
    const taken = credential.type === 'passkey'
      ? this.findByPasskey(credential.id)
      : this.findByAddress(credential.address);
    if (taken) throw new Error('Credential already registered');
  }

  addUser(label: string, role: Role, credential: Credential): User {
    this.assertCredentialFree(credential);
    const user: User = { id: randomBytes(16).toString('hex'), label, role, credential };
    this.db.users.push(user);
    this.save();
    return user;
  }

  private adminCount(): number {
    return this.db.users.filter(u => u.role === 'admin').length;
  }

  removeUser(id: string): void {
    const user = this.getUser(id);
    if (!user) throw new Error('User not found');
    if (user.role === 'admin' && this.adminCount() === 1) throw new Error('Cannot remove the last admin');
    this.db.users = this.db.users.filter(u => u.id !== id);
    this.save();
  }

  updateRole(id: string, role: Role): void {
    const user = this.getUser(id);
    if (!user) throw new Error('User not found');
    if (user.role === 'admin' && role !== 'admin' && this.adminCount() === 1) {
      throw new Error('Cannot demote the last admin');
    }
    user.role = role;
    this.save();
  }

  updatePasskeyCounter(id: string, counter: number): void {
    const user = this.getUser(id);
    if (user?.credential.type !== 'passkey') return;
    user.credential.counter = counter;
    this.save();
  }

  listUsers(): User[] {
    return [...this.db.users];
  }

  // ── Invites ──

  createInvite(role: Role, maxUses: number, expiresAt: number): Invite {
    const code = randomBytes(5).toString('hex').slice(0, 8).toUpperCase();
    const invite: Invite = { code, role, usesLeft: maxUses, expiresAt };
    this.db.invites.push(invite);
    this.save();
    return invite;
  }

  /** Check an invite without consuming it. */
  peekInvite(code: string): Invite | null {
    const invite = this.db.invites.find(i => i.code === code);
    if (!invite || Date.now() > invite.expiresAt || invite.usesLeft <= 0) return null;
    return invite;
  }

  /** Consume one use of an invite and create the user. Returns null if the invite is not usable. */
  redeemInvite(code: string, label: string, credential: Credential): User | null {
    const invite = this.peekInvite(code);
    if (!invite) return null;
    this.assertCredentialFree(credential);
    invite.usesLeft--;
    if (invite.usesLeft <= 0) this.db.invites = this.db.invites.filter(i => i.code !== code);
    const user: User = { id: randomBytes(16).toString('hex'), label, role: invite.role, credential };
    this.db.users.push(user);
    this.save();
    return user;
  }

  listInvites(): Invite[] {
    const now = Date.now();
    this.db.invites = this.db.invites.filter(i => i.expiresAt > now && i.usesLeft > 0);
    return [...this.db.invites];
  }

  removeInvite(code: string): void {
    this.db.invites = this.db.invites.filter(i => i.code !== code);
    this.save();
  }

  // ── Settings ──

  getEverybodyCanRead(): boolean {
    return this.db.settings.everybodyCanRead;
  }

  setEverybodyCanRead(value: boolean): void {
    this.db.settings.everybodyCanRead = value;
    this.save();
  }

  // ── Whole store ──

  snapshot(): UserDB {
    return JSON.parse(JSON.stringify(this.db));
  }

  /** Replace the store (restore). */
  replace(db: UserDB): void {
    this.db = {
      users: Array.isArray(db.users) ? db.users : [],
      invites: Array.isArray(db.invites) ? db.invites : [],
      settings: { everybodyCanRead: db.settings?.everybodyCanRead ?? true },
    };
    this.save();
  }

  /** Wipe all users, invites, and settings. */
  reset(): void {
    this.db = emptyDB();
    if (existsSync(USERS_PATH)) unlinkSync(USERS_PATH);
  }
}
