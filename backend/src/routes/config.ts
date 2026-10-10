import { Router, type Request, type Response, type RequestHandler } from 'express';
import { ConfigStore } from '../lib/config-store.js';
import type { UserStore, UserDB } from '../lib/users.js';
import {
  NETWORK_NAMES, STORAGE_MODES, AUTH_MODES,
  type VaultConfig, type NetworkName, type StorageMode, type AuthMode,
} from '../lib/types.js';
import { hashPassword, verifyPassword, createToken, requestSession, revokeAllTokens } from '../lib/auth.js';
import { encryptConfig, decryptConfig } from '../lib/encryption.js';
import { verifyCredentialProof } from '../lib/credentials.js';
import { validateVaultKey, sameVaultKey, vaultPayment } from '../lib/bitcoin.js';
import { validateAddressBook } from '../lib/address-book.js';
import { chainApiUrl } from '../lib/esplora.js';
import { publicConfig } from '../lib/public-config.js';

/** Validate a config coming from a backup file. Throws with a reason. */
function validateBackupConfig(input: unknown): VaultConfig {
  if (!input || typeof input !== 'object') throw new Error('config missing');
  const c = input as Record<string, unknown>;
  if (c.version !== 2) throw new Error('unsupported config version');
  if (!NETWORK_NAMES.includes(c.network as NetworkName)) throw new Error('invalid network');
  if (!STORAGE_MODES.includes(c.storageMode as StorageMode)) throw new Error('invalid storage mode');
  if (!AUTH_MODES.includes(c.authMode as AuthMode)) throw new Error('invalid auth mode');
  const network = c.network as NetworkName;
  return {
    version: 2,
    network,
    storageMode: c.storageMode as StorageMode,
    authMode: c.authMode as AuthMode,
    ...(typeof c.adminPasswordHash === 'string' ? { adminPasswordHash: c.adminPasswordHash } : {}),
    ...(typeof c.esploraUrl === 'string' && c.esploraUrl ? { esploraUrl: c.esploraUrl } : {}),
    ...(c.vault ? { vault: validateVaultKey(c.vault) } : {}),
    addressBook: validateAddressBook(c.addressBook ?? [], network),
    ...(c.hosting && typeof c.hosting === 'object' ? { hosting: c.hosting as VaultConfig['hosting'] } : {}),
  };
}

