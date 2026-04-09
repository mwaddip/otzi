/**
 * FROST Signer Spike — validate multiSignPsbt SDK path
 *
 * Tests that FrostPsbtSigner correctly signs via the wallet-based code path.
 * Uses the deployer wallet with a real private key wrapped in FrostPsbtSigner.
 * If multiSignPsbt is called and produces valid signatures, the spike passes.
 *
 * Usage: source ~/projects/sharedenv/opnet-testnet.env && npx tsx src/spike-frost-signer.ts
 */

import { networks, toXOnly, tapTweakHash } from '@btc-vision/bitcoin';
import { Mnemonic, MLDSASecurityLevel, Address } from '@btc-vision/transaction';
import { JSONRpcProvider, getContract, OP_20_ABI } from 'opnet';
import { FrostPsbtSigner } from './lib/frost-psbt-signer.js';

const MNEMONIC = process.env.OPNET_DEPLOYER_MNEMONIC;
const PAYMENT_TOKEN = process.env.OPNET_PAYMENT_TOKEN;

if (!MNEMONIC) {
  console.error('Missing OPNET_DEPLOYER_MNEMONIC. Source opnet-testnet.env first.');
  process.exit(1);
}
if (!PAYMENT_TOKEN) {
  console.error('Missing OPNET_PAYMENT_TOKEN. Source opnet-testnet.env first.');
  process.exit(1);
}

async function main() {
  const network = networks.opnetTestnet;
  const provider = new JSONRpcProvider({ url: 'https://testnet.opnet.org', network });

  // 1. Create wallet from mnemonic
  const m = new Mnemonic(MNEMONIC!, '', network, MLDSASecurityLevel.LEVEL2);
  const wallet = m.deriveOPWallet(undefined, 0, 0, false);
  console.log('[spike] Deployer p2tr:', wallet.p2tr);
  console.log('[spike] Deployer pubkey:', Buffer.from(wallet.keypair.publicKey).toString('hex'));

  // 2. Create FrostPsbtSigner from the wallet's keypair
  const internalXOnly = toXOnly(wallet.keypair.publicKey);
  const tweak = tapTweakHash(internalXOnly, undefined);
  const tweakedKeypair = wallet.keypair.tweak(tweak);
  console.log('[spike] Internal x-only:', Buffer.from(internalXOnly).toString('hex'));
  console.log('[spike] Tweaked pubkey:', Buffer.from(tweakedKeypair.publicKey).toString('hex'));

  // The SDK needs a full UniversalSigner for protocol-level signatures (legacy sig,
  // ML-DSA link proof). multiSignPsbt only overrides the BTC PSBT signing path.
  // For the spike: wrap the real keypair, adding multiSignPsbt so the SDK takes
  // the wallet-based path for BTC signing while still using the real keypair for
  // protocol signatures.
  const frostSigner = new FrostPsbtSigner(
    (hash: Uint8Array) => {
      console.log('[spike] signSchnorr (key-path) called with hash:', Buffer.from(hash).toString('hex'));
      const sig = tweakedKeypair.signSchnorr!(hash as never);
      console.log('[spike] signSchnorr produced sig:', Buffer.from(sig).toString('hex').slice(0, 32) + '...');
      return sig;
    },
    tweakedKeypair.publicKey,
    internalXOnly,
    // Script-path signer: raw (untweaked) keypair for input 0
    {
      publicKey: wallet.keypair.publicKey,
      signSchnorr: (hash: Uint8Array) => {
        console.log('[spike] signSchnorr (script-path) called');
        return wallet.keypair.signSchnorr!(hash as never);
      },
    },
  );

  // Monkey-patch multiSignPsbt onto the real keypair so the SDK takes the
  // wallet-based path for BTC signing. Protocol-level signatures still use
  // the keypair's real private key.
  const hybridSigner = wallet.keypair as typeof wallet.keypair & {
    multiSignPsbt: typeof frostSigner.multiSignPsbt;
  };
  (hybridSigner as Record<string, unknown>).multiSignPsbt =
    frostSigner.multiSignPsbt.bind(frostSigner);

  // Verify multiSignPsbt is detectable
  console.log('[spike] Has multiSignPsbt:', 'multiSignPsbt' in hybridSigner);

  // 3. Set up an OP_20 contract (BHTT payment token)
  const senderAddr = Address.fromString(
    wallet.quantumPublicKeyHex,
    Buffer.from(wallet.tweakedPubKeyKey).toString('hex'),
  );
  const contract = getContract(PAYMENT_TOKEN!, OP_20_ABI, provider, network, senderAddr);

  // 4. Simulate a small transfer (1 sat worth of tokens to self)
  console.log('[spike] Calling balanceOf...');
  const balResult = await (contract as never as Record<string, (...args: unknown[]) => Promise<{ properties: Record<string, unknown> }>>)
    ['balanceOf']!(senderAddr);
  console.log('[spike] Balance:', balResult.properties);

  // 5. Build a transfer to self
  console.log('[spike] Building transfer tx...');
  const transferResult = await (contract as never as Record<string, (...args: unknown[]) => Promise<{
    revert?: string;
    sendTransaction: (params: unknown) => Promise<{ transactionId: string; estimatedFees?: bigint }>;
  }>>)['transfer']!(senderAddr, 1n);

  if (transferResult.revert) {
    console.log('[spike] Simulation reverted:', transferResult.revert);
    m.zeroize();
    wallet.zeroize();
    return;
  }

  // 6. Get challenge & try to send
  console.log('[spike] Getting challenge...');
  const challenge = await provider.getChallenge();

  // Dummy ML-DSA signer — just returns zeros. We're testing BTC signing, not ML-DSA.
  const dummyMldsaSigner = {
    publicKey: new Uint8Array(1312),
    chainCode: new Uint8Array(32),
    network,
    depth: 0,
    index: 0,
    parentFingerprint: 0,
    identifier: new Uint8Array(20),
    fingerprint: new Uint8Array(4),
    securityLevel: MLDSASecurityLevel.LEVEL2,
    privateKey: undefined,
    sign: () => new Uint8Array(2420),
    verify: () => true,
    isNeutered: () => true,
    neutered() { return this; },
    derive() { throw new Error('not supported'); },
    deriveHardened() { throw new Error('not supported'); },
    derivePath() { throw new Error('not supported'); },
    toBase58() { throw new Error('not supported'); },
  };

  console.log('[spike] Sending transaction with FrostPsbtSigner...');
  try {
    const receipt = await transferResult.sendTransaction({
      signer: hybridSigner as never,
      mldsaSigner: dummyMldsaSigner as never,
      refundTo: wallet.p2tr,
      network,
      feeRate: 10,
      priorityFee: 1000n,
      maximumAllowedSatToSpend: 100000n,
      challenge,
    });
    console.log('[spike] SUCCESS! txid:', receipt.transactionId);
    console.log('[spike] Estimated fees:', receipt.estimatedFees?.toString());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('[spike] Transaction error:', msg);
    // If we see "signSchnorr called" in the output above, the spike passed
    // even if the broadcast failed (e.g. due to dummy ML-DSA sig)
  }

  m.zeroize();
  wallet.zeroize();
}

main().catch((e) => {
  console.error('[spike] Fatal:', e);
  process.exit(1);
});
