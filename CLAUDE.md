@~/projects/OVERRIDES.md

# CLAUDE.md — Ötzi

## Project Overview

Self-hosted threshold Bitcoin vault. T-of-N parties run a FROST distributed key generation ceremony that produces one Taproot key; any T of them jointly sign spends from its address. Runs on Docker, Linux and Windows.

The server holds only public data (vault public key package, address book, users, hosting). Key shares live in password-encrypted share files held by the parties.

## Architecture

```
Frontend (React/Vite)  →  Backend (Express/Node)  →  Relay (Go WebSocket)
     src/                   backend/src/               relay/
                                  ↓
                         Esplora REST API (mempool.space or self-hosted)
```

- **Frontend**: React 18, Vite, TypeScript. No CSS framework — inline styles with CSS variables. Runs all key material operations (DKG, signing, share encryption) in the browser.
- **Backend**: Express, TypeScript. Serves frontend + API, proxies `/ws` to the relay, builds transactions, verifies signatures, broadcasts via Esplora.
- **Relay**: Go, nhooyr.io/websocket. E2E encrypted message relay for ceremonies.

## Key Principles

- **Derive from runtime state** — never hardcode values that can be derived from window.location, process.env, config or the vault key. The vault address, threshold and party count are derived from the stored public key package. State never lies; config files get stale.
- **Every signer sees what it signs** — signers compute sighashes from the transaction they approved, never from hashes handed to them.
- **Dark theme default** — terminal aesthetic (black bg, orange accent, monospace).
- **Alpha software** — no backward compatibility needed. Breaking changes acceptable.
- **One instance = one vault key** — no multi-vault support.

## Development

```bash
# Terminal 1: Frontend (Vite dev server)
BACKEND_PORT=9080 npm run dev

# Terminal 2: Backend (auto-reload via tsx watch)
DATA_DIR=/tmp/otzi-dev PORT=9080 RELAY_PORT=9081 npm run dev:backend

# Terminal 3: Relay (Go — may need PATH adjustment)
PATH="/usr/local/go/bin:$PATH" npm run dev:relay -- -addr :9081

# Tests
npm test                  # frontend libs (node:test + tsx)
cd backend && npm test    # backend libs
cd relay && go test ./...
```

Ports 8080/8081 are occupied on dev machine. Use 9080/9081.

## Build & Deploy

```bash
docker build -t otzi .                       # Docker
./install.sh --domain vault.example.com      # Linux (with or without sudo)
sudo dpkg -i otzi_*.deb                      # Debian/Ubuntu
```

GitHub Actions builds tarball + zip + .deb on tagged releases (`v*`).

## Networks

| Network | Address HRP | Default chain API |
|---------|-------------|-------------------|
| `mainnet` | `bc` | `https://mempool.space/api` |
| `testnet4` | `tb` | `https://mempool.space/testnet4/api` |
| `signet` | `tb` | `https://mempool.space/signet/api` |

The chain API URL can be overridden per instance in Settings (`esploraUrl`).

## Vault Key Model

| Field | What it is | Used for |
|-------|-----------|----------|
| `untweakedVerifyingKey` | FROST group key, BIP341 internal key (33-byte SEC1) | Deriving the vault address: `p2tr(xOnly(key))` |
| `verifyingKey` | Tweaked group key, BIP341 output key | BIP340 signature verification, output script |
| `verifyingShares` | Per-party public shares (tweaked + untweaked) | Cheater detection during aggregation |
| `keyPackage` (share file only) | One party's secret signing share | FROST signing — never leaves the browser |

The vault address is key-path-only Taproot (no script tree).

## Ceremonies

- **DKG**: join → commit (FROST round 1) → shares (FROST round 2) → verify (all N parties sign a transcript message under the new key) → complete (download share file).
- **Send**: leader prepares tx on backend → reviews → creates relay session for T parties → broadcasts `PROPOSAL:` (unsigned tx + prevouts) → each joiner reviews and approves → FROST signing → leader aggregates, broadcasts `FROST-COMPLETE:`, backend verifies and broadcasts.
- Leader-driven state sync: `FROST-STATE:<partyId>:<round>:<sentRounds>` every 500ms; leader advances rounds, joiners follow.

## Authentication

- `password` (default): one admin password; signing parties need only a session code and their share file.
- `accounts`: named users (admin/user) signing in with a passkey (`@simplewebauthn`) or a Bitcoin wallet message signature (BIP-322 simple or legacy signmessage). Invites register new users.

## Address Book

Stored in config, edited in Settings, imported/exported as `.otzi.json` (`kind: "otzi-address-book"`). Import offers merge (by address) or replace. Schema at `docs/otzi-address-book-schema.json`. Labels show in the send form and on the signer approval screen.

## Nginx Requirement

When behind nginx, `proxy_buffering off` is **required** in the location block. Without it, WebSocket frames can be silently dropped, causing one-directional relay delivery failures.

## File Conventions

- Contracts for every interface live in `facts/INTERFACES.md` — update it before changing an interface.
- Backend types at `backend/src/lib/types.ts`, frontend types at `src/lib/vault-types.ts` (intentional duplication — security boundary).
- Shared hex utilities in `src/lib/hex.ts` (toHex, fromHex, uint8ToBase64)
- `data/` directory is gitignored (dev data, session context)

## Encrypted Backups

Full instance snapshot: config (vault public key package, address book, hosting, auth settings) plus users, invites and visibility. Same encryption as encrypted-persistent config. Restore works on fresh instances (install wizard) and initialized instances (Settings). Backups contain no key shares — those live only in share files.

## Dependencies

- `@mwaddip/frots` — FROST (RFC 9591) secp256k1-tr: DKG, signing, aggregation
- `@scure/btc-signer` — addresses, transaction building, BIP341 sighashes (frontend + backend)
- `@noble/curves`, `@noble/hashes` — BIP340 verification, signmessage recovery, tagged hashes
- `@simplewebauthn/server`, `@simplewebauthn/browser` — passkeys

## Git Workflow

- All work on `master` branch
- Tag releases as `vX.Y.Z` to trigger GitHub Actions
- Commit messages: conventional commits (feat/fix/docs)
- Always commit from project root (`cd /home/mwaddip/projects/otzi`)
