# PERMAFROST Vault Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the PERMAFROST repo from a DKG-only ceremony app into a full multisig operations toolkit with wallet management, threshold signing, and OPNet transaction broadcasting, packaged as a Docker container.

**Architecture:** Single Docker image running three processes: a React frontend (Vite), a Node.js/Express backend (config management, OPNet RPC, tx broadcasting), and the existing Go WebSocket relay. The frontend drives a linear flow: Install Wizard → Wallet Setup → DKG Ceremony → Signing Page. The backend holds wallet keys in memory and never exposes them to the frontend.

**Tech Stack:** React 18, Vite, Express, TypeScript, `opnet` SDK, `@btc-vision/transaction`, `@btc-vision/bitcoin`, `@btc-vision/post-quantum` (vendor), Go 1.23 (relay), Docker

**Spec:** `docs/specs/2026-03-12-permafrost-vault-design.md`

---

## Context for Implementers

### Repository State

The repo (`~/projects/opnet-permafrost`) already has:
- A working DKG ceremony app (`src/components/DKGWizard.tsx`) — React + Vite
- Relay client + E2E crypto (`src/lib/relay.ts`, `relay-crypto.ts`)
- Share file encryption (`src/lib/crypto.ts`, `keygen.ts`, `serialize.ts`)
- DKG protocol helpers (`src/lib/dkg.ts`)
- Go WebSocket relay server (`relay/`)
- Vendor post-quantum library (`vendor/post-quantum/`)
- Dark theme with blue accent (`src/styles/global.css`, `ceremony.css`)

### OPNet Essentials

- **Selectors**: SHA256 first 4 bytes (NOT Keccak256). Use `encodeSelector()` from opnet.
- **Network**: `networks.opnetTestnet` (bech32: `opt`) for testnet. NEVER `networks.testnet`.
- **Wallet**: `Mnemonic` → `deriveOPWallet()` gives BIP86 taproot keypair. The ML-DSA key is generated separately by the DKG ceremony.
- **Address**: `Address.fromString(mldsaPubKeyHex, tweakedPubKeyHex)` — constructor SHA-256 hashes the full-length ML-DSA key internally.
- **Contract calls**: `getContract()` → simulate → `sendTransaction()`. Always simulate before sending.
- **ML-DSA signing**: The SDK expects `mldsaSigner: QuantumBIP32Interface`. We provide a `ThresholdMLDSASigner` adapter that returns the pre-computed threshold signature.

### Source Files to Copy from OD Cabal

These files live at `~/projects/od/cabal/src/` and need to be copied with modifications noted in each task:
- `lib/threshold.ts` — Signing session (3-round protocol). Generic, no OD dependencies.
- `lib/share-crypto.ts` — Share file decryption. Generic, no OD dependencies.
- `components/ThresholdSign.tsx` — Signing UI with relay + offline modes. Needs prop interface changes (see Task 13).
- `~/projects/od/cabal/src/styles/admin.css` — CSS for ThresholdSign component (classes prefixed `.threshold-`, `.admin-detail-`). Must be merged into `ceremony.css`.

### ThresholdSign Component Interface (Important)

The cabal `ThresholdSign` component has these required props:

```typescript
interface ThresholdSignProps {
  stepTitle: string;
  targetContract: string;
  txParams: Record<string, string>;
  message: Uint8Array;
  share: DecryptedShare;
  onSignatureReady: (signature: Uint8Array) => void;
  onCancel: () => void;
  relayClient?: RelayClient | null;
  relayPartyId?: number;
}
```

And `ShareGate` uses children render prop:

```typescript
<ShareGate>{(share) => <ThresholdSign ... />}</ShareGate>
```

### Calldata Encoding

OPNet calldata must be encoded with `BinaryWriter`. Since `opnet` is too large for the frontend bundle, the backend provides a `/api/tx/encode` endpoint that encodes calldata from method name + typed params. The frontend calls this before threshold signing.

---

## Chunk 1: Backend Foundation

### Task 1: Backend Project Scaffolding

**Files:**
- Create: `backend/package.json`
- Create: `backend/tsconfig.json`

- [ ] **Step 1: Create backend package.json**

```json
{
  "name": "permafrost-vault-backend",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "express": "^4.21.0",
    "http-proxy-middleware": "^3.0.0",
    "opnet": "1.8.1-rc.17",
    "@btc-vision/transaction": "^1.8.0-rc.10",
    "@btc-vision/bitcoin": "^7.0.0-rc.6"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.9.3"
  }
}
```

- [ ] **Step 2: Create backend tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Install backend dependencies**

```bash
cd backend && npm install
```

- [ ] **Step 4: Commit**

```bash
git add backend/package.json backend/tsconfig.json backend/package-lock.json
git commit -m "feat: scaffold backend project with dependencies"
```

---

### Task 2: Config Store

The config store handles three storage modes: persistent (plaintext on disk), encrypted-persistent (encrypted on disk, password to unlock), and encrypted-portable (frontend uploads encrypted config, backend holds in memory only).

**Files:**
- Create: `backend/src/lib/encryption.ts`
- Create: `backend/src/lib/config-store.ts`
- Create: `backend/src/lib/types.ts`

- [ ] **Step 1: Create shared types**

Create `backend/src/lib/types.ts`:

```typescript
export type StorageMode = 'persistent' | 'encrypted-persistent' | 'encrypted-portable';
export type NetworkName = 'testnet' | 'mainnet';

export interface SetupState {
  wizardComplete: boolean;
  walletSkipped: boolean;
  walletDontShowAgain: boolean;
  dkgComplete: boolean;
}

export interface WalletConfig {
  mnemonic: string;
  p2tr: string;
  tweakedPubKey: string;
  publicKey: string;
}

export interface PermafrostConfig {
  threshold: number;
  parties: number;
  level: number;
  combinedPubKey: string;
  shareData: string;
}

export interface ContractConfig {
  name: string;
  address: string;
  abi: unknown[];
  methods: string[];
}

export interface VaultConfig {
  version: number;
  network: NetworkName;
  storageMode: StorageMode;
  setupState: SetupState;
  wallet?: WalletConfig;
  permafrost?: PermafrostConfig;
  contracts: ContractConfig[];
}

export function defaultConfig(network: NetworkName, storageMode: StorageMode): VaultConfig {
  return {
    version: 1,
    network,
    storageMode,
    setupState: {
      wizardComplete: true,
      walletSkipped: false,
      walletDontShowAgain: false,
      dkgComplete: false,
    },
    contracts: [],
  };
}

/** Sanitize config for frontend — strip private keys */
export function sanitizeConfig(config: VaultConfig): Omit<VaultConfig, 'wallet'> & { wallet?: Omit<WalletConfig, 'mnemonic'> } {
  const { wallet, ...rest } = config;
  if (!wallet) return rest;
  const { mnemonic: _, ...safeWallet } = wallet;
  return { ...rest, wallet: safeWallet };
}
```

- [ ] **Step 2: Create encryption module**

Create `backend/src/lib/encryption.ts`:

```typescript
import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from 'node:crypto';

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const AUTH_TAG_BYTES = 16;

function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_BYTES, 'sha256');
}

/** Encrypt plaintext with AES-256-GCM + PBKDF2. Returns base64: salt(16) + iv(12) + tag(16) + ciphertext. */
export function encryptConfig(plaintext: string, password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

/** Decrypt base64 produced by encryptConfig(). Throws on wrong password. */
export function decryptConfig(encoded: string, password: string): string {
  const buf = Buffer.from(encoded, 'base64');
  const salt = buf.subarray(0, SALT_BYTES);
  const iv = buf.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES);
  const tag = buf.subarray(SALT_BYTES + IV_BYTES, SALT_BYTES + IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = buf.subarray(SALT_BYTES + IV_BYTES + AUTH_TAG_BYTES);
  const key = deriveKey(password, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}
```

- [ ] **Step 3: Create config store**

Create `backend/src/lib/config-store.ts`:

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { encryptConfig, decryptConfig } from './encryption.js';
import { type VaultConfig, type StorageMode, type NetworkName, defaultConfig } from './types.js';

const DATA_DIR = process.env.DATA_DIR || '/data';
const CONFIG_PATH = `${DATA_DIR}/config.json`;

export class ConfigStore {
  private config: VaultConfig | null = null;
  private storageMode: StorageMode | null = null;

  /** Check if an instance has been initialized */
  isInitialized(): boolean {
    if (this.config) return true;
    return existsSync(CONFIG_PATH);
  }

  /** Initialize a new instance. Called once from the install wizard. */
  init(network: NetworkName, storageMode: StorageMode, password?: string): void {
    if (this.isInitialized()) throw new Error('Already initialized');
    this.config = defaultConfig(network, storageMode);
    this.storageMode = storageMode;
    this.persist(password);
  }

  /** Load config from disk. For encrypted-persistent, requires password. */
  load(password?: string): VaultConfig {
    if (this.config) return this.config;
    if (!existsSync(CONFIG_PATH)) throw new Error('Not initialized');

    const raw = readFileSync(CONFIG_PATH, 'utf8');

    // Try parsing as plaintext JSON first
    try {
      this.config = JSON.parse(raw) as VaultConfig;
      this.storageMode = this.config.storageMode;
      return this.config;
    } catch {
      // Not JSON — must be encrypted
    }

    if (!password) throw new Error('Password required to unlock');
    const decrypted = decryptConfig(raw, password);
    this.config = JSON.parse(decrypted) as VaultConfig;
    this.storageMode = this.config.storageMode;
    return this.config;
  }

  /** Get current config (must be loaded first). */
  get(): VaultConfig {
    if (!this.config) throw new Error('Config not loaded');
    return this.config;
  }

  /** Update config fields and persist. */
  update(patch: Partial<VaultConfig>, password?: string): VaultConfig {
    if (!this.config) throw new Error('Config not loaded');
    this.config = { ...this.config, ...patch };
    if (this.storageMode !== 'encrypted-portable') {
      this.persist(password);
    }
    return this.config;
  }

