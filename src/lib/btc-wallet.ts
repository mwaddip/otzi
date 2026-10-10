/**
 * Browser Bitcoin wallets that can sign messages (Unisat-compatible API).
 * Any other wallet can be used by signing the message manually and pasting
 * the signature.
 */

interface UnisatLike {
  requestAccounts(): Promise<string[]>;
  signMessage(message: string, type?: 'ecdsa' | 'bip322-simple'): Promise<string>;
}

declare global {
  interface Window {
    unisat?: UnisatLike;
    okxwallet?: { bitcoin?: UnisatLike };
  }
}

export interface BrowserWallet {
  id: 'unisat' | 'okx';
  name: string;
  /** Ask the wallet for its current address. */
  connect(): Promise<string>;
  /** Sign `message` with the wallet's current account; returns a base64 signature. */
  sign(address: string, message: string): Promise<string>;
}

/** Native segwit and Taproot addresses use BIP-322; legacy and nested segwit use signmessage. */
function signatureType(address: string): 'ecdsa' | 'bip322-simple' {
  return /^(bc1|tb1|bcrt1)/i.test(address) ? 'bip322-simple' : 'ecdsa';
}

function wrap(id: BrowserWallet['id'], name: string, provider: UnisatLike): BrowserWallet {
  return {
    id,
    name,
    async connect() {
      const accounts = await provider.requestAccounts();
      if (!accounts?.[0]) throw new Error(`${name} returned no account`);
      return accounts[0];
    },
    sign: (address, message) => provider.signMessage(message, signatureType(address)),
  };
}

export function detectWallets(): BrowserWallet[] {
  const wallets: BrowserWallet[] = [];
  if (window.unisat) wallets.push(wrap('unisat', 'Unisat', window.unisat));
  if (window.okxwallet?.bitcoin) wallets.push(wrap('okx', 'OKX Wallet', window.okxwallet.bitcoin));
  return wallets;
}
