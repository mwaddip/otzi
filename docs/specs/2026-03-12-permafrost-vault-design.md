# PERMAFROST Vault — Design Specification

**Date:** 2026-03-12
**Status:** Draft
**Repo:** `opnet-permafrost`

## Overview

PERMAFROST Vault is a self-contained multisig operations toolkit for OPNet, packaged as a Docker container. It combines threshold ML-DSA key generation (DKG), BTC wallet management, and threshold transaction signing into a single deployable unit.

A party running a Vault instance can:

1. Participate in a one-time DKG ceremony to generate a shared ML-DSA keypair
2. Optionally generate a BTC wallet for UTXO funding and transaction broadcasting
3. Build, threshold-sign, and broadcast OPNet contract transactions

The DKG ceremony produces a combined ML-DSA public key (full-length, e.g. 1312 bytes for ML-DSA-44 / security level 2). Combined with a BTC wallet's tweaked public key, this forms the OPNet address via `Address.fromString(combinedMLDSAPubKeyHex, tweakedPubKeyHex)` — the `Address` constructor internally SHA-256 hashes the full-length ML-DSA key to produce the 32-byte address component. The ML-DSA signature is produced via threshold signing (T-of-N parties), while the BTC signature for UTXO spending comes from the initiator's wallet.

## Architecture

### Components

```
Docker Container
├── Frontend        Single React app (Vite), served by backend
├── Backend         Node.js (Express) — config, UTXO selection, tx broadcast
└── Relay           Go binary — WebSocket relay for DKG + signing blob exchange
```

- **Frontend**: Single-page React app with linear flow (not tabbed/routed). The active view is determined by setup state.
- **Backend**: Node.js/Express service that serves the frontend, manages config, queries OPNet RPC for UTXOs/balances, builds and broadcasts transactions. Holds wallet keys in memory (never sent to frontend).
- **Relay**: Existing Go WebSocket relay server (already built). Routes E2E encrypted blobs between parties for DKG and signing ceremonies.

### Process Management

A lightweight init process (e.g., `concurrently` or a shell script) starts both the Node.js backend and the Go relay binary. The backend serves the frontend static files and proxies `/ws` to the relay.

## App Flow

The app presents a linear flow determined by setup state. There are no tabs or sidebar — only one view is active at a time, plus a gear icon for settings.

```
┌─────────────────┐
│  Install Wizard  │  First launch only
│  (storage mode   │  Picks network + storage mode
│   + network)     │
└────────┬────────┘
         ▼
┌─────────────────┐
│  Wallet Setup    │  Shows once after install wizard
│  (BTC keypair)   │  Can be skipped (checkbox: "don't show again")
│                  │  Skipping = no broadcast capability
└────────┬────────┘
         ▼
┌─────────────────┐
│  DKG Ceremony    │  Mandatory, one-time
│  (threshold      │  Existing PERMAFROST ceremony
│   ML-DSA key)    │  Must complete before signing
└────────┬────────┘
         ▼
┌─────────────────┐
│  Signing Page    │  Main view (daily use)
│  (build + sign   │  Top-right: BTC balance (if wallet configured)
│   + broadcast)   │  Gear icon → Settings
└─────────────────┘
```

On subsequent launches, the app skips completed steps and goes directly to the signing page (or to the unlock screen for encrypted-persistent mode).

## Views

### 1. Install Wizard

Shown on first launch. Two steps:

**Step 1 — Network Selection**
- Mainnet / Testnet toggle
- RPC endpoints are built-in:
  - Testnet: `https://testnet.opnet.org`
  - Mainnet: `https://mainnet.opnet.org`

**Step 2 — Storage Mode Selection**

| Mode | Description | When to use |
|------|-------------|-------------|
| **Persistent** | Config stored as plaintext JSON in Docker volume (`/data/config.json`). Survives container restarts. | Trusted server, quick access |
| **Encrypted Persistent** | Config encrypted at rest in Docker volume. Password required on each container start to decrypt into memory. | Server you control but want defense-in-depth |
| **Encrypted Portable** | Config encrypted in-browser with a user password, then downloaded as a file. On each session, user uploads the file and enters the password. The frontend decrypts in-browser, then sends the decrypted config to the backend over localhost for the duration of the session. | Air-gapped or untrusted environments |

### 2. Wallet Setup

Shows automatically after install wizard (or as long as no wallet has been configured). Can be skipped with a "Don't show again" checkbox.