  /** Import a portable config (decrypted by frontend, sent as JSON). */
  importPortable(config: VaultConfig): void {
    this.config = config;
    this.storageMode = 'encrypted-portable';
    // Do NOT persist to disk — portable mode is memory-only
  }

  /** Export current config as JSON string (frontend will encrypt). */
  exportConfig(): string {
    if (!this.config) throw new Error('Config not loaded');
    return JSON.stringify(this.config);
  }

  /** Wipe all data. */
  reset(): void {
    this.config = null;
    this.storageMode = null;
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  }

  private persist(password?: string): void {
    if (!this.config) return;
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    const json = JSON.stringify(this.config, null, 2);

    if (this.config.storageMode === 'encrypted-persistent') {
      if (!password) throw new Error('Password required for encrypted-persistent mode');
      writeFileSync(CONFIG_PATH, encryptConfig(json, password));
    } else if (this.config.storageMode === 'persistent') {
      writeFileSync(CONFIG_PATH, json);
    }
    // encrypted-portable: never write to disk
  }
}
```

- [ ] **Step 4: Verify compilation**

```bash
cd backend && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/
git commit -m "feat: config store with 3 storage modes + encryption"
```

---

### Task 3: Express Server + Config Routes

**Files:**
- Create: `backend/src/server.ts`
- Create: `backend/src/routes/config.ts`

- [ ] **Step 1: Create config routes**

Create `backend/src/routes/config.ts`:

```typescript
import { Router, type Request, type Response } from 'express';
import { ConfigStore } from '../lib/config-store.js';
import { sanitizeConfig, type NetworkName, type StorageMode } from '../lib/types.js';

