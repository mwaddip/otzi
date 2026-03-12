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
