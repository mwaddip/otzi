import { type Psbt, toXOnly, equals, isTaprootInput } from '@btc-vision/bitcoin';

/**
 * PSBT signer that uses the SDK's wallet-based (multiSignPsbt) code path.
 *
 * When the SDK detects `multiSignPsbt` on the signer object, it skips the
 * non-wallet path (which demands a raw private key for Taproot tweaking)
 * and instead hands us the entire PSBT to sign however we want.
 *
 * OPNet transactions have two kinds of inputs:
 * - Input 0: script-path (tapLeafScript). Needs signing by both scriptSigner
 *   (already done before multiSignPsbt) AND the main signer with the raw
 *   (untweaked) key. Produces tapScriptSig.
 * - Inputs 1+: key-path (tapInternalKey). Needs signing with the tweaked key.
 *   Produces tapKeySig.
 *
 * Reference: UnisatSigner.multiSignPsbt in
 * @btc-vision/transaction/build/transaction/browser/extensions/UnisatSigner.js
 */

export interface SighashInfo {
  index: number;
  hash: Uint8Array;
  type: 'script-path' | 'key-path';
}

type SchnorrSignFn = (hash: Uint8Array) => Uint8Array | Promise<Uint8Array>;

/** Minimal signer shape for signTaprootInputAsync */
interface TaprootSigner {
  readonly publicKey: Uint8Array;
  signSchnorr(hash: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export class FrostPsbtSigner {
  /** SEC1-encoded tweaked public key (33 bytes). Matches the on-chain output key. */
  readonly publicKey: Uint8Array;

  private readonly internalXOnly: Uint8Array;
  private readonly keyPathSignFn: SchnorrSignFn;
  private readonly scriptPathSigner?: TaprootSigner;

  /**
   * @param keyPathSignFn - Signs with the tweaked key for key-path inputs (1+)
   * @param tweakedPublicKey - 33-byte SEC1 tweaked aggregate key
   * @param internalXOnly - 32-byte x-only untweaked key for matching tapInternalKey
   * @param scriptPathSigner - Optional signer for script-path inputs (input 0).
   *   Must have publicKey = untweaked key and signSchnorr that signs with the raw key.
   */
  constructor(
    keyPathSignFn: SchnorrSignFn,
    tweakedPublicKey: Uint8Array,
    internalXOnly: Uint8Array,
    scriptPathSigner?: TaprootSigner,
  ) {
    this.keyPathSignFn = keyPathSignFn;
    this.publicKey = tweakedPublicKey;
    this.internalXOnly = internalXOnly;
    this.scriptPathSigner = scriptPathSigner;
  }

  /**
   * Create a signer from a precomputed 64-byte BIP340 Schnorr signature.
   * Used in the two-call FROST flow: backend returns sighash → frontend
   * runs ceremony → frontend POSTs sig → backend wraps it here.
   */
  static fromSignature(
    sig: Uint8Array,
    tweakedPublicKey: Uint8Array,
    internalXOnly: Uint8Array,
    scriptPathSigner?: TaprootSigner,
  ): FrostPsbtSigner {
    return new FrostPsbtSigner(() => sig, tweakedPublicKey, internalXOnly, scriptPathSigner);
  }

  /**
   * Create a two-phase signer for the held-Promise pattern.
   *
   * Phase 1 (inside /api/tx/sighash): multiSignPsbt extracts all sighashes
   * using a dummy signer, resolves sighashesPromise, then awaits sigsPromise.
   *
   * Phase 2 (inside /api/tx/broadcast): caller resolves sigsPromise with
   * the FROST signatures. multiSignPsbt resumes and applies them.
   */
  static createTwoPhase(
    tweakedPublicKey: Uint8Array,
    internalXOnly: Uint8Array,
    untweakedPublicKey: Uint8Array,
  ): {
    signer: FrostPsbtSigner;
    sighashesPromise: Promise<SighashInfo[]>;
    resolveSignatures: (sigs: Map<number, Uint8Array>) => void;
    rejectSignatures: (err: Error) => void;
  } {
    let resolveSighashes!: (infos: SighashInfo[]) => void;
    let resolveSignatures!: (sigs: Map<number, Uint8Array>) => void;
    let rejectSignatures!: (err: Error) => void;

    const sighashesPromise = new Promise<SighashInfo[]>(r => { resolveSighashes = r; });
    const sigsPromise = new Promise<Map<number, Uint8Array>>((resolve, reject) => {
      resolveSignatures = resolve;
      rejectSignatures = reject;
    });

    const signer = new FrostPsbtSigner(
      () => { throw new Error('two-phase signer: use multiSignPsbt'); },
      tweakedPublicKey,
      internalXOnly,
    );

    // Override multiSignPsbt with two-phase logic
    signer.multiSignPsbt = async (transactions: Psbt[]): Promise<void> => {
      // Pass 1: extract sighashes with a dummy signer
      const sighashes: SighashInfo[] = [];

      for (const psbt of transactions) {
        for (let i = 0; i < psbt.data.inputs.length; i++) {
          const input = psbt.data.inputs[i];
          if (!isTaprootInput(input)) continue;

          const isScriptPath = !!(input as Record<string, unknown>).tapLeafScript &&
            ((input as Record<string, unknown>).tapLeafScript as unknown[]).length > 0;
          const isKeyPath = !isScriptPath &&
            (input as Record<string, unknown>).tapInternalKey &&
            equals((input as Record<string, unknown>).tapInternalKey as Uint8Array, internalXOnly);

          if (!isScriptPath && !isKeyPath) continue;

          let capturedHash: Uint8Array | undefined;
          const dummySigner = {
            publicKey: isScriptPath ? untweakedPublicKey : tweakedPublicKey,
            signSchnorr(hash: Uint8Array) {
              capturedHash = new Uint8Array(hash);
              return new Uint8Array(64);
            },
          };

          await psbt.signTaprootInputAsync(i, dummySigner as never);
          sighashes.push({
            index: i,
            hash: capturedHash!,
            type: isScriptPath ? 'script-path' : 'key-path',
          });

          // Delete dummy sig so pass 2 can sign cleanly
          const inp = input as Record<string, unknown>;
          if (isScriptPath) {
            delete inp.tapScriptSig;
          } else {
            delete inp.tapKeySig;
          }
        }
      }

      // Notify caller: sighashes ready
      resolveSighashes(sighashes);

      // Pause: wait for real FROST signatures
      const realSigs = await sigsPromise;

      // Pass 2: apply real signatures
      for (const psbt of transactions) {
        for (let i = 0; i < psbt.data.inputs.length; i++) {
          const input = psbt.data.inputs[i];
          if (!isTaprootInput(input)) continue;

          const sig = realSigs.get(i);
          if (!sig) continue;

          const isScriptPath = !!(input as Record<string, unknown>).tapLeafScript &&
            ((input as Record<string, unknown>).tapLeafScript as unknown[]).length > 0;

          const realSigner = {
            publicKey: isScriptPath ? untweakedPublicKey : tweakedPublicKey,
            signSchnorr() { return sig; },
          };

          await psbt.signTaprootInputAsync(i, realSigner as never);
        }
      }
    };

    return { signer, sighashesPromise, resolveSignatures, rejectSignatures };
  }

  // -- Signer interface stubs (never called when multiSignPsbt is present) --

  sign(): Uint8Array {
    throw new Error('FrostPsbtSigner: use multiSignPsbt');
  }

  signSchnorr(hash: Uint8Array): Uint8Array | Promise<Uint8Array> {
    return this.keyPathSignFn(hash);
  }

  // -- Wallet-based signing path --

  async multiSignPsbt(transactions: Psbt[]): Promise<void> {
    for (const psbt of transactions) {
      for (let i = 0; i < psbt.data.inputs.length; i++) {
        const input = psbt.data.inputs[i];
        if (!isTaprootInput(input)) continue;

        // Script-path inputs: sign with raw (untweaked) key
        if (input.tapLeafScript?.length && this.scriptPathSigner) {
          await psbt.signTaprootInputAsync(i, this.scriptPathSigner as never);
          continue;
        }

        // Key-path inputs: sign with tweaked key
        if (input.tapKeySig) continue;
        if (!input.tapInternalKey || !equals(input.tapInternalKey, this.internalXOnly)) continue;
        await psbt.signTaprootInputAsync(i, this as never);
      }
    }
  }
}