export function configRoutes(store: ConfigStore): Router {
  const r = Router();

  /** GET /api/status — returns setup state + storage mode */
  r.get('/status', (_req: Request, res: Response) => {
    if (!store.isInitialized()) {
      res.json({ state: 'fresh' });
      return;
    }
    try {
      const config = store.get();
      const { setupState, storageMode, network } = config;
      const walletConfigured = !!config.wallet;
      res.json({ state: 'ready', setupState, storageMode, network, walletConfigured });
    } catch {
      // Initialized but not loaded (encrypted-persistent, needs unlock)
      res.json({ state: 'locked' });
    }
  });

  /** POST /api/init — first-time setup */
  r.post('/init', (req: Request, res: Response) => {
    const { network, storageMode, password } = req.body as {
      network: NetworkName;
      storageMode: StorageMode;
      password?: string;
    };
    if (!network || !storageMode) {
      res.status(400).json({ error: 'network and storageMode required' });
      return;
    }
    if (storageMode === 'encrypted-persistent' && !password) {
      res.status(400).json({ error: 'password required for encrypted-persistent mode' });
      return;
    }
    try {
      store.init(network, storageMode, password);
      res.json({ ok: true });
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
    }
  });

  /** POST /api/unlock — decrypt encrypted-persistent config */
  r.post('/unlock', (req: Request, res: Response) => {
    const { password } = req.body as { password: string };
    if (!password) {
      res.status(400).json({ error: 'password required' });
      return;
    }
    try {
      store.load(password);
      const config = store.get();
      res.json({ ok: true, config: sanitizeConfig(config) });
    } catch (e) {
      res.status(401).json({ error: 'Wrong password or corrupted config' });
    }
  });

  /** GET /api/config — sanitized config (no private keys) */
  r.get('/config', (_req: Request, res: Response) => {
    try {
      res.json(sanitizeConfig(store.get()));
    } catch (e) {
      res.status(503).json({ error: (e as Error).message });
    }
  });

  /** POST /api/config/contracts — update contract configuration */
  r.post('/config/contracts', (req: Request, res: Response) => {
    const { contracts } = req.body;
    if (!Array.isArray(contracts)) {
      res.status(400).json({ error: 'contracts must be an array' });
      return;
    }
    try {
      store.update({ contracts });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** POST /api/config/export — export config for portable mode */
  r.post('/config/export', (_req: Request, res: Response) => {
    try {
      res.json({ config: store.exportConfig() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** POST /api/config/import — import portable config (decrypted by frontend) */
  r.post('/config/import', (req: Request, res: Response) => {
    const { config } = req.body;
    if (!config) {
      res.status(400).json({ error: 'config required' });
      return;
    }
    try {
      store.importPortable(typeof config === 'string' ? JSON.parse(config) : config);
      res.json({ ok: true, config: sanitizeConfig(store.get()) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  /** POST /api/dkg/save — save DKG ceremony result */
  r.post('/dkg/save', (req: Request, res: Response) => {
    const { threshold, parties, level, combinedPubKey, shareData } = req.body;
    try {
      const config = store.get();
      store.update({
        permafrost: { threshold, parties, level, combinedPubKey, shareData },
        setupState: { ...config.setupState, dkgComplete: true },
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** POST /api/reset — wipe everything */
  r.post('/reset', (req: Request, res: Response) => {
    const { confirm } = req.body as { confirm: string };
    if (confirm !== 'RESET') {
      res.status(400).json({ error: 'Send { confirm: "RESET" } to confirm' });
      return;
    }
    store.reset();
    res.json({ ok: true });
  });

  return r;
}
```

- [ ] **Step 2: Create the Express server**

Create `backend/src/server.ts`:

```typescript
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './lib/config-store.js';
import { configRoutes } from './routes/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8080', 10);
const RELAY_PORT = parseInt(process.env.RELAY_PORT || '8081', 10);

const store = new ConfigStore();
const app = express();

app.use(express.json({ limit: '10mb' }));

// Try to auto-load persistent config on startup
try { store.load(); } catch { /* not initialized or encrypted — that's fine */ }

// API routes
app.use('/api', configRoutes(store));

// Proxy WebSocket to relay
app.use(
  '/ws',
  createProxyMiddleware({
    target: `http://127.0.0.1:${RELAY_PORT}`,
    ws: true,
    changeOrigin: true,
  }),
);

// Serve frontend static files
const distDir = join(__dirname, '..', 'dist');
app.use(express.static(distDir));
app.get('*', (_req, res) => {
  res.sendFile(join(distDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`permafrost-vault backend listening on :${PORT}`);
});

// Export for route registration by other modules
export { store };
```

- [ ] **Step 3: Verify compilation**

```bash
cd backend && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/server.ts backend/src/routes/config.ts
git commit -m "feat: Express server with config API routes and WS proxy"
```

---

### Task 4: OPNet Client + Wallet Routes

**Files:**
- Create: `backend/src/lib/opnet-client.ts`
- Create: `backend/src/routes/wallet.ts`

- [ ] **Step 1: Create OPNet client wrapper**

Create `backend/src/lib/opnet-client.ts`:

```typescript
import { networks, type Network } from '@btc-vision/bitcoin';
import { Mnemonic, MLDSASecurityLevel } from '@btc-vision/transaction';
import { JSONRpcProvider } from 'opnet';
import type { NetworkName } from './types.js';

const RPC_URLS: Record<NetworkName, string> = {
  testnet: 'https://testnet.opnet.org',
  mainnet: 'https://mainnet.opnet.org',
};

export function getNetwork(name: NetworkName): Network {
  return name === 'mainnet' ? networks.bitcoin : networks.opnetTestnet;
}

export function getProvider(networkName: NetworkName): JSONRpcProvider {
  const network = getNetwork(networkName);
  return new JSONRpcProvider(RPC_URLS[networkName], network);
}

export function generateWallet(mnemonic: string, networkName: NetworkName) {
  const network = getNetwork(networkName);
  const m = new Mnemonic(mnemonic, '', network, MLDSASecurityLevel.LEVEL2);
  const wallet = m.deriveOPWallet(undefined, 0, 0, false);
  return { mnemonic: m, wallet };
}

export function generateMnemonic(): string {
  // Use BIP39 mnemonic generation from @btc-vision/transaction
  return Mnemonic.generate();
}
```

Note: The exact `Mnemonic.generate()` API may differ — check the `@btc-vision/transaction` package. If it doesn't have a static generate method, use `bip39` package or the underlying entropy generation.

- [ ] **Step 2: Create wallet routes**

Create `backend/src/routes/wallet.ts`:

```typescript
import { Router, type Request, type Response } from 'express';
import { ConfigStore } from '../lib/config-store.js';
import { generateWallet, generateMnemonic, getProvider } from '../lib/opnet-client.js';
import { sanitizeConfig } from '../lib/types.js';

export function walletRoutes(store: ConfigStore): Router {
  const r = Router();

  /** POST /api/wallet/generate — create BTC keypair, save to config */
  r.post('/generate', (req: Request, res: Response) => {
    try {
      const config = store.get();
      const phrase = generateMnemonic();
      const { wallet, mnemonic } = generateWallet(phrase, config.network);

      store.update({
        wallet: {
          mnemonic: phrase,
          p2tr: wallet.p2tr,
          tweakedPubKey: Buffer.from(wallet.tweakedPubKeyKey).toString('hex'),
          publicKey: Buffer.from(wallet.publicKey).toString('hex'),
        },
        setupState: { ...config.setupState, walletSkipped: false },
      });

      // Cleanup sensitive material
      mnemonic.zeroize();
      wallet.zeroize();

      const updated = store.get();
      res.json({ ok: true, config: sanitizeConfig(updated) });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** POST /api/wallet/skip — mark wallet as skipped */
  r.post('/skip', (req: Request, res: Response) => {
    const { dontShowAgain } = req.body as { dontShowAgain?: boolean };
    try {
      const config = store.get();
      store.update({
        setupState: {
          ...config.setupState,
          walletSkipped: true,
          walletDontShowAgain: dontShowAgain ?? false,
        },
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** GET /api/wallet/balance — BTC balance in satoshis */
  r.get('/balance', async (req: Request, res: Response) => {
    try {
      const config = store.get();
      if (!config.wallet) {
        res.json({ balance: 0, configured: false });
        return;
      }
      const provider = getProvider(config.network);
      const balance = await provider.getBalance(config.wallet.p2tr, true);
      res.json({ balance: balance.toString(), configured: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return r;
}
```

- [ ] **Step 3: Register wallet routes in server.ts**

Add to `backend/src/server.ts` after the configRoutes line:

```typescript
import { walletRoutes } from './routes/wallet.js';
// ... in route registration:
app.use('/api/wallet', walletRoutes(store));
```

- [ ] **Step 4: Verify compilation**

```bash
cd backend && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/opnet-client.ts backend/src/routes/wallet.ts backend/src/server.ts
git commit -m "feat: OPNet client wrapper and wallet generation routes"
```

---

### Task 5: ThresholdMLDSASigner + TX Routes

**Files:**
- Create: `backend/src/lib/threshold-signer.ts`
- Create: `backend/src/routes/tx.ts`
- Create: `backend/src/routes/balances.ts`

- [ ] **Step 1: Create ThresholdMLDSASigner adapter**

Create `backend/src/lib/threshold-signer.ts`:

This adapter implements `QuantumBIP32Interface` and wraps a pre-computed threshold ML-DSA signature so the OPNet SDK can use it during `sendTransaction()`.

```typescript
/**
 * Adapter that wraps a pre-computed threshold ML-DSA signature
 * to satisfy the QuantumBIP32Interface expected by the OPNet SDK.
 *
 * When the SDK calls sign(), it returns the pre-computed signature
 * rather than computing a new one.
 */
export class ThresholdMLDSASigner {
  constructor(
    private readonly precomputedSignature: Uint8Array,
    private readonly mldsaPublicKey: Uint8Array,
  ) {}

  sign(_message: Uint8Array): Uint8Array {
    return this.precomputedSignature;
  }

  getPublicKey(): Uint8Array {
    return this.mldsaPublicKey;
  }

  // Stubs for unused QuantumBIP32Interface methods
  derive(): ThresholdMLDSASigner { throw new Error('derive not supported on ThresholdMLDSASigner'); }
  deriveHardened(): ThresholdMLDSASigner { throw new Error('deriveHardened not supported'); }
  derivePath(): ThresholdMLDSASigner { throw new Error('derivePath not supported'); }
}
```

Note: Check the exact `QuantumBIP32Interface` definition in `@btc-vision/transaction` to ensure all required methods are implemented. The adapter only needs `sign()` and `getPublicKey()` to work — other methods can throw since they won't be called during `sendTransaction()`.

- [ ] **Step 2: Create TX routes**

Create `backend/src/routes/tx.ts`:

```typescript
import { Router, type Request, type Response } from 'express';
import { ConfigStore } from '../lib/config-store.js';
import { getProvider, getNetwork, generateWallet } from '../lib/opnet-client.js';
import { ThresholdMLDSASigner } from '../lib/threshold-signer.js';
import { getContract, OP_20_ABI } from 'opnet';

export function txRoutes(store: ConfigStore): Router {
  const r = Router();

  /** POST /api/tx/encode — encode calldata from method + params */
  r.post('/encode', async (req: Request, res: Response) => {
    const { method, params, paramTypes } = req.body as {
      method: string;
      params: string[];
      paramTypes: Array<'address' | 'u256' | 'bytes'>;
    };
    try {
      // Compute 4-byte selector: SHA256(methodName) first 4 bytes
      const { BinaryWriter } = await import('@btc-vision/transaction');
      const selectorInput = new TextEncoder().encode(method);
      const { createHash } = await import('node:crypto');
      const selectorHash = createHash('sha256').update(selectorInput).digest();
      const selector = selectorHash.subarray(0, 4);

      const writer = new BinaryWriter();
      writer.writeBytes(selector);

      for (let i = 0; i < params.length; i++) {
        const value = params[i]!;
        const type = paramTypes[i]!;
        if (type === 'address') {
          // Address is 32 bytes (SHA256 of ML-DSA pubkey or tweaked pubkey)
          const addrBytes = Buffer.from(value.replace(/^0x/, ''), 'hex');
          writer.writeBytes(addrBytes);
        } else if (type === 'u256') {
          writer.writeU256(BigInt(value));
        } else {
          writer.writeBytes(Buffer.from(value.replace(/^0x/, ''), 'hex'));
        }
      }

      const calldata = writer.getBuffer();
      const calldataHex = Buffer.from(calldata).toString('hex');

      // Compute message hash for display
      const msgHash = createHash('sha256').update(calldata).digest('hex');

      res.json({ calldata: calldataHex, messageHash: msgHash });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  /** POST /api/tx/simulate — simulate a contract call */
  r.post('/simulate', async (req: Request, res: Response) => {
    const { contract: contractAddr, method, params, abi } = req.body;
    try {
      const config = store.get();
      const provider = getProvider(config.network);
      const network = getNetwork(config.network);
      const contractAbi = abi || OP_20_ABI;

      const contract = getContract(contractAddr, contractAbi, provider, network);
      const fn = (contract as Record<string, Function>)[method];
      if (!fn) {
        res.status(400).json({ error: `Method '${method}' not found on contract` });
        return;
      }

      const result = await fn.call(contract, ...params);
      if (result.revert) {
        res.json({ success: false, revert: result.revert });
        return;
      }

      res.json({
        success: true,
        estimatedGas: result.estimatedGas?.toString(),
        events: result.events,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** POST /api/tx/broadcast — build tx with ML-DSA sig and broadcast */
  r.post('/broadcast', async (req: Request, res: Response) => {
    const { contract: contractAddr, method, params, abi, signature, messageHash } = req.body;
    try {
      const config = store.get();
      if (!config.wallet) {
        res.status(400).json({ error: 'No wallet configured' });
        return;
      }
      if (!config.permafrost) {
        res.status(400).json({ error: 'No DKG ceremony completed' });
        return;
      }

      const provider = getProvider(config.network);
      const network = getNetwork(config.network);
      const contractAbi = abi || OP_20_ABI;

      // Reconstruct wallet from mnemonic
      const { wallet, mnemonic } = generateWallet(config.wallet.mnemonic, config.network);

      // Create contract and simulate
      const sender = wallet.address;
      const contract = getContract(contractAddr, contractAbi, provider, network, sender);
      const fn = (contract as Record<string, Function>)[method];
      if (!fn) {
        mnemonic.zeroize();
        wallet.zeroize();
        res.status(400).json({ error: `Method '${method}' not found` });
        return;
      }

      const callResult = await fn.call(contract, ...params);
      if (callResult.revert) {
        mnemonic.zeroize();
        wallet.zeroize();
        res.status(400).json({ error: `Simulation reverted: ${callResult.revert}` });
        return;
      }

      // Obtain challenge solution (PoW required by OPNet)
      const challenge = await provider.getChallenge();

      // Create ThresholdMLDSASigner with pre-computed signature
      const sigBytes = Buffer.from(signature, 'hex');
      const pubKeyBytes = Buffer.from(config.permafrost.combinedPubKey, 'hex');
      const thresholdSigner = new ThresholdMLDSASigner(sigBytes, pubKeyBytes);

      // Send transaction
      const receipt = await callResult.sendTransaction({
        signer: wallet.keypair,
        mldsaSigner: thresholdSigner,
        refundTo: config.wallet.p2tr,
        network,
        feeRate: 10,
        priorityFee: 1000n,
        maximumAllowedSatToSpend: 100000n,
        challenge,
      });

      mnemonic.zeroize();
      wallet.zeroize();

      res.json({
        success: true,
        transactionId: receipt.transactionId,
        estimatedFees: receipt.estimatedFees?.toString(),
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return r;
}
```

- [ ] **Step 3: Create balances route**

Create `backend/src/routes/balances.ts`:

```typescript
import { Router, type Request, type Response } from 'express';
import { ConfigStore } from '../lib/config-store.js';
import { getProvider, getNetwork } from '../lib/opnet-client.js';
import { getContract, OP_20_ABI } from 'opnet';
import { Address } from '@btc-vision/transaction';

export function balanceRoutes(store: ConfigStore): Router {
  const r = Router();

  /** GET /api/balances — OP-20 token balances for the Permafrost address */
  r.get('/', async (_req: Request, res: Response) => {
    try {
      const config = store.get();
      if (!config.permafrost || !config.wallet) {
        res.json({ balances: [] });
        return;
      }

      const provider = getProvider(config.network);
      const network = getNetwork(config.network);

      // Derive the OPNet address from DKG pubkey + wallet tweaked pubkey
      const opnetAddr = Address.fromString(
        config.permafrost.combinedPubKey,
        config.wallet.tweakedPubKey,
      );

      const balances: Array<{ address: string; name: string; symbol: string; balance: string }> = [];

      for (const c of config.contracts) {
        try {
          const contract = getContract(c.address, OP_20_ABI, provider, network);
          const [nameResult, symbolResult, balResult] = await Promise.all([
            (contract as any).name(),
            (contract as any).symbol(),
            (contract as any).balanceOf(opnetAddr),
          ]);
          balances.push({
            address: c.address,
            name: nameResult.properties.name,
            symbol: symbolResult.properties.symbol,
            balance: balResult.properties.balance.toString(),
          });
        } catch {
          // Skip contracts that fail (might not be OP-20)
        }
      }

      res.json({ balances });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return r;
}
```

- [ ] **Step 4: Register all routes in server.ts**

Update `backend/src/server.ts` to import and register:

```typescript
import { txRoutes } from './routes/tx.js';
import { balanceRoutes } from './routes/balances.js';
// ... after other routes:
app.use('/api/tx', txRoutes(store));
app.use('/api/balances', balanceRoutes(store));
```

- [ ] **Step 5: Verify compilation**

```bash
cd backend && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/
git commit -m "feat: TX broadcast with ThresholdMLDSASigner + balance routes"
```

---

## Chunk 2: Frontend Libraries

### Task 6: Copy Signing Libraries from Cabal

**Files:**
- Create: `src/lib/threshold.ts` (copy from `~/projects/od/cabal/src/lib/threshold.ts`)
- Create: `src/lib/share-crypto.ts` (copy from `~/projects/od/cabal/src/lib/share-crypto.ts`)

- [ ] **Step 1: Copy threshold.ts**

```bash
cp ~/projects/od/cabal/src/lib/threshold.ts src/lib/threshold.ts
```

This file is generic — no OD-specific imports. No modifications needed.

Key exports: `createSession()`, `round1()`, `round2()`, `round3()`, `combine()`, `addBlob()`, `decodeBlob()`, `destroySession()`, `toHex()`, `fromHex()`.

- [ ] **Step 2: Copy share-crypto.ts**

```bash
cp ~/projects/od/cabal/src/lib/share-crypto.ts src/lib/share-crypto.ts
```

This file is generic. No modifications needed.

Key exports: `decrypt()`, `decryptShareFile()`, `deserializeKeyShare()`, types `ShareFile`, `DecryptedShare`.

- [ ] **Step 3: Verify build still works**

```bash
npm run build
```

Expected: Build succeeds (these files aren't imported yet, but should compile).

- [ ] **Step 4: Commit**

```bash
git add src/lib/threshold.ts src/lib/share-crypto.ts
git commit -m "feat: copy threshold signing + share decryption from cabal"
```

---

### Task 7: Frontend API Client

**Files:**
- Create: `src/lib/api.ts`

- [ ] **Step 1: Create API client**

Create `src/lib/api.ts`:

```typescript
/**
 * Frontend API client for the PERMAFROST Vault backend.
 * All methods call /api/* endpoints on the same origin.
 */

import type { VaultConfig, NetworkName, StorageMode, ContractConfig } from './vault-types.js';

const BASE = '/api';

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

// ── Status ──

export interface StatusResponse {
  state: 'fresh' | 'locked' | 'ready';
  setupState?: VaultConfig['setupState'];
  storageMode?: StorageMode;
  network?: NetworkName;
  walletConfigured?: boolean;
}

export const getStatus = () => json<StatusResponse>('/status');

// ── Init ──

export const initInstance = (network: NetworkName, storageMode: StorageMode, password?: string) =>
  json<{ ok: true }>('/init', {
    method: 'POST',
    body: JSON.stringify({ network, storageMode, password }),
  });

// ── Unlock ──

export const unlock = (password: string) =>
  json<{ ok: true; config: VaultConfig }>('/unlock', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });

// ── Config ──

export const getConfig = () => json<VaultConfig>('/config');

export const updateContracts = (contracts: ContractConfig[]) =>
  json<{ ok: true }>('/config/contracts', {
    method: 'POST',
    body: JSON.stringify({ contracts }),
  });

export const exportConfig = () => json<{ config: string }>('/config/export', { method: 'POST' });

export const importConfig = (config: VaultConfig) =>
  json<{ ok: true; config: VaultConfig }>('/config/import', {
    method: 'POST',
    body: JSON.stringify({ config }),
  });

// ── Wallet ──

export const generateWallet = () =>
  json<{ ok: true; config: VaultConfig }>('/wallet/generate', { method: 'POST' });

export const skipWallet = (dontShowAgain: boolean) =>
  json<{ ok: true }>('/wallet/skip', {
    method: 'POST',
    body: JSON.stringify({ dontShowAgain }),
  });

export const getWalletBalance = () =>
  json<{ balance: string; configured: boolean }>('/wallet/balance');

// ── DKG ──

export const saveDKG = (data: {
  threshold: number;
  parties: number;
  level: number;
  combinedPubKey: string;
  shareData: string;
}) =>
  json<{ ok: true }>('/dkg/save', {
    method: 'POST',
    body: JSON.stringify(data),
  });

// ── Balances ──

export const getBalances = () =>
  json<{ balances: Array<{ address: string; name: string; symbol: string; balance: string }> }>('/balances');

// ── TX ──

export const encodeTx = (method: string, params: string[], paramTypes: Array<'address' | 'u256' | 'bytes'>) =>
  json<{ calldata: string; messageHash: string }>('/tx/encode', {
    method: 'POST',
    body: JSON.stringify({ method, params, paramTypes }),
  });

export const simulateTx = (contract: string, method: string, params: unknown[], abi?: unknown[]) =>
  json<{ success: boolean; revert?: string; estimatedGas?: string }>('/tx/simulate', {
    method: 'POST',
    body: JSON.stringify({ contract, method, params, abi }),
  });

export const broadcastTx = (data: {
  contract: string;
  method: string;
  params: unknown[];
  abi?: unknown[];
  signature: string;
  messageHash: string;
}) =>
  json<{ success: boolean; transactionId?: string; estimatedFees?: string; error?: string }>('/tx/broadcast', {
    method: 'POST',
    body: JSON.stringify(data),
  });

// ── Reset ──

export const resetInstance = () =>
  json<{ ok: true }>('/reset', {
    method: 'POST',
    body: JSON.stringify({ confirm: 'RESET' }),
  });
```

- [ ] **Step 2: Create shared vault types for frontend**

Create `src/lib/vault-types.ts`:

```typescript
/** Shared types used by both the API client and frontend components. */

export type StorageMode = 'persistent' | 'encrypted-persistent' | 'encrypted-portable';
export type NetworkName = 'testnet' | 'mainnet';

export interface SetupState {
  wizardComplete: boolean;
  walletSkipped: boolean;
  walletDontShowAgain: boolean;
  dkgComplete: boolean;
}

export interface WalletPublic {
  p2tr: string;
  tweakedPubKey: string;
  publicKey: string;
  // Note: mnemonic is NEVER sent to frontend
}

export interface PermafrostConfig {
  threshold: number;
  parties: number;
  level: number;
  combinedPubKey: string;
  shareData: string;
}

export interface ContractConfig {
  name: string;
  address: string;
  abi: unknown[];
  methods: string[];
}

export interface VaultConfig {
  version: number;
  network: NetworkName;
  storageMode: StorageMode;
  setupState: SetupState;
  wallet?: WalletPublic;
  permafrost?: PermafrostConfig;
  contracts: ContractConfig[];
}
```

- [ ] **Step 3: Verify build**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/api.ts src/lib/vault-types.ts
git commit -m "feat: frontend API client + shared vault types"
```

---

### Task 8: OP-20 Method Definitions

**Files:**
- Create: `src/lib/op20-methods.ts`

- [ ] **Step 1: Create OP-20 method definitions**

Create `src/lib/op20-methods.ts`:

```typescript
/**
 * Standard OP-20 contract method definitions for the signing page.
 * These are the methods available on any OP-20 token contract.
 */

export type ParamType = 'address' | 'u256' | 'bytes';

export interface MethodParam {
  name: string;
  type: ParamType;
  placeholder?: string;
}

export interface MethodDef {
  name: string;
  label: string;
  params: MethodParam[];
}

export const OP20_METHODS: MethodDef[] = [
  {
    name: 'transfer',
    label: 'Transfer',
    params: [
      { name: 'to', type: 'address', placeholder: '0x... or opt1...' },
      { name: 'amount', type: 'u256', placeholder: 'Amount (smallest unit)' },
    ],
  },
  {
    name: 'transferFrom',
    label: 'Transfer From',
    params: [
      { name: 'from', type: 'address', placeholder: 'From address' },
      { name: 'to', type: 'address', placeholder: 'To address' },
      { name: 'amount', type: 'u256', placeholder: 'Amount (smallest unit)' },
    ],
  },
  {
    name: 'approve',
    label: 'Approve',
    params: [
      { name: 'spender', type: 'address', placeholder: 'Spender address' },
      { name: 'amount', type: 'u256', placeholder: 'Amount (smallest unit)' },
    ],
  },
  {
    name: 'increaseAllowance',
    label: 'Increase Allowance',
    params: [
      { name: 'spender', type: 'address', placeholder: 'Spender address' },
      { name: 'amount', type: 'u256', placeholder: 'Amount to increase' },
    ],
  },
  {
    name: 'decreaseAllowance',
    label: 'Decrease Allowance',
    params: [
      { name: 'spender', type: 'address', placeholder: 'Spender address' },
      { name: 'amount', type: 'u256', placeholder: 'Amount to decrease' },
    ],
  },
  {
    name: 'burn',
    label: 'Burn',
    params: [
      { name: 'amount', type: 'u256', placeholder: 'Amount to burn' },
    ],
  },
  {
    name: 'mint',
    label: 'Mint',
    params: [
      { name: 'address', type: 'address', placeholder: 'Recipient address' },
      { name: 'amount', type: 'u256', placeholder: 'Amount to mint' },
    ],
  },
];
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/op20-methods.ts
git commit -m "feat: standard OP-20 method definitions for signing page"
```

---

## Chunk 3: Frontend Components — Setup Flow

### Task 9: App.tsx State-Driven Routing

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Rewrite App.tsx with state-driven view routing**

Replace the contents of `src/App.tsx`:

```typescript
import { useState, useEffect, useCallback } from 'react';
import { InstallWizard } from './components/InstallWizard';
import { WalletSetup } from './components/WalletSetup';
import { DKGWizard } from './components/DKGWizard';
import { SigningPage } from './components/SigningPage';
import { Settings } from './components/Settings';
import { getStatus, type StatusResponse } from './lib/api';
import type { VaultConfig } from './lib/vault-types';
import './styles/global.css';
import './styles/ceremony.css';

type View = 'loading' | 'wizard' | 'unlock' | 'wallet' | 'dkg' | 'signing' | 'settings';

export function App() {
  const [view, setView] = useState<View>('loading');

  const checkStatus = useCallback(async () => {
    try {
      const status = await getStatus();
      if (status.state === 'fresh') {
        setView('wizard');
      } else if (status.state === 'locked') {
        setView('unlock');
      } else if (status.setupState) {
        if (!status.setupState.walletSkipped && !status.walletConfigured && !status.setupState.walletDontShowAgain) {
          setView('wallet');
        } else if (!status.setupState.dkgComplete) {
          setView('dkg');
        } else {
          setView('signing');
        }
      }
    } catch (e) {
      console.error('Failed to check status:', e);
      setView('wizard'); // fallback to wizard on error
    }
  }, []);

  useEffect(() => { checkStatus(); }, [checkStatus]);

  const handleSetupComplete = useCallback(() => { checkStatus(); }, [checkStatus]);

  if (view === 'loading') {
    return <div className="ceremony"><div className="spinner" /></div>;
  }

  if (view === 'wizard') {
    return <InstallWizard onComplete={handleSetupComplete} />;
  }

  if (view === 'unlock') {
    return <UnlockScreen onUnlocked={handleSetupComplete} />;
  }

  if (view === 'wallet') {
    return <WalletSetup onComplete={handleSetupComplete} />;
  }

  if (view === 'dkg') {
    return <DKGWizard onComplete={handleSetupComplete} />;
  }

  if (view === 'settings') {
    return <Settings onBack={() => setView('signing')} />;
  }

  return <SigningPage onSettings={() => setView('settings')} />;
}

/** Simple unlock screen for encrypted-persistent mode */
function UnlockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleUnlock = async () => {
    setLoading(true);
    setError('');
    try {
      const { unlock } = await import('./lib/api');
      await unlock(password);
      onUnlocked();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="ceremony">
      <h1>PERMAFROST Vault</h1>
      <p className="subtitle">Enter your password to unlock</p>
      <div className="card">
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Password"
          onKeyDown={e => e.key === 'Enter' && handleUnlock()}
          style={{ width: '100%', marginBottom: 16 }}
        />
        {error && <div className="warning">{error}</div>}
        <button className="btn btn-primary btn-full" onClick={handleUnlock} disabled={loading || !password}>
          {loading ? <span className="spinner" /> : 'Unlock'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/App.tsx
git commit -m "feat: state-driven view routing in App.tsx"
```

Note: This won't build yet because the imported components don't exist. They'll be created in subsequent tasks.

---

### Task 10: InstallWizard Component

**Files:**
- Create: `src/components/InstallWizard.tsx`

- [ ] **Step 1: Create InstallWizard**

Create `src/components/InstallWizard.tsx`:

```typescript
import { useState } from 'react';
import { initInstance } from '../lib/api';
import type { NetworkName, StorageMode } from '../lib/vault-types';

interface Props {
  onComplete: () => void;
}

export function InstallWizard({ onComplete }: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [network, setNetwork] = useState<NetworkName>('testnet');
  const [storageMode, setStorageMode] = useState<StorageMode>('persistent');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleInit = async () => {
    if (storageMode === 'encrypted-persistent') {
      if (!password) { setError('Password required'); return; }
      if (password !== passwordConfirm) { setError('Passwords do not match'); return; }
    }
    setLoading(true);
    setError('');
    try {
      await initInstance(
        network,
        storageMode,
        storageMode === 'encrypted-persistent' ? password : undefined,
      );
      onComplete();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="ceremony">
      <h1>PERMAFROST Vault</h1>
      <p className="subtitle">First-time setup</p>

      <div className="steps">
        <div className={`step-dot ${step >= 1 ? 'active' : ''}`} />
        <div className={`step-dot ${step >= 2 ? 'active' : ''}`} />
      </div>

      {step === 1 && (
        <div className="card">
          <h2>Network</h2>
          <p>Select the OPNet network this instance will operate on.</p>
          <div className="form-row">
            <label>
              Network
              <select value={network} onChange={e => setNetwork(e.target.value as NetworkName)}>
                <option value="testnet">Testnet</option>
                <option value="mainnet">Mainnet</option>
              </select>
            </label>
          </div>
          <button className="btn btn-primary btn-full" onClick={() => setStep(2)}>
            Next
          </button>
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <h2>Storage Mode</h2>
          <p>How should this instance store sensitive data (wallet keys, DKG shares)?</p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
            {([
              ['persistent', 'Persistent', 'Plaintext on server. Fast access, trusted environment.'],
              ['encrypted-persistent', 'Encrypted Persistent', 'Encrypted on server. Password required on each startup.'],
              ['encrypted-portable', 'Encrypted Portable', 'Download encrypted config file. Upload + password each session.'],
            ] as const).map(([value, label, desc]) => (
              <label
                key={value}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 12, padding: 12,
                  background: storageMode === value ? 'var(--accent-dim)' : 'var(--bg-raised)',
                  borderRadius: 'var(--radius)', cursor: 'pointer',
                  border: storageMode === value ? '1px solid var(--accent)' : '1px solid rgba(237,239,242,0.06)',
                }}
              >
                <input
                  type="radio"
                  name="storageMode"
                  value={value}
                  checked={storageMode === value}
                  onChange={() => setStorageMode(value)}
                  style={{ marginTop: 4 }}
                />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{label}</div>
                  <div style={{ fontSize: 13, color: 'var(--white-dim)' }}>{desc}</div>
                </div>
              </label>
            ))}
          </div>

          {storageMode === 'encrypted-persistent' && (
            <div style={{ marginBottom: 16 }}>
              <div className="form-row">
                <label>
                  Password
                  <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Choose a strong password" />
                </label>
              </div>
              <div className="form-row">
                <label>
                  Confirm Password
                  <input type="password" value={passwordConfirm} onChange={e => setPasswordConfirm(e.target.value)} placeholder="Confirm password" />
                </label>
              </div>
            </div>
          )}

          {error && <div className="warning">{error}</div>}

          <div style={{ display: 'flex', gap: 12 }}>
            <button className="btn btn-secondary" onClick={() => setStep(1)}>Back</button>
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleInit} disabled={loading}>
              {loading ? <span className="spinner" /> : 'Initialize'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/InstallWizard.tsx
git commit -m "feat: InstallWizard component (network + storage mode)"
```

---

### Task 11: WalletSetup Component

**Files:**
- Create: `src/components/WalletSetup.tsx`

- [ ] **Step 1: Create WalletSetup**

Create `src/components/WalletSetup.tsx`:

```typescript
import { useState } from 'react';
import { generateWallet, skipWallet } from '../lib/api';

interface Props {
  onComplete: () => void;
}

export function WalletSetup({ onComplete }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [p2tr, setP2tr] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [dontShow, setDontShow] = useState(false);

  const handleGenerate = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await generateWallet();
      // The backend generates the wallet and returns the config (sans mnemonic).
      // We need a separate endpoint or the backend response to include
      // the mnemonic ONE TIME for backup display.
      // For now, the config response has the p2tr address.
      setP2tr(result.config.wallet?.p2tr ?? null);
      // TODO: Backend should return mnemonic once for display
      setMnemonic('(Mnemonic will be shown here — backend needs to return it once)');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleSkip = async () => {
    setLoading(true);
    try {
      await skipWallet(dontShow);
      onComplete();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="ceremony">
      <h1>PERMAFROST Vault</h1>
      <p className="subtitle">Wallet Setup</p>

      {!mnemonic ? (
        <div className="card">
          <h2>Generate BTC Wallet</h2>
          <p>
            Generate a BTC keypair for this instance. This wallet will be used to fund
            and broadcast OPNet transactions. The ML-DSA key for signing comes from the
            DKG ceremony (next step).
          </p>
          <p>
            If you skip this, the signing page will display signatures for manual copying
            but cannot broadcast transactions.
          </p>

          {error && <div className="warning">{error}</div>}

          <button className="btn btn-primary btn-full" onClick={handleGenerate} disabled={loading} style={{ marginBottom: 12 }}>
            {loading ? <span className="spinner" /> : 'Generate Wallet'}
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <input
              type="checkbox"
              id="dontShow"
              checked={dontShow}
              onChange={e => setDontShow(e.target.checked)}
            />
            <label htmlFor="dontShow" style={{ fontSize: 13, color: 'var(--white-dim)', cursor: 'pointer' }}>
              Don't show this again
            </label>
          </div>

          <button className="btn btn-secondary btn-full" onClick={handleSkip} disabled={loading}>
            Skip for now
          </button>
        </div>
      ) : (
        <div className="card">
          <h2>Backup Your Mnemonic</h2>
          <div className="warning">
            Write down these words and store them securely. This is the ONLY time they will be shown.
          </div>
          <div className="pubkey-display" style={{ fontSize: 15, lineHeight: 1.8 }}>
            {mnemonic}
          </div>
          {p2tr && (
            <>
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>P2TR Address</h3>
              <div className="pubkey-display">{p2tr}</div>
              <p>Fund this address with BTC to pay for transaction fees.</p>
            </>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, cursor: 'pointer' }}>
            <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
            <span style={{ fontSize: 13 }}>I have written down and securely stored my mnemonic</span>
          </label>
          <button className="btn btn-primary btn-full" onClick={onComplete} disabled={!confirmed}>
            Continue to DKG Ceremony
          </button>
        </div>
      )}
    </div>
  );
}
```

Note: The wallet generate endpoint currently doesn't return the mnemonic (by design — security). For the one-time display, the implementer should either: (a) add a `POST /api/wallet/generate` response that includes the mnemonic marked as one-time, or (b) generate the mnemonic client-side using a BIP39 library, display it, then send it to the backend for derivation. Option (b) is simpler and avoids sending the mnemonic back from the server.

- [ ] **Step 2: Commit**

```bash
git add src/components/WalletSetup.tsx
git commit -m "feat: WalletSetup component with mnemonic backup"
```

---

### Task 12: Modify DKGWizard for Config Saving

**Files:**
- Modify: `src/components/DKGWizard.tsx`

- [ ] **Step 1: Add onComplete prop and config save**

The existing DKGWizard needs two changes:
1. Accept an `onComplete` callback prop
2. After the ceremony completes and the share file is downloaded, call `saveDKG()` to persist the result to the backend config

Find the component function signature (around line ~100) and add the prop:

```typescript
// Before:
export function DKGWizard() {

// After:
interface DKGWizardProps {
  onComplete?: () => void;
}

export function DKGWizard({ onComplete }: DKGWizardProps = {}) {
```

Then, in the completion section where the share is encrypted and downloaded (the `handleDownload` callback), add a call to save the DKG result to the backend:

```typescript
// After the existing downloadShareFile() call, add:
import { saveDKG } from '../lib/api';

// In the handleDownload function, after downloadShareFile(shareFile):
try {
  await saveDKG({
    threshold: state.threshold,
    parties: state.parties,
    level: state.level,
    combinedPubKey: toHex(state.publicKey!),
    shareData: shareFile.encrypted,
  });
  onComplete?.();
} catch (e) {
  console.error('Failed to save DKG to config:', e);
  // Don't block — the share file was already downloaded
  onComplete?.();
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/components/DKGWizard.tsx
git commit -m "feat: DKGWizard saves ceremony result to backend config"
```

---

## Chunk 4: Frontend Components — Signing Flow

### Task 13: Copy ThresholdSign + ShareGate + CSS from Cabal

**Files:**
- Create: `src/components/ThresholdSign.tsx` (copy from `~/projects/od/cabal/src/components/ThresholdSign.tsx`)
- Modify: `src/styles/ceremony.css` (append ThresholdSign styles)

- [ ] **Step 1: Copy ThresholdSign.tsx**

```bash
cp ~/projects/od/cabal/src/components/ThresholdSign.tsx src/components/ThresholdSign.tsx
```

- [ ] **Step 2: Copy ThresholdSign CSS classes**

The cabal component uses CSS classes defined in `~/projects/od/cabal/src/styles/admin.css`. Extract the threshold-related classes (prefixed `.threshold-`, `.admin-detail-`, `.share-import-`, `.blob-exchange-`, `.party-tracker-`) and append them to `src/styles/ceremony.css`.

```bash
# Extract relevant CSS blocks from cabal admin.css and append to ceremony.css
grep -A 10 '\.threshold-\|\.admin-detail-\|\.share-import\|\.blob-exchange\|\.signing-' ~/projects/od/cabal/src/styles/admin.css >> src/styles/ceremony.css
```

Review the appended CSS and clean up any duplicates or OD-specific color references (replace `var(--orange)` with `var(--accent)` if present).

- [ ] **Step 3: Update imports**

The cabal version imports from paths like `../lib/threshold` and `../lib/share-crypto` — these are the same paths in the permafrost repo (since we copied the lib files in Task 6). The relay imports (`../lib/relay`, `../lib/relay-crypto`) also match.

Check for any OD-specific imports and remove them. The ThresholdSign component should be generic. Key things to verify:
- No imports from `opnet`, `@btc-vision/transaction`, or OD-specific modules
- The `RelayClient` import matches `../lib/relay`
- The `sessionFingerprint` import matches `../lib/relay-crypto`
- CSS import points to `../styles/ceremony.css` (or remove CSS import if styles are loaded globally)

- [ ] **Step 4: Verify build**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/components/ThresholdSign.tsx src/styles/ceremony.css
git commit -m "feat: copy ThresholdSign + ShareGate + styles from cabal"
```

---

### Task 14: MessageBuilder Component

**Files:**
- Create: `src/components/MessageBuilder.tsx`

- [ ] **Step 1: Create MessageBuilder**

This component handles the four input modes for building the message to sign.

Create `src/components/MessageBuilder.tsx`:

```typescript
import { useState, useCallback } from 'react';
import { OP20_METHODS, type MethodDef, type MethodParam } from '../lib/op20-methods';
import { encodeTx } from '../lib/api';
import type { ContractConfig } from '../lib/vault-types';

type InputMode = 'op20' | 'abi' | 'raw';

interface Props {
  contracts: ContractConfig[];
  onMessageBuilt: (message: Uint8Array, meta: MessageMeta) => void;
}

export interface MessageMeta {
  contractAddress: string;
  method: string;
  params: Record<string, string>;
  messageHash: string;
}

export function MessageBuilder({ contracts, onMessageBuilt }: Props) {
  const hasConfiguredContracts = contracts.length > 0;

  // If contracts are configured, use config mode exclusively
  const [mode, setMode] = useState<InputMode>(hasConfiguredContracts ? 'op20' : 'op20');
  const [contractAddr, setContractAddr] = useState(hasConfiguredContracts ? contracts[0]!.address : '');
  const [selectedMethod, setSelectedMethod] = useState('');
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [rawHex, setRawHex] = useState('');
  const [abiText, setAbiText] = useState('');
  const [abiMethods, setAbiMethods] = useState<MethodDef[]>([]);
  const [error, setError] = useState('');

  // Determine available methods
  const getAvailableMethods = (): MethodDef[] => {
    if (hasConfiguredContracts) {
      const contract = contracts.find(c => c.address === contractAddr);
      if (!contract) return [];
      // Filter OP20_METHODS to only configured ones, or use ABI methods
      if (contract.abi && contract.abi.length > 0) {
        return parseAbiMethods(contract.abi).filter(m => contract.methods.includes(m.name));
      }
      return OP20_METHODS.filter(m => contract.methods.includes(m.name));
    }
    if (mode === 'abi') return abiMethods;
    return OP20_METHODS;
  };

  const methods = getAvailableMethods();
  const currentMethod = methods.find(m => m.name === selectedMethod);

  const handleParamChange = (name: string, value: string) => {
    setParamValues(prev => ({ ...prev, [name]: value }));
  };

  const handleParseAbi = () => {
    try {
      const abi = JSON.parse(abiText);
      const parsed = parseAbiMethods(abi);
      setAbiMethods(parsed);
      setError('');
    } catch {
      setError('Invalid ABI JSON');
    }
  };

  const handleBuild = useCallback(async () => {
    setError('');
    try {
      let message: Uint8Array;

      let messageHash: string;

      if (mode === 'raw') {
        const hex = rawHex.replace(/^0x/, '');
        message = new Uint8Array(hex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
        const hashBuf = await crypto.subtle.digest('SHA-256', message);
        messageHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
      } else {
        if (!contractAddr || !selectedMethod) {
          setError('Select a contract and method');
          return;
        }
        // Use backend to encode calldata with BinaryWriter (proper OPNet encoding)
        const paramNames = currentMethod?.params.map(p => p.name) || [];
        const paramVals = paramNames.map(n => paramValues[n] || '');
        const paramTypes = (currentMethod?.params || []).map(p => p.type);

        const encoded = await encodeTx(selectedMethod, paramVals, paramTypes);
        const hex = encoded.calldata;
        message = new Uint8Array(hex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
        messageHash = encoded.messageHash;
      }

      onMessageBuilt(message, {
        contractAddress: contractAddr,
        method: selectedMethod || 'raw',
        params: paramValues,
        messageHash,
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [mode, contractAddr, selectedMethod, paramValues, rawHex, currentMethod, onMessageBuilt]);

  return (
    <div className="card">
      <h2>Build Message</h2>

      {/* Contract selector */}
      {hasConfiguredContracts ? (
        <div className="form-row">
          <label>
            Contract
            <select value={contractAddr} onChange={e => { setContractAddr(e.target.value); setSelectedMethod(''); }}>
              {contracts.map(c => (
                <option key={c.address} value={c.address}>{c.name || c.address}</option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <>
          {/* Mode selector */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {(['op20', 'abi', 'raw'] as const).map(m => (
              <button
                key={m}
                className={`btn ${mode === m ? 'btn-primary' : 'btn-secondary'}`}
                style={{ flex: 1, padding: '8px 12px', fontSize: 13 }}
                onClick={() => { setMode(m); setSelectedMethod(''); setError(''); }}
              >
                {m === 'op20' ? 'OP-20' : m === 'abi' ? 'Custom ABI' : 'Raw Hex'}
              </button>
            ))}
          </div>

          {/* Contract address input (op20 and abi modes) */}
          {mode !== 'raw' && (
            <div className="form-row">
              <label>
                Contract Address
                <input
                  value={contractAddr}
                  onChange={e => setContractAddr(e.target.value)}
                  placeholder="0x..."
                />
              </label>
            </div>
          )}
        </>
      )}

      {/* ABI paste area */}
      {mode === 'abi' && !hasConfiguredContracts && (
        <div style={{ marginBottom: 16 }}>
          <textarea
            className="blob-textarea"
            value={abiText}
            onChange={e => setAbiText(e.target.value)}
            placeholder="Paste ABI JSON here..."
            rows={4}
          />
          <button className="btn btn-secondary" style={{ marginTop: 8 }} onClick={handleParseAbi}>
            Parse ABI
          </button>
        </div>
      )}

      {/* Method selector */}
      {mode !== 'raw' && methods.length > 0 && (
        <div className="form-row">
          <label>
            Method
            <select value={selectedMethod} onChange={e => { setSelectedMethod(e.target.value); setParamValues({}); }}>
              <option value="">Select method...</option>
              {methods.map(m => (
                <option key={m.name} value={m.name}>{m.label || m.name}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {/* Dynamic params */}
      {currentMethod && currentMethod.params.map(p => (
        <div className="form-row" key={p.name}>
          <label>
            {p.name} <span style={{ color: 'var(--gray)', fontWeight: 400 }}>({p.type})</span>
            <input
              value={paramValues[p.name] || ''}
              onChange={e => handleParamChange(p.name, e.target.value)}
              placeholder={p.placeholder || p.name}
            />
          </label>
        </div>
      ))}

      {/* Raw hex input */}
      {mode === 'raw' && (
        <div className="form-row">
          <label>
            Message (hex)
            <textarea
              className="blob-textarea"
              value={rawHex}
              onChange={e => setRawHex(e.target.value)}
              placeholder="0x..."
              rows={3}
            />
          </label>
        </div>
      )}

      {error && <div className="warning">{error}</div>}

      <button className="btn btn-primary btn-full" onClick={handleBuild}>
        Build Message
      </button>
    </div>
  );
}

// ── Helpers ──

function parseAbiMethods(abi: unknown[]): MethodDef[] {
  return (abi as Array<{ name?: string; inputs?: Array<{ name: string; type: string }> }>)
    .filter(entry => entry.name && entry.inputs)
    .map(entry => ({
      name: entry.name!,
      label: entry.name!,
      params: (entry.inputs || []).map(inp => ({
        name: inp.name,
        type: mapAbiType(inp.type),
        placeholder: `${inp.name} (${inp.type})`,
      })),
    }));
}

function mapAbiType(abiType: string): 'address' | 'u256' | 'bytes' {
  if (abiType.includes('address') || abiType.includes('Address')) return 'address';
  if (abiType.includes('uint') || abiType.includes('int') || abiType.includes('u256')) return 'u256';
  return 'bytes';
}

```

Note: Calldata encoding is handled by the backend `/api/tx/encode` endpoint (Task 5), which uses `BinaryWriter` from the `opnet` SDK. The frontend sends the method name, parameter values, and types, and receives the properly encoded calldata hex + message hash.

- [ ] **Step 2: Commit**

```bash
git add src/components/MessageBuilder.tsx
git commit -m "feat: MessageBuilder with OP-20/ABI/raw input modes"
```

---

### Task 15: SigningPage Component

**Files:**
- Create: `src/components/SigningPage.tsx`

- [ ] **Step 1: Create SigningPage**

Create `src/components/SigningPage.tsx`:

```typescript
import { useState, useEffect, useCallback } from 'react';
import { MessageBuilder, type MessageMeta } from './MessageBuilder';
import { ShareGate, ThresholdSign } from './ThresholdSign';
import { getConfig, getWalletBalance, broadcastTx } from '../lib/api';
import { toHex } from '../lib/threshold';
import type { VaultConfig } from '../lib/vault-types';
import type { DecryptedShare } from '../lib/share-crypto';

interface Props {
  onSettings: () => void;
}

type Phase = 'build' | 'sign' | 'result';

export function SigningPage({ onSettings }: Props) {
  const [config, setConfig] = useState<VaultConfig | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('build');
  const [message, setMessage] = useState<Uint8Array | null>(null);
  const [messageMeta, setMessageMeta] = useState<MessageMeta | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [txResult, setTxResult] = useState<{ transactionId?: string; error?: string } | null>(null);
  const [broadcasting, setBroadcasting] = useState(false);

  useEffect(() => {
    getConfig().then(setConfig).catch(console.error);
  }, []);

  // Poll balance every 30s if wallet is configured
  useEffect(() => {
    if (!config?.wallet) return;
    const fetch = () => getWalletBalance().then(r => setBalance(r.balance)).catch(() => {});
    fetch();
    const interval = setInterval(fetch, 30_000);
    return () => clearInterval(interval);
  }, [config?.wallet]);

  const handleMessageBuilt = useCallback((msg: Uint8Array, meta: MessageMeta) => {
    setMessage(msg);
    setMessageMeta(meta);
    setPhase('sign');
  }, []);

  const handleSignatureReady = useCallback((sig: Uint8Array) => {
    setSignature(toHex(sig));
    setPhase('result');
  }, []);

  const handleBroadcast = async () => {
    if (!messageMeta || !signature) return;
    setBroadcasting(true);
    try {
      const result = await broadcastTx({
        contract: messageMeta.contractAddress,
        method: messageMeta.method,
        params: Object.values(messageMeta.params),
        signature,
        messageHash: messageMeta.messageHash,
      });
      setTxResult(result);
    } catch (e) {
      setTxResult({ error: (e as Error).message });
    } finally {
      setBroadcasting(false);
    }
  };

  const handleReset = () => {
    setPhase('build');
    setMessage(null);
    setMessageMeta(null);
    setSignature(null);
    setTxResult(null);
  };

  if (!config) return <div className="ceremony"><div className="spinner" /></div>;

  return (
    <div className="ceremony" style={{ maxWidth: 720 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1>PERMAFROST Vault</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            {config.network === 'testnet' ? 'Testnet' : 'Mainnet'}
            {config.permafrost ? ` · ${config.permafrost.threshold}-of-${config.permafrost.parties}` : ''}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {balance !== null && (
            <div style={{ fontSize: 13, color: 'var(--white-dim)' }}>
              {(parseInt(balance) / 1e8).toFixed(8)} BTC
            </div>
          )}
          <button
            onClick={onSettings}
            style={{ background: 'none', color: 'var(--gray-light)', fontSize: 20, padding: 4 }}
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </div>

      {/* Build phase */}
      {phase === 'build' && (
        <MessageBuilder
          contracts={config.contracts}
          onMessageBuilt={handleMessageBuilt}
        />
      )}

      {/* Sign phase */}
      {phase === 'sign' && message && messageMeta && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <h2>Signing: {messageMeta.method}</h2>
            <div style={{ fontSize: 13, color: 'var(--white-dim)' }}>
              Contract: <span style={{ fontFamily: 'monospace' }}>{messageMeta.contractAddress}</span>
            </div>
            <div style={{ fontSize: 13, color: 'var(--white-dim)', marginTop: 4 }}>
              Message hash: <span style={{ fontFamily: 'monospace', color: 'var(--accent)' }}>{messageMeta.messageHash.slice(0, 16)}...</span>
            </div>
            <button className="btn btn-secondary" style={{ marginTop: 12, fontSize: 13 }} onClick={handleReset}>
              Cancel
            </button>
          </div>

          <ShareGate>
            {(share: DecryptedShare) => (
              <ThresholdSign
                stepTitle={`Sign: ${messageMeta.method}`}
                targetContract={messageMeta.contractAddress}
                txParams={messageMeta.params}
                message={message}
                share={share}
                onSignatureReady={handleSignatureReady}
                onCancel={handleReset}
              />
            )}
          </ShareGate>
        </>
      )}

      {/* Result phase */}
      {phase === 'result' && signature && messageMeta && (
        <div className="card">
          <h2>Signature Ready</h2>
          <div className="success-box">Threshold signing complete</div>

          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Message Hash</h3>
          <div className="pubkey-display" style={{ fontSize: 12 }}>{messageMeta.messageHash}</div>

          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>ML-DSA Signature</h3>
          <div className="pubkey-display" style={{ fontSize: 11, maxHeight: 120, overflowY: 'auto' }}>{signature}</div>

          <button
            className="btn btn-secondary btn-full"
            style={{ marginBottom: 12 }}
            onClick={() => navigator.clipboard.writeText(signature)}
          >
            Copy Signature
          </button>

          {/* Broadcast button — only if wallet is configured */}
          {config.wallet && !txResult && (
            <button className="btn btn-primary btn-full" onClick={handleBroadcast} disabled={broadcasting}>
              {broadcasting ? <span className="spinner" /> : 'Broadcast Transaction'}
            </button>
          )}

          {txResult && (
            <div className={txResult.transactionId ? 'success-box' : 'warning'}>
              {txResult.transactionId
                ? `Transaction broadcast: ${txResult.transactionId}`
                : `Broadcast failed: ${txResult.error}`}
            </div>
          )}

          <button className="btn btn-secondary btn-full" style={{ marginTop: 12 }} onClick={handleReset}>
            New Transaction
          </button>
        </div>
      )}
    </div>
  );
}
```

Note: The `ShareGate` and `ThresholdSign` props may need adjustment based on the exact interface from the copied cabal component. Check the `ThresholdSignProps` interface — it expects `message: Uint8Array` and an `onSignatureReady` callback. The `ShareGate` component wraps share file import/decryption and renders its children once a share is loaded.

- [ ] **Step 2: Commit**

```bash
git add src/components/SigningPage.tsx
git commit -m "feat: SigningPage with message builder + signing + broadcast"
```

---

### Task 16: Settings Component

**Files:**
- Create: `src/components/Settings.tsx`

- [ ] **Step 1: Create Settings**

Create `src/components/Settings.tsx`:

```typescript
import { useState, useEffect } from 'react';
import { getConfig, getWalletBalance, getBalances, resetInstance, updateContracts } from '../lib/api';
import type { VaultConfig, ContractConfig } from '../lib/vault-types';

interface Props {
  onBack: () => void;
}

export function Settings({ onBack }: Props) {
  const [config, setConfig] = useState<VaultConfig | null>(null);
  const [balance, setBalance] = useState<string>('0');
  const [tokenBalances, setTokenBalances] = useState<Array<{ symbol: string; balance: string }>>([]);
  const [resetStep, setResetStep] = useState<0 | 1 | 2>(0);
  const [resetInput, setResetInput] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    getConfig().then(setConfig).catch(console.error);
    getWalletBalance().then(r => setBalance(r.balance)).catch(() => {});
    getBalances().then(r => setTokenBalances(r.balances.map(b => ({ symbol: b.symbol, balance: b.balance })))).catch(() => {});
  }, []);

  const handleReset = async () => {
    if (resetStep === 0) { setResetStep(1); return; }
    if (resetStep === 1) { setResetStep(2); return; }
    if (resetInput !== 'RESET') { setError('Type RESET to confirm'); return; }
    try {
      await resetInstance();
      window.location.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!config) return <div className="ceremony"><div className="spinner" /></div>;

  return (
    <div className="ceremony" style={{ maxWidth: 720 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1>Settings</h1>
        <button className="btn btn-secondary" onClick={onBack}>Back</button>
      </div>

      {/* Network */}
      <div className="card">
        <h2>Network</h2>
        <p>{config.network === 'testnet' ? 'Testnet' : 'Mainnet'} · Storage: {config.storageMode}</p>
      </div>

      {/* Wallet */}
      <div className="card">
        <h2>Wallet</h2>
        {config.wallet ? (
          <>
            <div style={{ marginBottom: 8 }}>
              <strong style={{ fontSize: 13, color: 'var(--gray-light)' }}>P2TR Address</strong>
              <div className="pubkey-display" style={{ fontSize: 12, marginTop: 4 }}>{config.wallet.p2tr}</div>
            </div>
            <div style={{ marginBottom: 8 }}>
              <strong style={{ fontSize: 13, color: 'var(--gray-light)' }}>Tweaked Public Key</strong>
              <div className="pubkey-display" style={{ fontSize: 12, marginTop: 4 }}>{config.wallet.tweakedPubKey}</div>
            </div>
            <div>
              <strong style={{ fontSize: 13, color: 'var(--gray-light)' }}>BTC Balance</strong>
              <div style={{ fontSize: 16, fontWeight: 600, marginTop: 4 }}>{(parseInt(balance) / 1e8).toFixed(8)} BTC</div>
            </div>
          </>
        ) : (
          <p>No wallet configured. Signatures are display-only.</p>
        )}
      </div>

      {/* Permafrost */}
      {config.permafrost && (
        <div className="card">
          <h2>Permafrost</h2>
          <p>{config.permafrost.threshold}-of-{config.permafrost.parties} threshold · Security level {config.permafrost.level}</p>
          <div style={{ marginTop: 8 }}>
            <strong style={{ fontSize: 13, color: 'var(--gray-light)' }}>Combined ML-DSA Public Key</strong>
            <div className="pubkey-display" style={{ fontSize: 11, marginTop: 4 }}>
              {config.permafrost.combinedPubKey.slice(0, 64)}...
            </div>
          </div>
        </div>
      )}

      {/* OP-20 Balances */}
      {tokenBalances.length > 0 && (
        <div className="card">
          <h2>Token Balances</h2>
          {tokenBalances.map((t, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 14 }}>
              <span>{t.symbol}</span>
              <span style={{ fontFamily: 'monospace' }}>{t.balance}</span>
            </div>
          ))}
        </div>
      )}

      {/* Contracts */}
      <div className="card">
        <h2>Configured Contracts</h2>
        {config.contracts.length === 0 ? (
          <p>No contracts configured. All OP-20 methods available for any contract.</p>
        ) : (
          config.contracts.map((c, i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <strong style={{ fontSize: 14 }}>{c.name || 'Unnamed'}</strong>
              <div style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--white-dim)' }}>{c.address}</div>
              <div style={{ fontSize: 12, color: 'var(--gray-light)' }}>Methods: {c.methods.join(', ')}</div>
            </div>
          ))
        )}
      </div>

      {/* Reset */}
      <div className="card">
        <h2>Reset Instance</h2>
        {resetStep === 0 && (
          <button className="btn btn-secondary btn-full" style={{ color: 'var(--red)' }} onClick={handleReset}>
            Reset Instance
          </button>
        )}
        {resetStep === 1 && (
          <>
            <div className="warning">This will permanently delete all data: wallet, DKG shares, and configuration.</div>
            <div style={{ display: 'flex', gap: 12 }}>
              <button className="btn btn-secondary" onClick={() => setResetStep(0)}>Cancel</button>
              <button className="btn btn-secondary" style={{ color: 'var(--red)', flex: 1 }} onClick={handleReset}>
                I understand, continue
              </button>
            </div>
          </>
        )}
        {resetStep === 2 && (
          <>
            <div className="warning">Type RESET to confirm.</div>
            <input
              value={resetInput}
              onChange={e => setResetInput(e.target.value)}
              placeholder="Type RESET"
              style={{ width: '100%', marginBottom: 12 }}
            />
            {error && <div className="warning">{error}</div>}
            <div style={{ display: 'flex', gap: 12 }}>
              <button className="btn btn-secondary" onClick={() => { setResetStep(0); setResetInput(''); }}>Cancel</button>
              <button className="btn btn-secondary" style={{ color: 'var(--red)', flex: 1 }} onClick={handleReset}>
                Confirm Reset
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/Settings.tsx
git commit -m "feat: Settings page with wallet/permafrost info + reset"
```

---

## Chunk 5: Docker & Integration

### Task 17: Docker Setup

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `entrypoint.sh`
- Create: `docker-compose.yml`

- [ ] **Step 1: Create .dockerignore**

```
node_modules
dist
dist-offline
backend/node_modules
backend/dist
*.tsbuildinfo
.git
```

- [ ] **Step 2: Create Dockerfile**

Create `Dockerfile` in the repo root:

```dockerfile
FROM node:20-alpine AS frontend-build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS backend-build
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci
COPY backend/ .
RUN npx tsc

FROM golang:1.23-alpine AS relay-build
WORKDIR /src
COPY relay/go.mod relay/go.sum ./
RUN go mod download
COPY relay/*.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /relay .

FROM node:20-alpine
WORKDIR /app
COPY --from=frontend-build /app/dist ./dist
COPY --from=backend-build /app/dist ./backend
COPY --from=backend-build /app/node_modules ./backend/node_modules
COPY --from=relay-build /relay /usr/local/bin/relay
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080
VOLUME /data
ENTRYPOINT ["/entrypoint.sh"]
```

- [ ] **Step 3: Create entrypoint.sh**

```bash
#!/bin/sh
# Start relay on 8081 (relay defaults to 8080, override to avoid conflict with backend)
relay -addr :8081 &

# Start Node.js backend on 8080 (serves frontend + API, proxies /ws to relay:8081)
node backend/server.js
```

- [ ] **Step 4: Create docker-compose.yml**

```yaml
services:
  permafrost-vault:
    build: .
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - permafrost-data:/data
    environment:
      - NODE_ENV=production

volumes:
  permafrost-data:
```

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore entrypoint.sh docker-compose.yml
git commit -m "feat: Docker setup with multi-stage build"
```

---

### Task 18: Update Frontend Vite Config for Backend Dev Mode

**Files:**
- Modify: `vite.config.ts`

- [ ] **Step 1: Add dev proxy to vite config**

During development, the frontend runs on Vite's dev server (port 5173) and needs to proxy `/api` and `/ws` to the backend. Update `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
    },
  },
});
```

- [ ] **Step 2: Add dev scripts to root package.json**

Add to the root `package.json` scripts:

```json
"dev:backend": "cd backend && npm run dev",
"dev:relay": "cd relay && go run . -addr :8081"
```

Development workflow:
```bash
# Terminal 1: Frontend
npm run dev

# Terminal 2: Backend
npm run dev:backend

# Terminal 3: Relay (optional, for relay mode)
npm run dev:relay
```

- [ ] **Step 3: Commit**

```bash
git add vite.config.ts package.json
git commit -m "feat: Vite dev proxy + dev scripts"
```

---

### Task 19: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README to cover the Vault functionality**

Add sections to the existing README covering:
- The Vault concept (DKG + wallet + signing + broadcasting)
- Docker setup instructions
- Development setup (three terminals)
- Config file format for locking down contracts
- Environment variables for the backend

Keep the existing DKG ceremony documentation and relay server documentation intact. Add the new content after the existing sections.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add Vault setup and Docker instructions to README"
```

---

### Task 20: Build Verification + Integration Test

- [ ] **Step 1: Verify backend compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 2: Verify frontend compiles**

```bash
npm run build
```

Expected: Successful build in `dist/`.

- [ ] **Step 3: Verify Docker builds**

```bash
docker build -t permafrost-vault .
```

Expected: Multi-stage build completes successfully.

- [ ] **Step 4: Smoke test**

```bash
docker run -d --name pf-test -p 8080:8080 -v /tmp/pf-data:/data permafrost-vault
# Wait for startup
sleep 3
# Check health
curl http://localhost:8080/api/status
# Expected: {"state":"fresh"}
# Cleanup
docker stop pf-test && docker rm pf-test
```

- [ ] **Step 5: Final commit and push**

```bash
git push origin master
```

---

## Verification Checklist

After all tasks are complete, verify:

1. `docker build` produces a working image
2. Fresh instance shows Install Wizard at `http://localhost:8080`
3. Install Wizard → selecting network + storage mode → creates config
4. Wallet Setup → generates BTC keypair → shows mnemonic + p2tr address
5. Wallet skip → proceeds without wallet
6. DKG Ceremony → runs full 6-phase ceremony → saves result to config
7. Signing Page → shows message builder → OP-20 methods work
8. Signing Page → threshold signing rounds complete → signature displayed
9. Broadcast (with wallet) → transaction submitted to OPNet RPC
10. Settings → shows wallet info, permafrost info, contracts, reset
11. Reset → double confirmation → wipes config → returns to fresh state
12. Encrypted-persistent mode → password required on container restart
13. Encrypted-portable mode → config file download/upload works

## Implementation Notes

### ThresholdSign Component Integration

The `ThresholdSign` component from cabal accepts these key props:
- `message: Uint8Array` — the calldata to sign
- `share: DecryptedShare` — the decrypted DKG share (from ShareGate)
- `onSignatureReady?: (signature: string, messageHash: string) => void`
- `relayClient?: RelayClient` (optional, for relay mode)

The `ShareGate` component wraps share file import:
- Renders a file upload + password form
- Once decrypted, renders its children with the `DecryptedShare`

Check the exact prop interfaces in the copied file and adjust `SigningPage.tsx` accordingly.

### Calldata Encoding

Calldata encoding is handled by the backend `POST /api/tx/encode` endpoint, which uses `BinaryWriter` from the `opnet` SDK to properly encode selectors (SHA-256 first 4 bytes), addresses (32-byte hash), and u256 values (32-byte big-endian). The frontend sends method name + typed params and receives encoded calldata hex + message hash. This avoids bundling the full `opnet` SDK in the frontend.

### Mnemonic Display

The wallet generate endpoint intentionally doesn't return the mnemonic (security). The recommended approach is:
- Generate mnemonic client-side using `@scure/bip39` (or the `bip39` package)
- Display it to the user for backup
- Send the mnemonic to the backend's `/api/wallet/generate` endpoint (which derives the keypair and saves to config)
- The backend never returns the mnemonic in any subsequent response

This keeps the mnemonic on the client side during the one-time display, and the backend only receives it once via localhost POST. Add `@scure/bip39` to the frontend dependencies:

```bash
npm install @scure/bip39
```

Then in `WalletSetup.tsx`:
```typescript
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

const phrase = generateMnemonic(wordlist);
setMnemonic(phrase);
// Then POST to /api/wallet/generate with { mnemonic: phrase }
```

### OPNet SDK API Verification

Before implementing, verify these API calls against the actual `@btc-vision/transaction` and `opnet` packages:
- `Mnemonic` constructor and `deriveOPWallet()` — check exact parameter names
- `wallet.tweakedPubKeyKey` vs `wallet.tweakedPubKey` — verify the exact property name
- `getContract()` signature — check if sender must be an `Address` object
- `provider.getChallenge()` — verify this method exists on `JSONRpcProvider`
- `QuantumBIP32Interface` — check all required method signatures for the adapter