**What it does:**
- Generates a BIP39 mnemonic (12 or 24 words)
- Derives a BTC keypair via `deriveOPWallet()` (BIP86 taproot path `m/86'/0'/0'/0/0`)
- Displays the mnemonic for backup, p2tr address for funding
- Saves to config per the chosen storage mode

**What it does NOT do:**
- Does NOT generate an ML-DSA keypair — that comes from the DKG ceremony

**If skipped:**
- The signing page shows threshold ML-DSA signatures only (copy/paste)
- No "Submit" button (no broadcast capability)
- No balance display
- User manages their own BTC wallet externally

**Wallet can be set up later** via the Settings page.

### 3. DKG Ceremony

The existing PERMAFROST DKG ceremony, integrated into the app. Mandatory — must be completed before the signing page becomes available.

After completion, the following are stored in config:
- Combined ML-DSA public key (hex)
- Encrypted share data (per storage mode)
- Threshold (T), parties (N), security level
- Bitmasks and holder assignments

If a wallet is also configured, the full OPNet address can be derived and displayed:
`Address.fromString(combinedMLDSAPubKeyHex, tweakedPubKeyHex)`
(The `Address` constructor internally hashes the full-length ML-DSA public key to 32 bytes.)

### 4. Signing Page (Main View)

The primary interface after setup is complete.

**Header:**
- App title / logo
- Top-right: BTC balance of the configured wallet (if wallet exists). Refreshes periodically.
- Gear icon → Settings

**Message Input — Four Modes:**

#### Mode 1: Standard OP-20 Methods (Default)

For interacting with any OP-20 contract without needing its ABI.

- Contract address input (hex)
- Dropdown of standard OP-20 methods:
  - `transfer(to, amount)`
  - `transferFrom(from, to, amount)`
  - `approve(spender, amount)`
  - `increaseAllowance(spender, amount)`
  - `decreaseAllowance(spender, amount)`
  - `burn(amount)`
  - `mint(address, amount)`
- Dynamic parameter inputs rendered from the selected method
- "Build Message" button → encodes the contract calldata (selector + ABI-encoded params) using `BinaryWriter`. This calldata is what the threshold signing ceremony signs. The calldata bytes are hashed (SHA-256) to produce a display-friendly message hash for verification across parties.

#### Mode 2: ABI Upload

For interacting with contracts that have custom methods beyond OP-20.

- Upload ABI JSON file or paste ABI JSON into a text area
- Dropdown populated with all functions from the ABI
- Dynamic parameter inputs from ABI function signatures
- Same "Build Message" flow

#### Mode 3: Raw Message

For advanced users who construct the message externally.

- Hex input field for raw message bytes
- No parameter parsing — the bytes are the message

#### Mode 4: Config Override

When the config file specifies contracts with allowed methods, the signing page shows only those. This locks down the instance to specific operations.

```json
{
  "contracts": [
    {
      "name": "Treasury Token",
      "address": "0xabc...",
      "methods": ["transfer", "approve"]
    },
    {
      "name": "Custom Contract",
      "address": "0xdef...",
      "abi": [{ "name": "setReserve", "inputs": [...] }],
      "methods": ["setReserve"]
    }
  ]
}
```

When contracts are configured, the mode selector is hidden. The contract dropdown replaces the address input, and only configured methods appear.

**Threshold Signing Flow:**

After building the message (calldata bytes):

1. Share file is loaded (from config or manual import) and decrypted via `decryptShareFile()` → `DecryptedShare`
2. Initiator proposes the signing session (creates relay session or generates proposal blob containing the calldata)
3. A `SigningSession` is created via `createSession(calldata, share.keyShare, activePartyIds)` from `threshold.ts`
4. All T parties participate in 3-round signing using `ThresholdMLDSA` methods:
   - Round 1 (`round1`): Each party generates a commitment hash (`commitmentHash`) and broadcasts it
   - Round 2 (`round2`): Each party reveals their commitment after collecting all round 1 hashes
   - Round 3 (`round3`): Each party computes a partial response after collecting all commitments
5. Initiator combines all responses via `combine()` → FIPS 204 ML-DSA signature (or `null` on failure, triggering auto-retry with fresh nonce; `K_iter=20` gives near-100% first-attempt success)
6. All parties see the signature + message hash

**Broadcasting (initiator only, wallet required):**

