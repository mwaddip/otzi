import { useState, useEffect, useCallback } from 'react';
import { getBitcoinChallenge } from '../lib/api';
import { detectWallets, type BrowserWallet } from '../lib/btc-wallet';

export interface BitcoinProof {
  address: string;
  challenge: string;
  signature: string;
}

interface Props {
  actionLabel: string;
  onSigned: (proof: BitcoinProof) => void | Promise<void>;
  busy?: boolean;
}

/**
 * Sign a server challenge with a Bitcoin wallet: a detected browser wallet,
 * or any wallet by copying the message and pasting the signature.
 */
export function BitcoinSignature({ actionLabel, onSigned, busy }: Props) {
  const [challenge, setChallenge] = useState<{ challenge: string; message: string } | null>(null);
  const [wallets] = useState<BrowserWallet[]>(() => detectWallets());
  const [manual, setManual] = useState(false);
  const [address, setAddress] = useState('');
  const [signature, setSignature] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const newChallenge = useCallback(() => {
    setError('');
    getBitcoinChallenge().then(setChallenge).catch(e => setError((e as Error).message));
  }, []);

  useEffect(() => { newChallenge(); }, [newChallenge]);

  const submit = async (proof: BitcoinProof) => {
    setError('');
    try {
      await onSigned(proof);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      newChallenge(); // challenges are one-use
      setSignature('');
    }
  };

  const signWithWallet = async (wallet: BrowserWallet) => {
    if (!challenge) return;
    setError('');
    try {
      const addr = await wallet.connect();
      const sig = await wallet.sign(addr, challenge.message);
      await submit({ address: addr, challenge: challenge.challenge, signature: sig });
    } catch (e) {
      setError((e as Error).message || `${wallet.name} refused to sign`);
    }
  };

  if (!challenge) {
    return error ? <div className="warning">{error}</div> : <div className="spinner" />;
  }

  return (
    <div>
      {wallets.map(w => (
        <button key={w.id} className="btn btn-primary btn-full" style={{ marginBottom: 8 }} disabled={busy} onClick={() => void signWithWallet(w)}>
          {actionLabel} with {w.name}
        </button>
      ))}

      {!manual && (
        <button className="btn btn-secondary btn-full" onClick={() => setManual(true)} disabled={busy}>
          {wallets.length ? 'Use another wallet' : `${actionLabel} with any Bitcoin wallet`}
        </button>
      )}

      {manual && (
        <div style={{ marginTop: 8 }}>
          <p style={{ fontSize: 13, color: 'var(--white-dim)' }}>
            Sign this message in your wallet (Sign Message), then paste the address and signature.
          </p>
          <pre
            style={{ fontSize: 12, padding: 10, background: 'var(--bg)', border: '1px solid var(--border-dim)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', cursor: 'pointer' }}
            title="Click to copy"
            onClick={() => void navigator.clipboard.writeText(challenge.message).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
          >
            {challenge.message}
          </pre>
          <div style={{ fontSize: 12, color: 'var(--green)', minHeight: 16 }}>{copied ? 'Message copied' : ''}</div>
          <input value={address} onChange={e => setAddress(e.target.value.trim())} placeholder="Bitcoin address" style={{ width: '100%', marginBottom: 8, fontFamily: 'monospace', fontSize: 13 }} />
          <textarea value={signature} onChange={e => setSignature(e.target.value.trim())} placeholder="Signature (base64)" rows={3} style={{ width: '100%', marginBottom: 8, fontFamily: 'monospace', fontSize: 12 }} />
          <button
            className="btn btn-primary btn-full"
            disabled={busy || !address || !signature}
            onClick={() => void submit({ address, challenge: challenge.challenge, signature })}
          >
            {busy ? <span className="spinner" /> : actionLabel}
          </button>
        </div>
      )}
      {error && <div className="warning" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}