export function configRoutes(store: ConfigStore, userStore: UserStore, requireAdmin: RequestHandler, requireRead: RequestHandler): Router {
  const r = Router();

  /** GET /api/status — setup state */
  r.get('/status', (_req: Request, res: Response) => {
    if (!store.isInitialized()) {
      res.json({ state: 'fresh' });
      return;
    }
    if (!store.isLoaded()) {
      res.json({ state: 'locked' });
      return;
    }
    const { network, storageMode, authMode, vault } = store.get();
    res.json({ state: 'ready', network, storageMode, authMode, hasVault: !!vault });
  });

  /** POST /api/init — first-time setup */
  r.post('/init', async (req: Request, res: Response) => {
    const { network, storageMode, password, adminPassword, admin } = req.body as {
      network?: NetworkName;
      storageMode?: StorageMode;
      authMode?: AuthMode;
      password?: string;
      adminPassword?: string;
      admin?: { label?: string; credential?: unknown };
    };
    const authMode = (req.body.authMode ?? 'password') as AuthMode;

    if (!NETWORK_NAMES.includes(network!)) { res.status(400).json({ error: 'invalid network' }); return; }
    if (!STORAGE_MODES.includes(storageMode!)) { res.status(400).json({ error: 'invalid storageMode' }); return; }
    if (!AUTH_MODES.includes(authMode)) { res.status(400).json({ error: 'invalid authMode' }); return; }
    if (storageMode === 'encrypted-persistent' && !password) {
      res.status(400).json({ error: 'password required for encrypted-persistent mode' });
      return;
    }
    if (store.isInitialized()) { res.status(409).json({ error: 'Already initialized' }); return; }

    try {
      if (authMode === 'password') {
        if (!adminPassword) { res.status(400).json({ error: 'adminPassword required' }); return; }
        store.init(network!, storageMode!, authMode, password);
        store.update({ adminPasswordHash: hashPassword(adminPassword) });
        userStore.reset();
        res.json({ ok: true, token: createToken('password-admin'), role: 'password-admin' });
        return;
      }

      // Accounts mode: verify the first admin's credential before initializing
      if (storageMode !== 'persistent') { res.status(400).json({ error: 'accounts mode requires persistent storage' }); return; }
      const label = (admin?.label || 'Admin').trim().slice(0, 64) || 'Admin';
      let credential;
      try {
        credential = await verifyCredentialProof(req, admin?.credential);
      } catch (e) {
        res.status(400).json({ error: (e as Error).message });
        return;
      }
      store.init(network!, storageMode!, authMode);
      userStore.reset();
      const user = userStore.addUser(label, 'admin', credential);
      res.json({ ok: true, token: createToken('admin', user.id), role: 'admin' });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** POST /api/unlock — decrypt encrypted-persistent config */
  r.post('/unlock', (req: Request, res: Response) => {
    const { password } = req.body as { password?: string };
    if (!password) { res.status(400).json({ error: 'password required' }); return; }
    try {
      store.load(password);
      res.json({ ok: true });
    } catch {
      res.status(401).json({ error: 'Wrong password or corrupted config' });
    }
  });

  /** POST /api/admin/unlock — verify admin password, return session token */
  r.post('/admin/unlock', (req: Request, res: Response) => {
    const { password } = req.body as { password?: string };
    if (!password) { res.status(400).json({ error: 'password required' }); return; }
    if (!store.isLoaded()) { res.status(503).json({ error: 'Instance not ready' }); return; }
    const config = store.get();
    if (!config.adminPasswordHash) { res.status(400).json({ error: 'No admin password set' }); return; }
    if (!verifyPassword(password, config.adminPasswordHash)) { res.status(401).json({ error: 'Wrong admin password' }); return; }
    res.json({ ok: true, token: createToken('password-admin') });
  });

  /** GET /api/config — public config */
  r.get('/config', requireRead, (_req: Request, res: Response) => {
    res.json(publicConfig(store.get()));
  });

  /** POST /api/config/chain — set or clear the Esplora URL override */
  r.post('/config/chain', requireAdmin, (req: Request, res: Response) => {
    const { esploraUrl } = req.body as { esploraUrl?: string | null };
    if (esploraUrl === null || esploraUrl === undefined || esploraUrl === '') {
      store.update({ esploraUrl: undefined });
      res.json({ ok: true, chainApiUrl: chainApiUrl(store.get()) });
      return;
    }
    let url: URL;
    try {
      url = new URL(esploraUrl);
    } catch {
      res.status(400).json({ error: 'esploraUrl must be a URL' });
      return;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      res.status(400).json({ error: 'esploraUrl must be http(s)' });
      return;
    }
    store.update({ esploraUrl: esploraUrl.trim().replace(/\/+$/, '') });
    res.json({ ok: true, chainApiUrl: chainApiUrl(store.get()) });
  });

  /** POST /api/dkg/save — save the vault public key package */
  r.post('/dkg/save', requireAdmin, (req: Request, res: Response) => {
    let vault;
    try {
      vault = validateVaultKey((req.body as { vault?: unknown }).vault);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
      return;
    }
    const config = store.get();
    if (config.vault && !sameVaultKey(config.vault, vault)) {
      res.status(409).json({ error: 'A different vault is already saved' });
      return;
    }
    if (!config.vault) store.update({ vault });
    res.json({ ok: true, vaultAddress: vaultPayment(vault, config.network).address });
  });

  /** POST /api/backup — encrypted backup (config + users) */
  r.post('/backup', requireAdmin, (req: Request, res: Response) => {
    const { password } = req.body as { password?: string };
    if (!password) { res.status(400).json({ error: 'password required' }); return; }
    const backup = {
      version: 2,
      timestamp: Date.now(),
      config: store.get(),
      users: userStore.snapshot(),
    };
    res.json({ encrypted: encryptConfig(JSON.stringify(backup), password) });
  });

  /** POST /api/restore — decrypt and restore an encrypted backup */
  r.post('/restore', (req: Request, res: Response) => {
    if (store.isInitialized()) {
      if (!store.isLoaded()) { res.status(503).json({ error: 'Instance not ready' }); return; }
      const info = requestSession(req, userStore);
      const adminRole = store.get().authMode === 'password' ? 'password-admin' : 'admin';
      if (info?.role !== adminRole) { res.status(401).json({ error: 'Admin authentication required' }); return; }
    }

    const { encrypted, password } = req.body as { encrypted?: string; password?: string };
    if (!encrypted || !password) { res.status(400).json({ error: 'encrypted and password required' }); return; }

    let backup: { version?: number; config?: unknown; users?: UserDB };
    try {
      backup = JSON.parse(decryptConfig(encrypted.trim(), password));
    } catch {
      res.status(401).json({ error: 'Wrong password or corrupted backup' });
      return;
    }

    let config: VaultConfig;
    try {
      if (backup.version !== 2) throw new Error('unsupported backup version');
      config = validateBackupConfig(backup.config);
    } catch (e) {
      res.status(400).json({ error: `Invalid backup: ${(e as Error).message}` });
      return;
    }

    try {
      store.replace(config, config.storageMode === 'encrypted-persistent' ? password : undefined);
      // Users exist only in accounts mode; password-mode instances keep no users file
      if (config.authMode === 'accounts') {
        userStore.replace(backup.users ?? { users: [], invites: [], settings: { everybodyCanRead: true } });
      } else {
        userStore.reset();
      }
      revokeAllTokens();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** POST /api/reset — wipe everything */
  r.post('/reset', requireAdmin, (req: Request, res: Response) => {
    const { confirm } = req.body as { confirm?: string };
    if (confirm !== 'RESET') { res.status(400).json({ error: 'Send { confirm: "RESET" } to confirm' }); return; }
    store.reset();
    userStore.reset();
    revokeAllTokens();
    res.json({ ok: true });
  });

  return r;
}