6. Initiator clicks "Submit"
7. Backend obtains a challenge solution from OPNet RPC (`provider.getChallenge()`)
8. Backend simulates the contract call via OPNet RPC
9. Backend selects UTXOs from the wallet
10. Backend builds the transaction using a `ThresholdMLDSASigner` adapter (see "ML-DSA Signature Injection" below) that wraps the pre-computed threshold signature
11. Backend signs the Bitcoin transaction (ECDSA via `wallet.keypair`) and broadcasts to OPNet RPC
12. Transaction hash displayed to all parties

Parties without a wallet see the signature for copying but no Submit button.

**Transport modes** (same as DKG):
- **Relay**: Auto-exchange blobs via E2E encrypted WebSocket relay
- **Offline**: Manual copy/paste of blobs (air-gapped friendly)

### 5. Settings Page (Gear Icon)

Accessible from the signing page header via a gear icon.

**Sections:**

- **Wallet**: p2tr address, tweaked public key, BTC balance. Option to set up wallet if skipped.
- **Permafrost**: Combined ML-DSA public key, tweaked public keys, threshold (T-of-N), security level. The derived OPNet address (if wallet is configured).
- **OP-20 Balances**: Token balances held by the Permafrost OPNet address. Queries the RPC for known token contracts.
- **Contracts**: Configured contract addresses and allowed methods. Editable.
- **Network**: Current network (mainnet/testnet). Display only after initial setup.
- **Reset Instance**: Wipes all config data. Requires double confirmation ("Are you sure?" → "Type RESET to confirm").

## Backend API

All endpoints are prefixed with `/api`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | Returns setup state: `{wizard, wallet, dkg, ready}` + network + storage mode |
| `POST` | `/api/init` | Initialize instance (network, storage mode). First-launch only. |
| `POST` | `/api/unlock` | Decrypt config into memory (encrypted-persistent mode). Accepts password. |
| `POST` | `/api/wallet/generate` | Generate BTC keypair, save to config. Returns p2tr address (no private keys). |
| `POST` | `/api/wallet/skip` | Mark wallet as skipped (with "don't show again" flag). |
| `GET` | `/api/wallet/balance` | BTC balance (satoshis) of the configured wallet. |
| `GET` | `/api/balances` | OP-20 token balances for the Permafrost OPNet address. |
| `POST` | `/api/dkg/save` | Save DKG ceremony result (combined pubkey, encrypted share, params). |
| `POST` | `/api/tx/simulate` | Simulate a contract call. Params: `{contract, method, params, abi?}`. Returns simulation result. |
| `POST` | `/api/tx/broadcast` | Build UTXO-funded tx with ML-DSA signature and broadcast. Params: `{contract, calldata, signature, messageHash}`. |
| `GET` | `/api/config` | Read config (sanitized — no private keys, no mnemonic). |
| `POST` | `/api/config/contracts` | Update contract configuration. |
| `POST` | `/api/config/export` | Export encrypted config file (portable mode). |
| `POST` | `/api/config/import` | Import encrypted config file (portable mode). |
| `POST` | `/api/reset` | Wipe all config. Requires `{confirm: "RESET"}`. |

### Security Rules

- Private keys (mnemonic, BTC private key) are NEVER returned to the frontend
- In persistent mode, keys are stored in the Docker volume config file
- In encrypted-persistent mode, keys are encrypted at rest, decrypted into memory on unlock
- In portable mode, the frontend decrypts the config in-browser, then sends the decrypted config to the backend over localhost for the duration of the session. The backend holds keys in memory only — nothing is written to disk. When the session ends, keys are discarded.

## Config Structure

```json
{
  "version": 1,
  "network": "testnet",
  "storageMode": "persistent",
  "setupState": {
    "wizardComplete": true,
    "walletSkipped": false,
    "walletDontShowAgain": false,
    "dkgComplete": true
  },
  "wallet": {
    "mnemonic": "word1 word2 ... word12",
    "p2tr": "opt1...",
    "tweakedPubKey": "hex (32 bytes, x-only taproot key)",
    "publicKey": "hex (33 bytes, compressed secp256k1)"
  },
  "permafrost": {
    "threshold": 2,
    "parties": 3,
    "level": 2,
    "combinedPubKey": "hex (full-length ML-DSA public key, e.g. 1312 bytes for level 2)",
    "shareData": "base64 encrypted share..."
  },
  "contracts": [
    {
      "name": "Treasury Token",
      "address": "0xabc...",
      "abi": [],
      "methods": ["transfer", "approve"]
    }
  ],
  "rpc": {
    "testnet": "https://testnet.opnet.org",
    "mainnet": "https://mainnet.opnet.org"
  }
}
```

## Docker

### Single Image

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

