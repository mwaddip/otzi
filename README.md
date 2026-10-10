# Ötzi

Self-hosted threshold Bitcoin vault.

Ötzi lets a group of N people hold bitcoin together so that any T of them can spend it and no smaller group can. The parties run a distributed key generation ceremony in their browsers that produces a single Taproot address. Each party keeps an encrypted share file; spending requires T parties to approve and sign. Nobody — not the server, not any single party — ever holds the whole key.

> **Note:** The FROST library ([frots](https://github.com/mwaddip/frots)) is a byte-for-byte validated TypeScript port of the audited ZF `frost-secp256k1-tr` Rust reference. The Ötzi integration — ceremony wiring, transaction construction and signature injection — has not been audited. Use testnet4 or signet until it has been reviewed.

## How it works

### Key generation (DKG ceremony)

1. **One party creates** a session, choosing the threshold T and the number of parties N.
2. **The others join** with the session code or link.
3. Every party compares the **session fingerprint** with the others (on a call, for example) and confirms it. Nothing secret is sent before a party confirms.
4. The ceremony runs three steps over the encrypted relay: **Commit** and **Shares** (the two FROST key generation rounds), then **Verify**, where all N parties sign a transcript message with the new key to prove everyone ended up with the same, working key. The ceremony completes only once every party has verified.
5. Each party **downloads a password-encrypted share file** and checks that the vault address shown matches everyone else's.

The vault address is a standard key-path Taproot address (`bc1p…` / `tb1p…`). Fund it from any wallet.

### Sending

1. A user enters a **recipient** (typed or picked from the address book), an **amount** (BTC, mBTC, µBTC or sats, or "max") and a **fee rate**.
2. The server builds the unsigned transaction from the vault's confirmed coins. The initiator **reviews** recipient, amount, fee and change, loads their share file and opens a signing session.
3. Each co-signer joins with the session code and their share file. Their browser receives the unsigned transaction, decodes it, and shows exactly what it pays, next to the session fingerprint to compare with the initiator. They **approve or reject**; a rejection ends the session for everyone. Every signer computes the transaction's signature hashes itself.
4. Two FROST rounds produce one Schnorr signature per input. The server verifies every signature and broadcasts the transaction. Transactions signal replace-by-fee.

### Address book

Name the addresses you pay. Labels appear in the send form and on every co-signer's approval screen. Address books are saved and imported as `.otzi.json` files; on import you choose to merge with or replace the current book.

### Relay

All ceremony messages pass through an **end-to-end encrypted WebSocket relay** built into the app. The relay only forwards ciphertext. Each browser checks that the relay reports its own key unchanged, and each session shows a 96-bit fingerprint of all parties' keys (`xxxx-xxxx-xxxx-xxxx-xxxx-xxxx`). A relay that substitutes keys produces different fingerprints for different parties.

## Install

### Linux (one command)

```bash
curl -sL https://github.com/mwaddip/otzi/releases/latest/download/install.sh | bash
```

Downloads the latest release, creates systemd services, and configures
nginx or apache if detected. Works with or without sudo — without sudo it
installs to `~/.otzi/` with user-level services.

### Debian/Ubuntu (.deb)

```bash
curl -sLO https://github.com/mwaddip/otzi/releases/latest/download/otzi_*.deb
sudo dpkg -i otzi_*.deb
```

Installs to `/opt/otzi/`, creates system user, configures nginx,
and prompts for port and domain via debconf.

### Docker

```bash
docker run -d -p 80:80 -p 443:443 -v otzi-data:/data ghcr.io/mwaddip/otzi:latest
```

Or with Docker Compose:

```bash
git clone https://github.com/mwaddip/otzi && cd otzi && docker compose up -d
```

### Build from source

```bash
git clone https://github.com/mwaddip/otzi && cd otzi
sudo ./install.sh --deps     # install Node 20 + Go 1.23
sudo ./install.sh --build    # build and install as systemd services
```

### Windows

Download the [latest release](https://github.com/mwaddip/otzi/releases/latest)
zip, extract, and run `start.bat`. Requires [Node.js](https://nodejs.org/) in
your PATH. Open http://localhost:8080 in your browser.

### Installer options

| Command | Description |
|---------|-------------|
| `sudo ./install.sh` | Download latest release and install |
| `sudo ./install.sh --build` | Build from source and install |
| `sudo ./install.sh --deps` | Install build dependencies (Node 20, Go 1.23) |
| `sudo ./install.sh --uninstall` | Stop services, remove files |
| `sudo ./install.sh --yes` | Skip confirmation prompts |

<details>
<summary>Docker details</summary>

#### Ports

| Port | Service | Description |
|------|---------|-------------|
| **80** | Caddy | HTTP — serves the frontend and proxies `/api` + `/ws` to the backend |
| **443** | Caddy | HTTPS — active when a domain is configured with Let's Encrypt |
| **8080** | Backend | Direct access (bypasses Caddy) |

#### Custom domain and HTTPS

The Docker image includes [Caddy](https://caddyserver.com/) with automatic
Let's Encrypt HTTPS. Configure it from **Settings > Hosting**.

#### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Backend HTTP port |
| `RELAY_PORT` | `8081` | Internal relay WebSocket port |
| `DATA_DIR` | `/data` | Persistent data directory |
| `CADDYFILE_PATH` | `/etc/caddy/Caddyfile` | Caddy configuration file |
| `XDG_DATA_HOME` | `/data/caddy` | Caddy certificate/data storage |

</details>

## Setup

The first visit opens the install wizard:

1. **Network** — `mainnet`, `testnet4` or `signet`.
2. **Sign-in** — an admin password (default), or **accounts**: named users who sign in with a passkey or a Bitcoin wallet signature, with invites for new users.
3. **Storage mode** (password sign-in) — how the server keeps its configuration.

Then run the DKG ceremony with your co-signers.

### Storage modes

| Mode | Description |
|------|-------------|
| **Persistent** | Config stored as plaintext JSON. For trusted environments. |
| **Encrypted Persistent** | Config encrypted with AES-256-GCM on disk. Password required on each restart. |
| **Encrypted Portable** | Config lives only in server memory. The admin downloads an encrypted backup and restores it after each server restart. Nothing is written to disk. |

The configuration contains no key shares — only the vault's public key data, the address book, hosting settings and users. Losing it does not lose funds: the share files are what control the vault. See [`docs/portable-mode.md`](docs/portable-mode.md).

### Blockchain data

Balances, coins, fee estimates and broadcasting use an [Esplora](https://github.com/Blockstream/esplora)-compatible API — `mempool.space` by default. Point the instance at your own mempool or electrs server in **Settings > Instance** to keep your vault address private.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Ötzi                                           │
│                                                 │
│  :80/:443  Web server (nginx/apache/Caddy)      │
│            └── reverse proxy ──> :8080          │
│                                                 │
│  :8080  Express backend                         │
│         ├── /api/*    REST endpoints            │
│         ├── /ws       proxied to relay :8081    │
│         └── /*        static frontend (Vite)    │
│                                                 │
│  :8081  Go relay (internal, not exposed)        │
│                                                 │
│  /var/lib/otzi  (or /data in Docker)            │
└─────────────────────────────────────────────────┘
               │
               └──> Esplora API (mempool.space or self-hosted)
```

### Repository structure

```
├── src/                  # React frontend (Vite)
│   ├── components/       # InstallWizard, SignIn, DKGWizard, VaultPage,
│   │                     # BtcSend, SendSession, ProposalReview, FrostSign,
│   │                     # Settings, AddressBook, UserManager
│   └── lib/              # FROST ceremony codecs, share files, transaction
│                         # analysis, relay client, API client, crypto
├── backend/              # Node.js/Express backend
│   └── src/
│       ├── lib/          # ConfigStore, Esplora client, transaction building,
│       │                 # auth (passwords, passkeys, Bitcoin messages), users
│       ├── routes/       # config, btc, address-book, auth, users, hosting
│       └── server.ts     # Express entry point + WS proxy
├── relay/                # Go WebSocket relay server
├── facts/                # Design by Contract interface inventory
├── docs/                 # User guide, signing flows, portable mode, schemas
├── install.sh            # Universal Linux installer
├── start.bat             # Windows launcher
├── Dockerfile            # Multi-stage Docker build
├── docker-compose.yml    # Docker Compose deployment
└── entrypoint.sh         # Docker entrypoint (relay + Caddy + backend)
```

## Development

Run three processes in separate terminals:

```bash
# Terminal 1: Frontend (Vite dev server on :5173)
npm install
npm run dev

# Terminal 2: Backend (Express on :8080)
npm run dev:backend

# Terminal 3: Relay (Go on :8081)
npm run dev:relay
```

The Vite dev server proxies `/api` and `/ws` to the backend on port 8080.

Tests: `npm test` (frontend libraries), `cd backend && npm test`, `cd relay && go test ./...`.

### Prerequisites

- Node.js 20+
- Go 1.23+

## Security

- **Threshold signing**: FROST (RFC 9591, secp256k1-SHA256-TR) produces standard BIP340 Schnorr signatures. No single party holds the private key.
- **Signers see what they sign**: every co-signer decodes the unsigned transaction, reviews recipients, amount and fee, and computes the signature hashes itself before approving.
- **Verified key generation**: the DKG ends with all N parties signing under the new key and completes only once every party has verified; inconsistent or cheating parties are detected and named.
- **E2E relay encryption**: ECDH (P-256) + AES-256-GCM per peer. The relay only forwards ciphertext. Each client checks its own key in the relay's key map; parties compare a 96-bit session fingerprint, and DKG parties confirm it before any secret share is sent.
- **Single-use nonces**: every FROST nonce pair signs exactly once, over a commitment list fixed to the session's participants. A co-signer impersonating another aborts the session.
- **Share file encryption**: AES-256-GCM with a PBKDF2-derived key (600k iterations, SHA-256), in the browser. Share passwords never leave the browser.
- **No secrets on the server**: the server stores public key data only.
- **Pre-broadcast verification**: the server verifies every Schnorr signature before broadcasting, and broadcasts each prepared transaction at most once.

## License

MIT
