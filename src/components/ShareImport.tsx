import { useState, useRef, useCallback } from 'react';
import { decryptShareFile, assertShareMatchesVault, type DecryptedShare } from '../lib/share-file';
import type { NetworkName, VaultKey } from '../lib/vault-types';

interface Props {
  network: NetworkName;
  /** Instance vault, when readable — the share must belong to it. */
  vault?: VaultKey;
  title?: string;
  onShareLoaded: (share: DecryptedShare) => void;
}

export function ShareImport({ network, vault, title = 'Load your share file', onShareLoaded }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState('');
  const fileRef = useRef<unknown>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setError('');
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    file.text().then(text => {
      try {
        fileRef.current = JSON.parse(text);
        setTimeout(() => passwordRef.current?.focus(), 50);
      } catch {
        fileRef.current = null;
        setError('Not a share file (invalid JSON)');
      }
    }).catch(() => setError('Could not read the file'));
  }, []);

  const handleDecrypt = useCallback(async () => {
    if (!fileRef.current) { setError('Choose a share file first'); return; }
    if (!password) { setError('Enter the share password'); return; }
    setLoading(true);
    setError('');
    try {
      const share = await decryptShareFile(fileRef.current, password);
      assertShareMatchesVault(share, network, vault);
      setPassword('');
      onShareLoaded(share);
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg.includes('operation') || (e as Error).name === 'OperationError' ? 'Wrong password' : msg);
    } finally {
      setLoading(false);
    }
  }, [password, network, vault, onShareLoaded]);

  return (
    <div className="card">
      <h2>{title}</h2>
      <p style={{ fontSize: 13, color: 'var(--white-dim)' }}>
        Your share file and password stay in this browser.
      </p>
      <label className="btn btn-secondary btn-full" style={{ marginBottom: 12, cursor: 'pointer', textAlign: 'center' }}>
        {fileName || 'Choose share file…'}
        <input type="file" accept=".json,application/json" onChange={handleFile} style={{ display: 'none' }} />
      </label>
      <input
        ref={passwordRef}
        type="password"
        placeholder="Share password"
        value={password}
        onChange={e => setPassword(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') void handleDecrypt(); }}
        style={{ width: '100%', marginBottom: 12 }}
      />
      {error && <div className="warning">{error}</div>}
      <button className="btn btn-primary btn-full" onClick={() => void handleDecrypt()} disabled={loading || !fileName}>
        {loading ? <span className="spinner" /> : 'Unlock share'}
      </button>
    </div>
  );
}
