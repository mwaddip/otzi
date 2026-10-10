import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { encryptConfig, decryptConfig } from './encryption.js';
import { type VaultConfig, type StorageMode, type NetworkName, type AuthMode, defaultConfig } from './types.js';

const DATA_DIR = process.env.DATA_DIR || '/data';
const CONFIG_PATH = `${DATA_DIR}/config.json`;

export class ConfigStore {
  private config: VaultConfig | null = null;
  /** Storage password for encrypted-persistent mode, held while the config is loaded. */
  private password: string | null = null;

  /** Check if an instance has been initialized */
  isInitialized(): boolean {
    if (this.config) return true;
    return existsSync(CONFIG_PATH);
  }

  isLoaded(): boolean {
    return this.config !== null;
  }

  /** Initialize a new instance. Called once from the install wizard. */
  init(network: NetworkName, storageMode: StorageMode, authMode: AuthMode, password?: string): void {
    if (this.isInitialized()) throw new Error('Already initialized');
    if (storageMode === 'encrypted-persistent' && !password) {
      throw new Error('Password required for encrypted-persistent mode');
    }
    const config = defaultConfig(network, storageMode, authMode);

    // Hosting seed file (written by install.sh --domain)
    const seedPath = `${DATA_DIR}/hosting-seed.json`;
    if (existsSync(seedPath)) {
      try {
        const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
        if (seed.domain) {
          config.hosting = {
            domain: seed.domain,
            port: seed.port || undefined,
            path: seed.path || undefined,
            httpsEnabled: seed.httpsEnabled ?? true,
          };
        }
        unlinkSync(seedPath);
      } catch { /* ignore bad seed */ }
    }

    this.config = config;
    this.password = password ?? null;
    this.persist();
  }

  /** Load config from disk. For encrypted-persistent, requires password. */
  load(password?: string): VaultConfig {
    if (this.config) return this.config;
    if (!existsSync(CONFIG_PATH)) throw new Error('Not initialized');

    const raw = readFileSync(CONFIG_PATH, 'utf8');

    // Plaintext JSON first
    try {
      this.config = JSON.parse(raw) as VaultConfig;
      return this.config;
    } catch {
      // Not JSON — must be encrypted
    }

    if (!password) throw new Error('Password required to unlock');
    this.config = JSON.parse(decryptConfig(raw, password)) as VaultConfig;
    this.password = password;
    return this.config;
  }

  /** Get current config (must be loaded first). */
  get(): VaultConfig {
    if (!this.config) throw new Error('Config not loaded');
    return this.config;
  }

  /** Update config fields and persist. */
  update(patch: Partial<VaultConfig>): VaultConfig {
    if (!this.config) throw new Error('Config not loaded');
    this.config = { ...this.config, ...patch };
    this.persist();
    return this.config;
  }

  /** Replace the whole config (restore). */
  replace(config: VaultConfig, password?: string): void {
    if (config.storageMode === 'encrypted-persistent' && !password) {
      throw new Error('Password required for encrypted-persistent mode');
    }
    this.config = config;
    this.password = password ?? null;
    // A portable config must not leave an older on-disk config behind
    if (config.storageMode === 'encrypted-portable' && existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    this.persist();
  }

  /** Wipe all data. */
  reset(): void {
    this.config = null;
    this.password = null;
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  }

  private persist(): void {
    if (!this.config) return;
    const mode = this.config.storageMode;
    if (mode === 'encrypted-portable') return; // memory only

    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    const json = JSON.stringify(this.config, null, 2);
    if (mode === 'encrypted-persistent') {
      if (!this.password) throw new Error('Password required for encrypted-persistent mode');
      writeFileSync(CONFIG_PATH, encryptConfig(json, this.password));
    } else {
      writeFileSync(CONFIG_PATH, json);
    }
  }
}
