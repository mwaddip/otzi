# Ötzi — Signing Flow Reference

Visual reference for the two ceremonies: key generation (DKG) and sending bitcoin. Message formats and contracts are in [`facts/INTERFACES.md`](../facts/INTERFACES.md).

---

## DKG Ceremony (Key Generation)

Creates the vault's FROST key (secp256k1, BIP340/BIP341). All N parties take part, in one uninterrupted relay session.

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │                         DKG CEREMONY                                │
 │                                                                     │
 │  Party 0 (creator)         Relay           Party i (joiner)         │
 │  ─────────────────         ─────           ──────────────────       │
 │                                                                     │
 │  ① JOIN                                                             │
 │  Create session (T, N) ───────────────────► Join with code          │
 │  All parties connected: compare session fingerprint                 │
 │  Broadcast session config ────────────────► Accept (t, n, network)  │
 │                                                                     │
 │  ② COMMIT — FROST DKG round 1                                       │
 │  Secret polynomial,    ◄════════════════► Secret polynomial,        │
 │  commitments + proof                       commitments + proof      │
 │  of knowledge, broadcast                   of knowledge, broadcast  │
 │  BARRIER:commit        ◄════════════════► BARRIER:commit            │
 │                                                                     │
 │  ③ SHARES — FROST DKG round 2                                       │
 │  Verify all proofs     ◄════════════════► Verify all proofs         │
 │  Send one private share ── per party ───► Receive private shares    │
 │  BARRIER:shares        ◄════════════════► BARRIER:shares            │
 │                                                                     │
 │  ④ VERIFY                                                           │
 │  dkgFinalize: verify   ◄════════════════► dkgFinalize: verify       │
 │  shares, derive key                        shares, derive key       │
 │  Compute M from own view of the transcript                          │
 │  FROST-sign M with all N parties (2 rounds)                         │
 │  Aggregate + verify    ◄════════════════► Aggregate + verify        │
 │  under own key                             under own key            │
 │  · Any inconsistency → error naming the offending party             │
 │                                                                     │
 │  ⑤ COMPLETE                                                         │
 │  Show vault address    ◄════════════════► Show vault address        │
 │  Download share file (v4)                  Download share file (v4) │
 │  Admin: save vault public key package to the server                 │
 └─────────────────────────────────────────────────────────────────────┘
```

### What each party holds after DKG

| Data | Where | Purpose |
|------|-------|---------|
| Encrypted share file (`.json`) | Downloaded by each party | FROST key package (secret signing share) + public key package |
| Vault public key package | Share files + server config | Address derivation, signature verification, cheater detection |
| Vault address | Derived | Receiving funds |

---

## Sending Bitcoin

T parties sign. The initiator (leader) drives the session; co-signers (joiners) approve what they sign.

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │                           SEND                                       │
 │                                                                      │
 │  Leader                  Backend          Relay        Joiner        │
 │  ──────                  ───────          ─────        ──────        │
 │                                                                      │
 │  ① PREPARE                                                           │
 │  Recipient, amount, fee ──►                                          │
 │                          Fetch confirmed UTXOs (Esplora)             │
 │                          Select coins, add change                    │
 │                          Build unsigned tx (v2, RBF)                 │
 │  ◄── challengeToken + proposal (tx + prevouts)                       │
 │                                                                      │
 │  ② REVIEW (leader)                                                   │
 │  analyzeProposal: outputs, change, fee, sighashes                    │
 │  Load share file → re-check against own key                          │
 │  Approve → create relay session for T parties                        │
 │                                                                      │
 │  ③ JOIN + REVIEW (joiners)                                           │
 │                                            Join with code, load share│
 │  PROPOSAL: tx + prevouts ════════════════════════════► analyze       │
 │                                            Review recipients, fee    │
 │                                            Approve / Reject          │
 │                                                                      │
 │  ④ FROST ROUND 1 — commitments                                       │
 │  One commitment per    ◄═════════════════════════════► One per input │
 │  input, broadcast                                                    │
 │                                                                      │
 │  ⑤ FROST ROUND 2 — signature shares                                  │
 │  signRound2 over own   ◄═════════════════════════════► signRound2    │
 │  sighashes                                             over own      │
 │                                                        sighashes     │
 │                                                                      │
 │  ⑥ AGGREGATE (leader)                                                │
 │  signAggregate with full public key package                          │
 │  FROST-COMPLETE ═════════════════════════════════════► verify sigs   │
 │                                                                      │
 │  ⑦ BROADCAST                                                         │
 │  signatures + token ──►                                              │
 │                          Verify BIP340 per input                     │
 │                          Insert key-path witnesses                   │
 │                          POST /tx (Esplora)                          │
 │  ◄── txid                                              txid derived  │
 │                                                        from tx       │
 └──────────────────────────────────────────────────────────────────────┘
```

### What a joiner checks before approving

| Check | Why |
|-------|-----|
| Every input spends a coin locked to the vault output script | Only the vault's own coins are signed for |
| Input `i` spends `prevouts[i]` | Amounts and scripts shown belong to the inputs signed |
| Sequence `0xfffffffd`, lock time 0 | No hidden time locks |
| Every output decodes to a standard address | Recipients are readable |
| `fee = inputs − outputs ≥ 0` | Fee shown is the real fee |
| Network matches | No cross-network confusion |

Sighashes commit to every input's amount and script (BIP341), so a proposal with false prevout data produces signatures that the network rejects.

### Signature summary

| Item | Value |
|------|-------|
| Scheme | BIP340 Schnorr via FROST (RFC 9591, secp256k1-SHA256-TR) |
| Key | Tweaked vault key (BIP341 output key, empty script tree) |
| Sighash | `SIGHASH_DEFAULT`, BIP341 key-path |
| Witness | `[64-byte signature]` per input |
| Signatures per send | One per input, produced in one two-round ceremony |

---

## State Sync

Both ceremonies run over the same relay mechanics:

- `FROST-STATE:<partyId>:<round>:<sentRounds>` is broadcast every 500 ms and on change.
- When a party sees a peer in an earlier round, it re-sends its blob for that round.
- In signing, the leader advances rounds; joiners follow the leader's state.
- The DKG uses barriers (`BARRIER:<step>:<partyId>`): nobody advances until every party has sent its blob and received all blobs for the step.
