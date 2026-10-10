# Ötzi — Interface Contracts

An inventory of the system's interfaces and contracts, documented according to
Bertrand Meyer's **Design by Contract** philosophy: every module supplier
publishes what it requires (preconditions), what it guarantees (postconditions),
and what must always hold (invariants).

Ötzi is a self-hosted Bitcoin vault. T-of-N parties hold FROST key shares of a
single Taproot key; any T of them jointly sign spends. The server holds only
public data.

---

## Table of Contents

1. [Configuration Model](#1-configuration-model)
2. [ConfigStore](#2-configstore)
3. [Encryption](#3-encryption)
4. [Share File (v4)](#4-share-file-v4)
5. [Ceremony Blob Envelope](#5-ceremony-blob-envelope)
6. [DKG Ceremony Protocol](#6-dkg-ceremony-protocol)
7. [FROST Signing Protocol](#7-frost-signing-protocol)
8. [Send Proposal Protocol](#8-send-proposal-protocol)
9. [RelayClient](#9-relayclient)
10. [Relay Server](#10-relay-server)
11. [Chain Client (Esplora)](#11-chain-client-esplora)
12. [REST API — Config Routes](#12-rest-api--config-routes)
13. [REST API — BTC Routes](#13-rest-api--btc-routes)
14. [REST API — Address Book Routes](#14-rest-api--address-book-routes)
15. [Address Book File](#15-address-book-file)
16. [Authentication](#16-authentication)
17. [REST API — Auth Routes](#17-rest-api--auth-routes)
18. [REST API — User and Invite Routes](#18-rest-api--user-and-invite-routes)
19. [REST API — Hosting Routes](#19-rest-api--hosting-routes)
20. [Frontend API Client](#20-frontend-api-client)
21. [Cross-Cutting Contracts](#cross-cutting-contracts)

---

## 1. Configuration Model

**Modules:** `backend/src/lib/types.ts` (backend), `src/lib/vault-types.ts` (frontend)

### Types

| Type | Definition | Invariants |
|---|---|---|
| `NetworkName` | `'mainnet' \| 'testnet4' \| 'signet'` | Fixed at init. Mainnet addresses use HRP `bc`, testnet4 and signet use `tb`. |
| `StorageMode` | `'persistent' \| 'encrypted-persistent' \| 'encrypted-portable'` | Fixed at init. |
| `AuthMode` | `'password' \| 'accounts'` | Fixed at init. `accounts` implies `storageMode === 'persistent'`. |
| `VaultKey` | FROST `PublicKeyPackage`, hex-encoded (see below) | Present iff the DKG ceremony has been saved. |
| `AddressBookEntry` | `{ label: string; address: string; note?: string }` | `label` trimmed, 1–64 chars. `address` valid for the instance network. `note` ≤ 256 chars. |
| `HostingConfig` | `{ domain, port?, path?, httpsEnabled, httpsStatus?, httpsError? }` | `httpsStatus` only set when `httpsEnabled`. `httpsError` only set when `httpsStatus === 'error'`. |
| `VaultConfig` | see below | `version === 2`. `addressBook` is always an array. Addresses in `addressBook` are unique. |

```ts
interface VaultKey {
  minSigners: number;                               // threshold T
  verifyingKey: string;                             // 33-byte SEC1 hex — BIP341 output key
  untweakedVerifyingKey: string;                    // 33-byte SEC1 hex — BIP341 internal key
  verifyingShares: Record<string, string>;          // FROST identifier ("1".."N") → 33-byte SEC1 hex (tweaked)
  untweakedVerifyingShares: Record<string, string>; // same keys, untweaked
}

interface VaultConfig {
  version: 2;
  network: NetworkName;
  storageMode: StorageMode;
  authMode: AuthMode;
  adminPasswordHash?: string;   // scrypt "salt:hash", password mode only
  esploraUrl?: string;          // chain API override (see §11)
  vault?: VaultKey;
  addressBook: AddressBookEntry[];
  hosting?: HostingConfig;
}
```

### Derived values

Values derived from `VaultConfig` are computed on demand and never stored.

| Value | Derivation |
|---|---|
| Threshold `T` | `vault.minSigners` |
| Party count `N` | number of keys in `vault.verifyingShares` |
| Vault address | `p2tr(xOnly(vault.untweakedVerifyingKey), network)` — key-path-only Taproot, BIP341 tweak with empty script tree. Its output key equals `xOnly(vault.verifyingKey)`. |
| Vault output script | `OP_1 <xOnly(vault.verifyingKey)>` |
| Chain API URL | `esploraUrl` if set, otherwise the network default (§11) |
| Explorer URL | Chain API URL with a trailing `/api` removed |

### `publicConfig(config): PublicConfig`

| Aspect | Contract |
|---|---|
| **Precondition** | `config` is a valid `VaultConfig`. |
| **Postcondition** | Returns a copy without `adminPasswordHash`, plus derived fields `hasAdminPassword: boolean`, `chainApiUrl: string`, and `vaultAddress?: string` (present iff `vault` is present). Never mutates the input. |

### `defaultConfig(network, storageMode, authMode): VaultConfig`

| Aspect | Contract |
|---|---|
| **Postcondition** | Returns `{ version: 2, network, storageMode, authMode, addressBook: [] }` — no `vault`, no `hosting`, no `esploraUrl`, no `adminPasswordHash`. |

---

## 2. ConfigStore

**Module:** `backend/src/lib/config-store.ts`

Single source of truth for server-side state. Holds the `VaultConfig` in memory
and persists it according to the storage mode.

### Class Invariants

- At most one `VaultConfig` is held in memory (`this.config`).
- `encrypted-portable` mode never writes to disk.
- The file at `$DATA_DIR/config.json` is either plaintext JSON (`persistent`) or
  an encrypted blob (`encrypted-persistent`) — never a hybrid.
- In `encrypted-persistent` mode the storage password supplied to `init()` or
  `load()` is held in memory for the lifetime of the loaded config and used for
  every subsequent `persist()`.

### `isInitialized(): boolean`

| Aspect | Contract |
|---|---|
| **Postcondition** | `true` iff a config is loaded in memory OR a config file exists. Pure query. |

### `init(network, storageMode, authMode, password?): void`

| Aspect | Contract |
|---|---|
| **Precondition** | `isInitialized() === false`. `password` is provided when `storageMode === 'encrypted-persistent'`. |
| **Postcondition** | `this.config = defaultConfig(...)`, with `hosting` taken from `$DATA_DIR/hosting-seed.json` if present (the seed file is then deleted). Persisted (unless portable). |
| **Exception** | `'Already initialized'`; `'Password required for encrypted-persistent mode'`. |

### `load(password?): VaultConfig`

| Aspect | Contract |
|---|---|
| **Precondition** | A config file exists. For an encrypted file, `password` decrypts it. |
| **Postcondition** | Config loaded; storage password retained for encrypted files. Idempotent when already loaded. |
| **Exception** | `'Not initialized'`; `'Password required to unlock'`; decryption failure on a wrong password. |

### `get(): VaultConfig`

| Aspect | Contract |
|---|---|
| **Precondition** | Config loaded. |
| **Postcondition** | Returns the in-memory config. Pure query. |
| **Exception** | `'Config not loaded'`. |

### `update(patch): VaultConfig`

| Aspect | Contract |
|---|---|
| **Precondition** | Config loaded. |
| **Postcondition** | `this.config` is the shallow merge of the old config and `patch`. Persisted with the retained storage password (unless portable). Returns the new config. |

### `replace(config, password?): void`

| Aspect | Contract |
|---|---|
| **Precondition** | `config` is a valid `VaultConfig`. For `encrypted-persistent`, `password` is provided. |
| **Postcondition** | `this.config = config`; storage password retained; persisted (unless portable). Used by restore. |

### `reset(): void`

| Aspect | Contract |
|---|---|
| **Postcondition** | Memory cleared, storage password cleared, config file deleted. `isInitialized() === false`. |

---

## 3. Encryption

### Share and backup encryption (browser) — `src/lib/crypto.ts`

- PBKDF2-SHA256, 600,000 iterations, 16-byte random salt, 12-byte random IV, AES-256-GCM.
- Wire format: `base64(salt[16] || iv[12] || ciphertext||tag)`.

| Function | Contract |
|---|---|
| `encrypt(data, password)` | Fresh salt and IV per call. Same input yields a different ciphertext each call. |
| `decrypt(encoded, password)` | `decrypt(encrypt(d, pw), pw) === d`. Throws on wrong password or corruption (GCM tag failure). |

### Config and backup encryption (server) — `backend/src/lib/encryption.ts`

- PBKDF2-SHA256, 600,000 iterations, 16-byte salt, 12-byte IV, AES-256-GCM.
- Wire format: `base64(salt[16] || iv[12] || tag[16] || ciphertext)`.
- `decryptConfig(encryptConfig(s, pw), pw) === s`. Throws on wrong password.

---

## 4. Share File (v4)

**Module:** `src/lib/share-file.ts`

Each party's secret FROST key share, encrypted with a password chosen by that
party. Share files never leave the party's browser except as a download.

### File format (JSON on disk)

```ts
interface ShareFile {
  version: 4;
  network: NetworkName;
  internalKey: string;   // 33-byte SEC1 hex — vault BIP341 internal key
  partyId: number;       // 0-based party index; FROST identifier = partyId + 1
  threshold: number;     // T
  parties: number;       // N
  encrypted: string;     // §3 browser encryption of the UTF-8 JSON payload
}

// Decrypted payload
interface SharePayload {
  keyPackage: {
    identifier: string;              // decimal
    signingShare: string;            // 32-byte hex scalar
    verifyingShare: string;          // 33-byte SEC1 hex
    verifyingKey: string;            // 33-byte SEC1 hex
    minSigners: number;
    untweakedVerifyingKey: string;   // 33-byte SEC1 hex
    untweakedSigningShare: string;   // 32-byte hex scalar
    untweakedVerifyingShare: string; // 33-byte SEC1 hex
  };
  publicKeyPackage: VaultKey;        // §1
}
```

Download filename: `otzi-share-<network>-p<partyId+1>-<last 8 chars of vault address>.json`.

### `encryptShareFile(keyPackage, publicKeyPackage, network, partyId, password): Promise<ShareFile>`

| Aspect | Contract |
|---|---|
| **Precondition** | `keyPackage` and `publicKeyPackage` come from the same `dkgFinalize`. `keyPackage.identifier === partyId + 1`. |
| **Postcondition** | Returns a v4 `ShareFile` whose header is derived from the packages. |

### `decryptShareFile(file, password): Promise<DecryptedShare>`

| Aspect | Contract |
|---|---|
| **Precondition** | `file` parsed from JSON. |
| **Postcondition** | Returns `{ network, internalKey, partyId, threshold, parties, keyPackage, publicKeyPackage }` with frots-native types (bigints, `Uint8Array`s, `Map`s). Every check below has passed. |
| **Checks** | `version === 4`. `keyPackage.identifier === partyId + 1`. `keyPackage.untweakedVerifyingKey`, `publicKeyPackage.untweakedVerifyingKey` and `internalKey` are equal. `keyPackage.verifyingKey === publicKeyPackage.verifyingKey`. `keyPackage.verifyingShare === publicKeyPackage.verifyingShares[identifier]`. `G·signingShare === verifyingShare` and `G·untweakedSigningShare === untweakedVerifyingShare`. `minSigners === threshold`. Share count `=== parties`. |
| **Exception** | Wrong password (GCM failure); `'Unsupported share file version'`; `'Share file is corrupted'` on any failed check. |

### Vault membership

Before a decrypted share is used, the caller compares `network` with the
instance network and, when the instance config is readable, `internalKey` with
`vault.untweakedVerifyingKey`. A mismatch is rejected with
`'This share file belongs to a different vault'`.

---

## 5. Ceremony Blob Envelope

**Module:** `src/lib/dkg.ts`

### Envelope invariants

- Every blob is `base64(JSON({ v: 2, type, from, to, sid, data }))`.
- `type ∈ { 'session', 'frost-r1', 'frost-r2', 'frost-sign-r1', 'frost-sign-r2' }`.
- `sid` is the first 16 hex characters of the 32-byte session ID.
- `to === -1` is a broadcast; `to >= 0` addresses one party.
- `data` is hex-encoded binary payload.
- A receiver drops blobs whose `sid` differs from its session, whose `from` is
  itself, or whose `to` is neither `-1` nor its own party ID.

### Blob types

| Type | Layout of `data` | Sender → Receiver |
|---|---|---|
| `session` | UTF-8 JSON `{ t, n, network, sid }` (`sid` = full 32-byte hex) | party 0 → all |
| `frost-r1` | `1B partyId ‖ 1B count ‖ count×33B commitment ‖ 33B proof.R ‖ 32B proof.z (BE)` | each → all |
| `frost-r2` | `1B sender partyId ‖ 1B recipient partyId ‖ 32B signingShare (BE)` | each → each other (private) |
| `frost-sign-r1` | `1B partyId ‖ 1B count ‖ count×(2B identifier LE ‖ 33B hiding ‖ 33B binding)` | each signer → all |
| `frost-sign-r2` | `1B partyId ‖ 1B count ‖ count×(2B identifier LE ‖ 32B share BE)` | each signer → all |

`partyIdToFrostId(p) = BigInt(p + 1)`; `frostIdToPartyId(id) = Number(id) - 1`.

Decoders return `null` (never throw) on malformed input.

---

## 6. DKG Ceremony Protocol

**Modules:** `src/components/DKGWizard.tsx`, `src/lib/dkg.ts`, `@mwaddip/frots`

Generates the vault key. All N parties run the ceremony in their own browsers
over one relay session. No party ever holds another party's share.

### Parameters

- `2 <= T <= N <= maxParties`, where `maxParties` is reported by the relay (§10).
- `network` is the instance network.

### Steps

| Step | Action | Advances when |
|---|---|---|
| `join` | Party 0 creates a relay session for N parties; others join with the session code. On relay `ready`, party 0 generates a 32-byte session ID and broadcasts the `session` blob. Joiners accept the `session` blob only from party 0 and only if `network` equals their instance network. | Session config known. |
| `commit` | `dkgRound1(id, N, T, rng)`; broadcast `frost-r1`. | All N round-1 packages collected (own included), then `BARRIER:commit:<partyId>` received from all N. |
| `shares` | `dkgRound2(secret, received)` (verifies every proof of knowledge); send one private `frost-r2` per peer. | N−1 round-2 packages collected, then `BARRIER:shares:<partyId>` received from all N. |
| `verify` | `dkgFinalize(...)` (verifies every received share). Then all N parties FROST-sign the verification message `M` (below) with `tweaked: true`: broadcast one `frost-sign-r1` commitment, after N commitments broadcast one `frost-sign-r2` share, after N shares each party runs `signAggregate` with its own full `publicKeyPackage` and checks the signature with `verifySignature(sig, M, verifyingKey)`. | Own aggregate signature verifies. |
| `complete` | Shows the vault address, session fingerprint and a share-file download. | — |

### Verification message

```
M = taggedHash("Otzi/dkg-verify",
      sid[32] ‖ ascii(network) ‖ untweakedVerifyingKey[33] ‖ verifyingKey[33] ‖ u8(T) ‖
      for each identifier ascending: u16le(id) ‖ untweakedVerifyingShare[33] ‖ verifyingShare[33])
taggedHash(tag, x) = SHA256(SHA256(tag) ‖ SHA256(tag) ‖ x)
```

Each party computes `M` from its own view of the ceremony.

### Postconditions

- On success every party holds a `keyPackage` for the same vault key, and has
  proven it by contributing to a valid signature under that key.
- A party that sent inconsistent commitments or shares makes `dkgRound2`,
  `dkgFinalize` or the verify aggregation fail; frots' cheater detection names
  the offending identifier in the error.
- On completion, any party holding an admin session saves the vault with
  `POST /api/dkg/save` when it downloads its share file.

### Connecting an existing vault

Instead of running the ceremony, an admin can load an existing share file for
the instance network. After `decryptShareFile` succeeds, its `publicKeyPackage`
is saved with `POST /api/dkg/save`.

### Invariants

- Ceremony state lives only in browser memory. A page refresh aborts the ceremony.
- Barrier messages are `BARRIER:<step>:<partyId>`.

---

## 7. FROST Signing Protocol

**Modules:** `src/components/FrostSign.tsx`, `src/lib/frost-sign.ts`

2-round FROST (RFC 9591, secp256k1-SHA256-TR) producing one BIP340 signature
per sighash, batched in one ceremony.

### Types

| Type | Definition |
|---|---|
| `SighashInfo` | `{ index: number; hash: string /* 32-byte hex */; type: 'key-path' }` |
| `FrostSignatureSet` | `{ signatures: Array<{ index: number; signature: string /* 64-byte hex */ }> }` |

### FrostSign component contract

| Aspect | Contract |
|---|---|
| **Props** | `sighashes`, `share: DecryptedShare`, `isLeader`, `relayClient`, `relayReady`, `onSignaturesReady(sigs)`, `onCancel`. |
| **Precondition** | Every signer computed the same `sighashes` independently (§8). |
| **Round 1** | For each sighash: `signRound1(keyPackage, rng)`. Broadcast one `frost-sign-r1` blob carrying all commitments. |
| **Round 2** | After `T` commitment sets: for each sighash `signRound2(keyPackage, nonces, sighash, commitments, { tweaked: true })`. Broadcast one `frost-sign-r2` blob. |
| **Aggregate** | Leader only, after `T` share sets: `signAggregate(shares, sighash, commitments, publicKeyPackage, { tweaked: true })` with the full public key package from the share file. Broadcasts `FROST-COMPLETE:` + JSON signature array. |
| **Joiner completion** | On `FROST-COMPLETE:` from the leader, the joiner verifies every signature with `verifySignature(sig, sighash, verifyingKey)` and reports failure instead of completing if any signature is invalid. |
| **State sync** | `FROST-STATE:<partyId>:<round>:<sentRounds>` every 500 ms and on change. Receiving a peer's state re-sends this party's blob for the peer's round. Joiners follow the leader's round. |
| **Envelope sid** | The first sighash. |

---

## 8. Send Proposal Protocol

**Modules:** `src/components/VaultPage.tsx`, `src/components/ProposalReview.tsx`, `src/lib/bitcoin.ts`

Every signer sees and approves exactly what it signs. Sighashes are computed by
each signer from the transaction itself.

### `SendProposal`

```ts
interface SendProposal {
  network: NetworkName;
  tx: string;                       // unsigned transaction, hex, no witness data
  prevouts: Array<{ txid: string; vout: number; amount: number; script: string }>;
}
```

### Relay messages

| Message | Direction | Meaning |
|---|---|---|
| `PROPOSAL:` + base64(JSON `SendProposal`) | leader (party 0) → all | Sent on relay `ready` and in answer to every `PROPOSAL-REQ`. |
| `PROPOSAL-REQ:<partyId>` | joiner → all | Sent every 2 s until a proposal is received. |
| `REJECT:<partyId>` | joiner → all | The joiner declined. The leader shows the rejection and ends the session. |

Joiners accept `PROPOSAL:` only from party 0.

### `analyzeProposal(proposal, vault, network): ProposalAnalysis`

| Aspect | Contract |
|---|---|
| **Precondition** | `vault` is the `publicKeyPackage` from the signer's own share file (or, for the leader before the share is loaded, the instance `VaultKey`). |
| **Postcondition** | Returns `{ txid, inputs, outputs: Array<{ address, amount, isChange }>, totalIn, totalOut, fee, vsize, feeRate, sighashes }`. `isChange` ⇔ output script equals the vault output script. `fee = totalIn − totalOut`. `vsize` assumes one 64-byte key-path signature per input. `sighashes[i] = BIP341 SIGHASH_DEFAULT preimage hash of input i` over all prevout scripts and amounts. |
| **Rejects (throws)** | `proposal.network !== network`; input count ≠ prevout count; input `i` does not spend `prevouts[i]`; any prevout script ≠ vault output script; any input sequence ≠ `0xfffffffd`; `lockTime ≠ 0`; any output script without a standard address encoding; `fee < 0`. |
| **Guarantee** | BIP341 sighashes commit to every input amount and script, so false prevout data yields signatures that are invalid on chain; the displayed fee is the fee of any transaction these signatures can authorize. |

### Approval

- The leader reviews the analysis of the prepared transaction before creating
  the signing session, and again against its share file once loaded.
- Each joiner reviews the analysis after loading its share file and receiving the
  proposal. Signing starts only after the joiner clicks **Approve**.
- Recipients that appear in the address book are shown with their label.
- Joiners derive the transaction ID from the unsigned transaction.

---

## 9. RelayClient

**Module:** `src/lib/relay.ts`

E2E encrypted WebSocket client for ceremony coordination.

### Class Invariants

- `partyId === -1` until `create()` or `join()` resolves.
- `isReady === false` until the `ready` wire message has been processed and all
  AES keys derived.
- After `isReady`, `peerKeys` holds one AES-256-GCM key per peer, derived by
  ECDH (P-256).
- Messages arriving before `isReady` are queued and processed after the keys exist.
- `closed === true` after `close()`; reconnection is disabled.

### Methods

| Method | Precondition | Postcondition |
|---|---|---|
| `create(parties, threshold)` | `parties >= 2`, `1 <= threshold <= parties`. Fresh instance. | Session created; `partyId === 0`; resolves `{ session, url }`. |
| `join(code)` | 6-character session code. Fresh instance. | `partyId` assigned; resolves on join (before `ready`). |
| `send(to, payload)` | `isReady`. | Payload encrypted with the peer key and sent. Throws `'No AES key for party X'`. |
| `broadcast(payload)` | `isReady`. | Payload encrypted separately for each peer and sent. |
| `close()` | — | Socket closed, keys cleared, token removed. Idempotent. |

### Reconnection

Up to 10 attempts with the saved token while the keypair is in memory. After a
page reload the keys are gone and the client emits `'Encryption keys lost'`.

### Session fingerprint

`sessionFingerprint(pubkeys)` hashes all parties' ECDH public keys in party
order. Parties compare it to detect a relay that substitutes keys.

---

## 10. Relay Server

**Module:** `relay/` (Go)

| Endpoint | Contract |
|---|---|
| `GET /ws` | WebSocket. Wire messages `create`, `join`, `reconnect`, `relay`. Forwards ciphertext only. Enforces `MaxSessions`, `MaxParties`, `MaxMessageBytes`, `MaxPerIP`. |
| `GET /health` | `{ "status": "ok" }` |
| `GET /sessions` | `{ "active": <session count>, "maxParties": <MaxParties> }` |

The backend proxies `/ws` and exposes `GET /api/relay/sessions` (pass-through of
`/sessions`; `{ active: 0, maxParties: 10 }` when the relay is unreachable).

---

## 11. Chain Client (Esplora)

**Module:** `backend/src/lib/esplora.ts`

All blockchain data comes from an Esplora-compatible REST API.

### Default endpoints

| Network | Chain API URL |
|---|---|
| `mainnet` | `https://mempool.space/api` |
| `testnet4` | `https://mempool.space/testnet4/api` |
| `signet` | `https://mempool.space/signet/api` |

`VaultConfig.esploraUrl` overrides the default (e.g. a self-hosted mempool or electrs).

### Functions

| Function | Request | Contract |
|---|---|---|
| `getUtxos(base, address)` | `GET {base}/address/{address}/utxo` | Returns `Array<{ txid, vout, value, confirmed }>`. |
| `getBalance(base, address)` | `GET {base}/address/{address}` | Returns `{ confirmed, unconfirmed }` in sats: `confirmed = chain funded − chain spent`, `unconfirmed = mempool funded − mempool spent`. |
| `broadcastTx(base, hex)` | `POST {base}/tx` | Returns the txid. Throws with the API's error text on rejection. |
| `getFeeRates(base)` | `GET {base}/v1/fees/recommended`, falling back to `GET {base}/fee-estimates` | Returns `{ low, normal, high }` sat/vB (`hourFee`/`halfHourFee`/`fastestFee`, or estimates for 6/3/1 blocks). Cached per base URL for 60 s. |

Non-2xx responses throw `Error('<status> <body>')`.

---

## 12. REST API — Config Routes

**Module:** `backend/src/routes/config.ts`

### `GET /api/status`

| Aspect | Contract |
|---|---|
| **Postcondition** | `{ state: 'fresh' }` if not initialized; `{ state: 'locked' }` if an encrypted config is not unlocked; otherwise `{ state: 'ready', network, storageMode, authMode, hasVault }`. Never fails. |

### `POST /api/init`

| Aspect | Contract |
|---|---|
| **Precondition** | Not initialized. `network ∈ NetworkName`, `storageMode ∈ StorageMode`, `authMode ∈ AuthMode`. `password` when `storageMode === 'encrypted-persistent'`. Password mode: `adminPassword` (non-empty). Accounts mode: `storageMode === 'persistent'` and `admin: { label, credential: CredentialProof }` (§16). |
| **Postcondition** | Instance initialized. Password mode: admin password hash stored; returns `{ ok, token, role: 'password-admin' }`. Accounts mode: credential verified, first admin user created; returns `{ ok, token, role: 'admin' }`. |
| **Error** | 400 invalid input or failed credential proof; 409 already initialized. |

### `POST /api/unlock`

| Aspect | Contract |
|---|---|
| **Precondition** | `password`. Encrypted config on disk, not yet loaded. |
| **Postcondition** | Config decrypted and loaded; storage password retained. Returns `{ ok: true }`. |
| **Error** | 400 missing password; 401 wrong password or corrupted file. |

### `POST /api/admin/unlock`

| Aspect | Contract |
|---|---|
| **Precondition** | Password mode. `password` matches `adminPasswordHash`. |
| **Postcondition** | Returns `{ ok: true, token }` with role `password-admin`. |
| **Error** | 400 missing password or no admin password set; 401 wrong password; 503 config not loaded. |

### `GET /api/config` — read

| Aspect | Contract |
|---|---|
| **Postcondition** | `publicConfig(config)` (§1). |
| **Error** | 503 config not loaded. |

### `POST /api/config/chain` — admin

| Aspect | Contract |
|---|---|
| **Precondition** | `esploraUrl` is `null` (use the network default) or an `http(s)://` URL. |
| **Postcondition** | `esploraUrl` stored (trailing `/` removed) or cleared. Returns `{ ok: true, chainApiUrl }`. |

### `POST /api/dkg/save` — admin

| Aspect | Contract |
|---|---|
| **Precondition** | `vault: VaultKey`. `2 <= minSigners <= N`. Identifiers are exactly `"1".."N"` in both share maps. Every key is a valid compressed secp256k1 point. `xOnly(verifyingKey)` equals the BIP341 key-path tweak of `xOnly(untweakedVerifyingKey)`. |
| **Postcondition** | `config.vault` set. Returns `{ ok: true, vaultAddress }`. Saving an identical vault again is a no-op success. |
| **Error** | 400 invalid key data; 409 a different vault is already saved. |

### `POST /api/backup` — admin

| Aspect | Contract |
|---|---|
| **Precondition** | `password`. |
| **Postcondition** | Returns `{ encrypted }` = server encryption (§3) of `JSON({ version: 2, timestamp, config, users: { users, invites, settings } })`. |

### `POST /api/restore`

| Aspect | Contract |
|---|---|
| **Precondition** | `encrypted`, `password`. On an initialized instance: an admin token. |
| **Postcondition** | Backup decrypted; `config` replaces the current config (the backup password becomes the storage password when the backup's storage mode is `encrypted-persistent`); users, invites and settings replace the user store. Returns `{ ok: true }`. |
| **Error** | 401 missing admin token, or wrong password / corrupted backup; 400 invalid backup format. |

### `POST /api/reset` — admin

| Aspect | Contract |
|---|---|
| **Precondition** | `confirm === 'RESET'`. |
| **Postcondition** | Config and user store wiped. Instance is `fresh`. |

---

## 13. REST API — BTC Routes

**Module:** `backend/src/routes/btc.ts`, `backend/src/lib/bitcoin.ts`

### Module Invariants

- Transactions are version 2, `lockTime` 0, every input sequence `0xfffffffd`
  (BIP125 replaceable).
- Every input is a key-path spend of the vault output script.
- `prepared: Map<challengeToken, PreparedTx>` holds unsigned transactions for 30 minutes.
- `broadcasts: Map<challengeToken, { txid }>` holds results for 1 hour.
- Dust limits: destination amount ≥ 546 sats; change below 330 sats is added to the fee.

### `GET /api/btc/balance` — read

| Aspect | Contract |
|---|---|
| **Precondition** | Vault saved. |
| **Postcondition** | Returns `{ address, confirmed, unconfirmed }` (sats) via `getBalance`. |
| **Error** | 400 no vault; 502 chain API failure. |

### `GET /api/btc/fees`

| Aspect | Contract |
|---|---|
| **Postcondition** | `{ low, normal, high }` sat/vB from `getFeeRates`. On chain API failure: `{ low: 1, normal: 5, high: 10, fallback: true }`. |

### `POST /api/btc/prepare` — user

| Aspect | Contract |
|---|---|
| **Precondition** | Vault saved. `to` is a valid address for the network. `amount` is an integer ≥ 546 or `'max'`. `0 < feeRate <= 10000`. |
| **Postcondition** | Confirmed UTXOs of the vault address are selected largest-first until they cover `amount + fee`; `'max'` spends all confirmed UTXOs with no change output and sends `total − fee`. `fee = ceil(vsize × feeRate)` with `vsize = ceil((4 × baseSize + 2 + 66 × inputs) / 4)`. Outputs: destination, then change to the vault address when change ≥ 330. Returns `{ challengeToken, proposal: SendProposal, amount, fee, change, vsize }`. |
| **Error** | 400 invalid input, no vault, or insufficient confirmed funds (`{ error, available, needed }`); 502 chain API failure. |

### `POST /api/btc/broadcast` — user

| Aspect | Contract |
|---|---|
| **Precondition** | `challengeToken` refers to a prepared transaction. `signatures` has one `{ index, signature }` per input; each signature is 64 bytes hex. |
| **Postcondition** | Every signature verifies under BIP340 against its input's sighash and `xOnly(vault.verifyingKey)` before anything is broadcast. Signatures are placed as key-path witnesses, the transaction is broadcast via `broadcastTx`, and `{ txid }` is returned. |
| **Double broadcast** | A second request for the same token returns `{ txid, alreadyBroadcast: true }`. Concurrent requests are serialized by a lock taken before any work; the lock is released on failure. |
| **Error** | 400 unknown/expired token, wrong signature count or format, or failed BIP340 verification; 502 chain API rejection. |

---

## 14. REST API — Address Book Routes

**Module:** `backend/src/routes/address-book.ts`

### `GET /api/address-book` — read

| Aspect | Contract |
|---|---|
| **Postcondition** | `{ entries: AddressBookEntry[] }`. |

### `PUT /api/address-book` — admin

| Aspect | Contract |
|---|---|
| **Precondition** | `entries` is an array of at most 1000 `AddressBookEntry` values satisfying §1 invariants for the instance network. Addresses are unique. |
| **Postcondition** | The address book is replaced by `entries` (labels and notes trimmed; empty notes dropped). Returns `{ ok: true, entries }`. |
| **Error** | 400 with the first offending entry index and reason. |

---

## 15. Address Book File

**Modules:** `src/lib/address-book.ts`, schema `docs/otzi-address-book-schema.json`

Portable `.otzi.json` file for saving, sharing and importing an address book.

```ts
interface AddressBookFile {
  kind: 'otzi-address-book';
  version: 1;
  network: NetworkName;
  entries: AddressBookEntry[];
}
```

### `parseAddressBookFile(json, network): AddressBookEntry[]`

| Aspect | Contract |
|---|---|
| **Postcondition** | Returns the entries when `kind`, `version`, `network` match and every entry satisfies §1 invariants with unique addresses. |
| **Exception** | Error naming the problem (wrong kind, unsupported version, network mismatch, or the first invalid entry). |

### `mergeAddressBooks(current, incoming): { entries, added, updated, unchanged }`

| Aspect | Contract |
|---|---|
| **Postcondition** | Entries keyed by address. Incoming entries replace the label and note of existing ones; existing addresses absent from `incoming` are kept in their original order; new addresses are appended. Counts describe the effect. |

### Import

The user chooses **Merge** (`mergeAddressBooks`) or **Replace** (the file's entries
become the book) after seeing the counts, then the result is saved with
`PUT /api/address-book`.

### Export

Downloads `{ kind, version: 1, network, entries }` as
`otzi-address-book-<network>.otzi.json`.

---

## 16. Authentication

**Modules:** `backend/src/lib/auth.ts`, `backend/src/lib/passkey.ts`, `backend/src/lib/btc-message.ts`, `backend/src/lib/users.ts`

### Modes

| Mode | Admin identity | Other users |
|---|---|---|
| `password` (default) | Holder of the admin password. | None. Signing parties join ceremonies with a session code and their share file. |
| `accounts` | Users with role `admin`. | Users with role `user`. Each user signs in with one credential: a passkey or a Bitcoin address. |

Joining a relay session with a `?session=CODE` link needs no sign-in in either mode.

### Tokens

- 32 random bytes, hex. Valid for 6 hours. Held in server memory.
- `TokenInfo = { role: 'password-admin' | 'admin' | 'user', userId?, expiresAt }`.

### Middleware

| Guard | `password` mode | `accounts` mode |
|---|---|---|
| `requireAdmin` | Token with role `password-admin`. | Token with role `admin`. |
| `requireUser` | Same as `requireAdmin`. | Token with role `admin` or `user`. |
| `requireRead` | Open. | Open when `everybodyCanRead`; otherwise any valid token. |

Every guard returns 503 `'Instance not ready'` while no config is loaded (fresh or locked).

### Challenges

- One-use, 32 random bytes hex, valid 5 minutes.
- Bitcoin sign-in message, built by the server when issuing the challenge:
  `Sign in to Otzi\nHost: <request host>\nChallenge: <challenge>`.

### Credentials (users.json)

```ts
type Credential =
  | { type: 'passkey'; id: string; publicKey: string; counter: number; transports?: string[]; rpId: string }
  | { type: 'bitcoin'; address: string };

interface User { id: string; label: string; role: 'admin' | 'user'; credential: Credential }
```

`id` is 16 random bytes hex. Passkey `id` and `publicKey` are base64url. No two
users share a passkey ID or a Bitcoin address.

### `CredentialProof`

```ts
type CredentialProof =
  | { type: 'passkey'; response: RegistrationResponseJSON }                  // from startRegistration
  | { type: 'bitcoin'; address: string; challenge: string; signature: string };
```

### Passkeys (`@simplewebauthn/server`)

| Aspect | Contract |
|---|---|
| **RP ID** | Hostname of the request's `Origin` header. Stored with the credential and required at sign-in. |
| **Expected origin** | The request's `Origin` header; its hostname must equal or be a subdomain of the RP ID. |
| **Registration** | Options: `attestationType: 'none'`, resident key required, user verification preferred. Verified with `verifyRegistrationResponse` against the stored challenge. |
| **Sign-in** | Discoverable credentials (empty `allowCredentials`). Verified with `verifyAuthenticationResponse`; the stored counter is updated. |

### Bitcoin message signatures — `verifyBitcoinMessage(address, message, signature)`

| Aspect | Contract |
|---|---|
| **Precondition** | `signature` is base64. `address` is a mainnet or test-network address. |
| **BIP-322 simple** | Signature decodes to a witness stack. P2WPKH: `[derSig‖0x01, pubkey]` with `hash160(pubkey)` matching the address; ECDSA over the BIP143 preimage of the BIP-322 `to_sign` transaction. P2TR: `[schnorrSig(64‖optional 0x00/0x01)]`; BIP340 over the BIP341 preimage, against the address's output key. |
| **Legacy (BIP-137 / signmessage)** | Signature is 65 bytes; header byte 27–42. Public key recovered from `dsha256(varstr("Bitcoin Signed Message:\n") ‖ varstr(message))`. Valid when the P2PKH, P2SH-P2WPKH or P2WPKH address of the recovered key equals `address`. |
| **Postcondition** | `true` iff one of the above verifies. Never throws. |

---

## 17. REST API — Auth Routes

**Module:** `backend/src/routes/auth.ts`

| Route | Contract |
|---|---|
| `GET /api/auth/me` | `{ authenticated: false }` or `{ authenticated: true, role, userId?, label? }`. |
| `POST /api/auth/challenge` | Returns `{ challenge, message }` (§16). |
| `POST /api/auth/bitcoin/login` | Body `{ address, challenge, signature }`. Challenge consumed; signature verified over its message. Known address → `{ authenticated: true, token, role, label }`. Unknown address → `{ authenticated: false, needsInvite: true }`. 400 bad challenge, 401 bad signature. |
| `POST /api/auth/bitcoin/register` | Body `{ address, challenge, signature, inviteCode, label? }`. Verified as above; invite redeemed; user created → `{ authenticated: true, token, role, label }`. 400 invalid invite or address already registered. |
| `POST /api/auth/passkey/register-options` | Body `{ label? }`. Returns `{ options }` for `startRegistration`; challenge stored server-side. Usable on a fresh instance (for `POST /api/init`). |
| `POST /api/auth/passkey/register` | Body `{ response, inviteCode, label? }`. Registration verified; invite redeemed; user created → `{ authenticated: true, token, role, label }`. |
| `POST /api/auth/passkey/login-options` | Returns `{ options }` for `startAuthentication`. |
| `POST /api/auth/passkey/login` | Body `{ response }`. Credential looked up by ID and verified → `{ authenticated: true, token, role, label }`. 401 unknown credential or failed verification. |

---

## 18. REST API — User and Invite Routes

**Module:** `backend/src/routes/users.ts` — all routes require admin.

| Route | Contract |
|---|---|
| `GET /api/users` | `{ users: Array<{ id, label, role, credential: { type: 'passkey' } \| { type: 'bitcoin', address } }> }` — passkey key material is never returned. |
| `POST /api/users` | Body `{ label, role, address }`. Adds a user with a Bitcoin credential. 400 invalid address; 409 address already registered. |
| `PATCH /api/users/:id` | Body `{ role }`. 409 when demoting the last admin. |
| `DELETE /api/users/:id` | 409 when removing the last admin. |
| `GET /api/invites` | `{ invites }` (expired and exhausted invites pruned). |
| `POST /api/invites` | Body `{ role?, maxUses, expiresAt }`. Returns `{ ok, invite }` with an 8-character code. |
| `DELETE /api/invites/:code` | Removes the invite. |
| `GET /api/invites/settings/visibility` | `{ everybodyCanRead }`. |
| `POST /api/invites/settings/visibility` | Body `{ everybodyCanRead: boolean }`. |

---

## 19. REST API — Hosting Routes

**Module:** `backend/src/routes/hosting.ts`

| Route | Contract |
|---|---|
| `GET /api/hosting` (read) | `{ hosting: HostingConfig \| null, hasCaddy }`. |
| `POST /api/hosting` (admin) | Body `{ domain, port?, path?, httpsEnabled }`. Domain and path sanitized. Caddyfile written to `CADDYFILE_PATH` and Caddy reloaded (or started). HTTPS with a domain uses the bare domain (automatic Let's Encrypt); a domain without HTTPS uses `http://domain:port`; no domain uses `:port`. Returns `{ ok, config }`, with `warning` when Caddy is unavailable or failed. |
| `DELETE /api/hosting` (admin) | Hosting removed; default `:80` Caddyfile written and Caddy reloaded. |

---

## 20. Frontend API Client

**Module:** `src/lib/api.ts`

- Thin `fetch()` wrapper for every `/api/*` route above.
- Every request sends `Content-Type: application/json` and, when a session token
  is stored, `Authorization: Bearer <token>`.
- Non-2xx responses throw `Error` with the server's `error` field or `HTTP <status>`.
- The session token and role live in `sessionStorage`.
- `RELAY_URL` is `VITE_RELAY_URL` when set, otherwise `ws(s)://<current host>/ws`.

---

## Cross-Cutting Contracts

### Security invariants

1. **No secrets on the server.** The server stores public key data, the address
   book, hosting settings, users (public credentials) and the scrypt hash of the
   admin password. Key shares exist only in party-held share files.
2. **Share encryption.** Share files are encrypted in the browser (§3). Share
   passwords never leave the browser.
3. **Relay E2E encryption.** Relay payloads are encrypted per peer with ECDH-derived
   AES keys. The relay forwards ciphertext only. Parties compare the session
   fingerprint.
4. **Signer approval.** Every signer computes sighashes from the transaction it
   reviewed and approved (§8). No party signs a hash it did not derive itself.
5. **Ceremony consistency.** The DKG ends with a signature by all N parties under
   the new key (§6); joiners verify the leader's aggregate signatures (§7).
6. **Pre-broadcast verification.** `/api/btc/broadcast` verifies every BIP340
   signature before broadcasting.
7. **Broadcast idempotency.** One broadcast per prepared transaction.
8. **Vault binding.** A share file is used only with the vault whose network and
   internal key it carries (§4).

### State machine (instance lifecycle)

```
fresh ──init()──> persistent | encrypted-persistent | encrypted-portable
                        │               │                    │
                   (auto-load)     unlock(pw)          restore(backup)
                        └──────────> ready <─────────────────┘
                                       │
                                  dkg/save
                                       │
                                     vault ──reset()──> fresh
```

### State machine (DKG ceremony)

```
join ──session config──> commit ──barrier──> shares ──barrier──> verify ──own signature valid──> complete
```

### State machine (send)

```
leader:  form ──prepare──> review ──approve + share──> session ──T parties──> FROST ──aggregate──> broadcast ──> result
joiner:  code + share ──> session ──proposal──> review ──approve──> FROST ──verified FROST-COMPLETE──> result
                                                     └──reject──> REJECT:<partyId>
```