### Entrypoint

```bash
#!/bin/sh
# Start relay on 8081 (relay defaults to 8080, override to avoid conflict with backend)
relay -addr :8081 &

# Start Node.js backend on 8080 (serves frontend + API, proxies /ws to relay:8081)
node backend/server.js
```

### Docker Compose

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

### Usage

```bash
docker build -t permafrost-vault .
docker run -p 8080:8080 -v permafrost-data:/data permafrost-vault
# Open http://localhost:8080
```

## OPNet Integration

### RPC Endpoints (Built-in)

| Network | URL |
|---------|-----|
| Testnet | `https://testnet.opnet.org` |
| Mainnet | `https://mainnet.opnet.org` |

### Network Constants

- Testnet: `networks.opnetTestnet` from `@btc-vision/bitcoin` (bech32 prefix: `opt`)
- Mainnet: `networks.bitcoin` from `@btc-vision/bitcoin`
- NEVER use `networks.testnet` (that's Testnet4, not OPNet)

### Wallet Derivation

```typescript
import { Mnemonic, MLDSASecurityLevel } from '@btc-vision/transaction';
import { networks } from '@btc-vision/bitcoin';

const mnemonic = new Mnemonic(phrase, '', network, MLDSASecurityLevel.LEVEL2);
const wallet = mnemonic.deriveOPWallet(undefined, 0, 0, false);
// wallet.keypair    → ECDSA signer (for Bitcoin tx signing)
// wallet.p2tr       → P2TR address (for UTXOs)
// wallet.address    → Address object (tweakedPubKey component)
```

Note: `deriveOPWallet()` also generates an ML-DSA keypair internally, but for PERMAFROST this is ignored — the ML-DSA key comes from the DKG ceremony instead.

### ML-DSA Signature Injection

The OPNet SDK's `sendTransaction()` expects an `mldsaSigner: QuantumBIP32Interface` — a signer object, not a raw signature. Since the ML-DSA signature is produced externally by the threshold signing ceremony, we need an adapter.

**`ThresholdMLDSASigner`** — a class implementing `QuantumBIP32Interface` that wraps a pre-computed signature:

```typescript
class ThresholdMLDSASigner implements QuantumBIP32Interface {
  constructor(
    private readonly precomputedSignature: Uint8Array,
    private readonly publicKey: Uint8Array, // combined ML-DSA pubkey from DKG
  ) {}

  sign(_message: Uint8Array): Uint8Array {
    // Return the pre-computed threshold signature regardless of message.
    // The message was already signed during the threshold ceremony.
    return this.precomputedSignature;
  }

  getPublicKey(): Uint8Array {
    return this.publicKey;
  }

  // Other QuantumBIP32Interface methods as needed (derive, etc.)
  // can throw "not supported" since we only use this for signing.
}
```

This adapter is created per-transaction in the backend broadcast route.

### Transaction Broadcasting Flow

1. Frontend sends `{contract, calldata, mldsaSignature, messageHash}` to backend
2. Backend obtains a challenge solution from OPNet RPC (`provider.getChallenge()`)
3. Backend creates contract instance via `getContract(address, abi, provider, network, sender)`
4. Backend simulates: `contract.methodName(params...)` → `CallResult`
5. Backend creates a `ThresholdMLDSASigner` wrapping the pre-computed ML-DSA signature
6. Backend calls `callResult.sendTransaction({signer: wallet.keypair, mldsaSigner: thresholdSigner, ...})`
7. The SDK calls `thresholdSigner.sign()` which returns the pre-computed signature
8. Backend broadcasts and returns transaction hash

### Standard OP-20 Methods (Default Mode)

Available for any contract without an ABI:

| Method | Parameters | Description |
|--------|-----------|-------------|
| `transfer` | `to: Address, amount: u256` | Transfer tokens |
| `transferFrom` | `from: Address, to: Address, amount: u256` | Transfer on behalf |
| `approve` | `spender: Address, amount: u256` | Approve spending |
| `increaseAllowance` | `spender: Address, amount: u256` | Increase approval |
| `decreaseAllowance` | `spender: Address, amount: u256` | Decrease approval |
| `burn` | `amount: u256` | Burn own tokens |
| `mint` | `address: Address, amount: u256` | Mint (if authorized) |

Read-only methods (for Settings/balance display):
`name()`, `symbol()`, `decimals()`, `totalSupply()`, `balanceOf(owner)`, `allowance(owner, spender)`

## Dependencies

### Frontend (existing + new)

```
react, react-dom                          — UI framework (existing)
@btc-vision/post-quantum (vendor)         — threshold ML-DSA (existing)
```

### Backend (new)

```
express                                   — HTTP server + API
opnet                                     — RPC provider, getContract, OP-20 ABI, CallResult
@btc-vision/transaction                   — Mnemonic, TransactionFactory, wallet derivation
@btc-vision/bitcoin                       — networks, address utilities
```

### Relay (existing)

Go binary, no changes needed.

## File Structure

```
opnet-permafrost/
├── src/                          # Frontend React app
│   ├── components/
│   │   ├── DKGWizard.tsx         # Existing DKG ceremony
│   │   ├── PasswordModal.tsx     # Existing password modal
│   │   ├── InstallWizard.tsx     # NEW: storage mode + network selection
│   │   ├── WalletSetup.tsx       # NEW: BTC keypair generation
│   │   ├── SigningPage.tsx       # NEW: main signing interface
│   │   ├── MessageBuilder.tsx    # NEW: OP-20/ABI/raw message input
│   │   ├── ThresholdSign.tsx     # NEW: signing rounds UI (from cabal)
│   │   ├── Settings.tsx          # NEW: config viewer + reset
│   │   └── ShareGate.tsx         # NEW: share import gate (from cabal)
│   ├── lib/
│   │   ├── crypto.ts             # Existing: AES-GCM encryption
│   │   ├── dkg.ts                # Existing: DKG protocol
│   │   ├── keygen.ts             # Existing: share file encryption
│   │   ├── relay.ts              # Existing: relay client
│   │   ├── relay-crypto.ts       # Existing: E2E encryption
│   │   ├── serialize.ts          # Existing: share serialization
│   │   ├── threshold.ts          # NEW: signing session (from cabal)
│   │   ├── share-crypto.ts       # NEW: share decryption (from cabal)
│   │   ├── api.ts                # NEW: backend API client
│   │   └── op20-methods.ts       # NEW: standard OP-20 method definitions
│   ├── styles/
│   │   ├── global.css            # Existing
│   │   └── ceremony.css          # Existing (extend for new views)
│   ├── App.tsx                   # Modified: state-driven view routing
│   └── main.tsx                  # Existing
├── backend/                      # NEW: Node.js backend
│   ├── server.ts                 # Express app, static serving, WS proxy
│   ├── routes/
│   │   ├── config.ts             # Config CRUD, init, reset, export/import
│   │   ├── wallet.ts             # Generate, balance
│   │   ├── tx.ts                 # Simulate, broadcast
│   │   └── balances.ts           # OP-20 token balances
│   ├── lib/
│   │   ├── config-store.ts       # Config persistence (3 storage modes)
│   │   ├── encryption.ts         # Config encryption (PBKDF2 + AES-GCM)
│   │   └── opnet-client.ts       # OPNet RPC wrapper (provider, getContract)
│   ├── package.json
│   └── tsconfig.json
├── relay/                        # Existing Go relay server
├── vendor/post-quantum/          # Existing
├── Dockerfile                    # NEW: multi-stage build
├── docker-compose.yml            # NEW
├── entrypoint.sh                 # NEW: process manager
├── package.json                  # Modified
└── README.md                     # Modified
```

## Security Considerations

- **Key isolation**: The backend holds BTC private keys in memory. They are never serialized to the frontend. The frontend only receives public addresses and balances.
- **Config encryption**: In encrypted modes, the config is encrypted with AES-256-GCM using a PBKDF2-derived key (100k iterations). The encryption key is derived from the user's password.
- **Portable mode**: The frontend decrypts the config in-browser after the user uploads the encrypted file and enters their password. The decrypted config is sent to the backend over localhost for the duration of the session. The backend holds keys in memory only — nothing written to disk, keys discarded when session ends.
- **Relay E2E**: All relay messages are encrypted with ECDH (P-256) + AES-256-GCM. The relay server only forwards ciphertext.
- **Threshold security**: No single party can sign alone. T-of-N parties must cooperate.
- **Docker boundary**: In persistent mode, the Docker volume is the security boundary. Protect it accordingly.
- **No external calls**: The backend only communicates with the configured OPNet RPC endpoint. No telemetry, no third-party services.

## Out of Scope (Future)

- Multiple wallet accounts (only index 0 for now)
- Hardware wallet integration
- Multi-chain support
- Automatic UTXO management / coin selection optimization
- Transaction history / explorer
- Role-based access control for multi-operator setups
