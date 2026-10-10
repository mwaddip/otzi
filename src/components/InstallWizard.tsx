import { useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { initInstance, setSession, restoreBackup, passkeyRegisterOptions, type CredentialProof } from '../lib/api';
import { NETWORK_LABELS, type AuthMode, type NetworkName, type StorageMode } from '../lib/vault-types';
import { BitcoinSignature } from './BitcoinSignature';
import { OtziWordmark } from '../App';

interface Props {
  onComplete: () => void;
}

const NETWORK_HINTS: Record<NetworkName, string> = {
  mainnet: 'Real bitcoin.',
  testnet4: 'Public test network. Coins have no value.',
  signet: 'Stable test network. Coins have no value.',
};

function Choice<T extends string>({ value, current, title, desc, onSelect }: { value: T; current: T; title: string; desc: string; onSelect: (v: T) => void }) {
  const active = value === current;
  return (
    <label style={{
      display: 'flex', alignItems: 'flex-start', gap: 12, padding: 12, cursor: 'pointer',
      background: active ? 'var(--accent-dim)' : 'var(--bg-raised)',
      borderRadius: 'var(--radius)',
      border: active ? '1px solid var(--accent)' : '1px solid var(--border-dim)',
    }}>
      <input type="radio" checked={active} onChange={() => onSelect(value)} style={{ marginTop: 4 }} />
      <div>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div>
        <div style={{ fontSize: 13, color: 'var(--white-dim)' }}>{desc}</div>
      </div>
    </label>
  );
}

export function InstallWizard({ onComplete }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [network, setNetwork] = useState<NetworkName>('testnet4');
  const [authMode, setAuthMode] = useState<AuthMode>('password');
  const [storageMode, setStorageMode] = useState<StorageMode>('persistent');
  const [storagePassword, setStoragePassword] = useState('');
  const [storagePasswordConfirm, setStoragePasswordConfirm] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminPasswordConfirm, setAdminPasswordConfirm] = useState('');
  const [adminLabel, setAdminLabel] = useState('Admin');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [restoreMode, setRestoreMode] = useState(false);
  const [restorePassword, setRestorePassword] = useState('');

  const initPassword = async () => {
    if (storageMode === 'encrypted-persistent') {
      if (!storagePassword) { setError('Encryption password required'); return; }
      if (storagePassword !== storagePasswordConfirm) { setError('Encryption passwords do not match'); return; }
    }
    if (!adminPassword) { setError('Admin password required'); return; }
    if (adminPassword !== adminPasswordConfirm) { setError('Admin passwords do not match'); return; }
    setLoading(true);
    setError('');
    try {
      const res = await initInstance({
        network,
        storageMode,
        authMode: 'password',
        adminPassword,
        ...(storageMode === 'encrypted-persistent' ? { password: storagePassword } : {}),
      });
      setSession(res.token, res.role);
      onComplete();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const initAccounts = async (credential: CredentialProof) => {
    setLoading(true);
    setError('');
    try {
      const res = await initInstance({
        network,
        storageMode: 'persistent',
        authMode: 'accounts',
        admin: { label: adminLabel.trim() || 'Admin', credential },
      });
      setSession(res.token, res.role);
      onComplete();
    } finally {
      setLoading(false);
    }
  };

  const registerPasskey = async () => {
    setError('');
    try {
      const { options } = await passkeyRegisterOptions(adminLabel.trim() || 'Admin');
      const response = await startRegistration({ optionsJSON: options });
      await initAccounts({ type: 'passkey', response });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const restore = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.enc,.txt,.json';
    input.onchange = async e => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      setLoading(true);
      setError('');
      try {
        await restoreBackup((await file.text()).trim(), restorePassword);
        onComplete();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    };
    input.click();
  };

  return (
    <div className="ceremony">
      <div style={{ textAlign: 'center', marginBottom: 8 }}>
        <OtziWordmark height={48} />
      </div>
      <p className="subtitle" style={{ textAlign: 'center' }}>First-time setup</p>

      <div className="steps">
        <div className={`step-dot ${step >= 1 ? 'active' : ''}`} />
        <div className={`step-dot ${step >= 2 ? 'active' : ''}`} />
        {authMode === 'password' && <div className={`step-dot ${step >= 3 ? 'active' : ''}`} />}
      </div>

      {step === 1 && (
        <div className="card">
          <h2>Network</h2>
          <p>Which Bitcoin network will this vault use?</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
            {(['mainnet', 'testnet4', 'signet'] as const).map(n => (
              <Choice key={n} value={n} current={network} title={NETWORK_LABELS[n]} desc={NETWORK_HINTS[n]} onSelect={setNetwork} />
            ))}
          </div>
          <button className="btn btn-primary btn-full" onClick={() => setStep(2)}>Next</button>

          <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--gray-light)', margin: '16px 0 8px' }}>or</div>

          {!restoreMode ? (
            <button className="btn btn-secondary btn-full" onClick={() => setRestoreMode(true)}>Restore from Backup</button>
          ) : (
            <div style={{ padding: 12, background: 'var(--bg-raised)', border: '1px solid var(--border-dim)' }}>
              <div className="form-row">
                <label>
                  Backup password
                  <input type="password" autoFocus value={restorePassword} onChange={e => setRestorePassword(e.target.value)} placeholder="Password used when creating the backup" />
                </label>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary" style={{ flex: 1 }} disabled={loading || !restorePassword} onClick={restore}>
                  {loading ? <span className="spinner" /> : 'Select backup file'}
                </button>
                <button className="btn btn-secondary" onClick={() => { setRestoreMode(false); setError(''); }}>Cancel</button>
              </div>
            </div>
          )}
          {error && <div className="warning" style={{ marginTop: 12 }}>{error}</div>}
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <h2>Sign-in</h2>
          <p>Who manages this instance?</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
            <Choice value="password" current={authMode} onSelect={setAuthMode} title="Admin password"
              desc="One password protects settings and starting sends. Co-signers only need a session link and their share file." />
            <Choice value="accounts" current={authMode} onSelect={setAuthMode} title="Accounts"
              desc="Named users with roles. Each signs in with a passkey or a Bitcoin wallet. New users join with invite codes." />
          </div>

          {authMode === 'accounts' && (
            <>
              <div className="form-row">
                <label>
                  Your name
                  <input value={adminLabel} maxLength={64} onChange={e => setAdminLabel(e.target.value)} />
                </label>
              </div>
              <p style={{ fontSize: 13, color: 'var(--white-dim)' }}>Register how you, the first admin, will sign in:</p>
              <button className="btn btn-primary btn-full" style={{ marginBottom: 8 }} disabled={loading} onClick={() => void registerPasskey()}>
                {loading ? <span className="spinner" /> : 'Create a passkey'}
              </button>
              <BitcoinSignature
                actionLabel="Register"
                busy={loading}
                onSigned={proof => initAccounts({ type: 'bitcoin', ...proof })}
              />
            </>
          )}

          {error && <div className="warning" style={{ marginTop: 12 }}>{error}</div>}

          <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
            <button className="btn btn-secondary" onClick={() => { setStep(1); setError(''); }}>Back</button>
            {authMode === 'password' && (
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => { setError(''); setStep(3); }}>Next</button>
            )}
          </div>
        </div>
      )}

      {step === 3 && authMode === 'password' && (
        <div className="card">
          <h2>Storage</h2>
          <p>How should the server keep its configuration? It holds the vault's public key, address book and settings — never key shares.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
            <Choice value="persistent" current={storageMode} onSelect={setStorageMode} title="Persistent" desc="Plaintext on the server. Simple; for trusted hosts." />
            <Choice value="encrypted-persistent" current={storageMode} onSelect={setStorageMode} title="Encrypted persistent" desc="Encrypted on the server. Password required after each restart." />
            <Choice value="encrypted-portable" current={storageMode} onSelect={setStorageMode} title="Encrypted portable" desc="Kept in memory only. Download an encrypted backup and restore it after each restart." />
          </div>

          {storageMode === 'encrypted-portable' && (
            <div className="warning" style={{ marginBottom: 16 }}>
              Nothing is written to disk. After every server restart, restore your backup file.{' '}
              <a href="https://github.com/mwaddip/otzi/blob/master/docs/portable-mode.md" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
                Read the portable mode guide
              </a>.
            </div>
          )}

          {storageMode === 'encrypted-persistent' && (
            <div style={{ marginBottom: 16 }}>
              <div className="form-row">
                <label>Encryption password<input type="password" value={storagePassword} onChange={e => setStoragePassword(e.target.value)} /></label>
              </div>
              <div className="form-row">
                <label>Confirm encryption password<input type="password" value={storagePasswordConfirm} onChange={e => setStoragePasswordConfirm(e.target.value)} /></label>
              </div>
            </div>
          )}

          <p style={{ fontSize: 13, color: 'var(--white-dim)', marginBottom: 8 }}>The admin password protects settings and starting sends.</p>
          <div className="form-row">
            <label>Admin password<input type="password" value={adminPassword} onChange={e => setAdminPassword(e.target.value)} /></label>
          </div>
          <div className="form-row">
            <label>Confirm admin password<input type="password" value={adminPasswordConfirm} onChange={e => setAdminPasswordConfirm(e.target.value)} /></label>
          </div>

          {error && <div className="warning">{error}</div>}

          <div style={{ display: 'flex', gap: 12 }}>
            <button className="btn btn-secondary" onClick={() => setStep(2)}>Back</button>
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => void initPassword()} disabled={loading}>
              {loading ? <span className="spinner" /> : 'Initialize'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
