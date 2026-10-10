import { useState, useEffect } from 'react';
import {
  getConfig, resetInstance, updateHosting, removeHosting, adminUnlock, setSession, clearSession,
  isAdminSession, downloadBackup, restoreBackup, getVisibility, setVisibility, setChainApi,
} from '../lib/api';
import { explorerAddressUrl, vaultParties } from '../lib/bitcoin';
import { NETWORK_LABELS, type AuthMode, type NetworkName, type VaultConfig } from '../lib/vault-types';
import { AddressBook } from './AddressBook';
import { UserManager } from './UserManager';

interface Props {
  network: NetworkName;
  authMode: AuthMode;
  onBack: () => void;
  /** Sign-in or instance state changed (sign-out, reset); the app re-checks status. */
  onStatusChange: () => void;
}

const STORAGE_LABELS: Record<VaultConfig['storageMode'], string> = {
  'persistent': 'Persistent',
  'encrypted-persistent': 'Encrypted persistent',
  'encrypted-portable': 'Encrypted portable',
};

export function Settings({ network, authMode, onBack, onStatusChange }: Props) {
  const [config, setConfig] = useState<VaultConfig | null>(null);
  const [loadError, setLoadError] = useState('');
  const [isAdmin, setIsAdmin] = useState(isAdminSession());
  const [unlockPassword, setUnlockPassword] = useState('');
  const [unlockError, setUnlockError] = useState('');
  const [resetStep, setResetStep] = useState(0);
  const [resetInput, setResetInput] = useState('');
  const [resetError, setResetError] = useState('');
  const isAccounts = authMode === 'accounts';

  useEffect(() => {
    getConfig().then(setConfig).catch(e => setLoadError((e as Error).message));
  }, []);

  const handleUnlock = async () => {
    setUnlockError('');
    try {
      const { token } = await adminUnlock(unlockPassword);
      setSession(token, 'password-admin');
      setUnlockPassword('');
      setIsAdmin(true);
    } catch (e) {
      setUnlockError((e as Error).message);
    }
  };

  const handleLock = () => {
    clearSession();
    setIsAdmin(false);
    if (isAccounts) onStatusChange();
  };

  const handleReset = async () => {
    if (resetStep < 2) { setResetStep(resetStep + 1); return; }
    if (resetInput !== 'RESET') { setResetError('Type RESET to confirm'); return; }
    try {
      await resetInstance();
      clearSession();
      onStatusChange();
    } catch (e) {
      setResetError((e as Error).message);
    }
  };

  const locked = !isAdmin;

  return (
    <div className="ceremony" style={{ maxWidth: 1100 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1>Settings</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {isAdmin && <button className="btn btn-secondary" onClick={handleLock} style={{ fontSize: 13 }}>{isAccounts ? 'Sign out' : 'Lock'}</button>}
          <button className="btn btn-secondary" onClick={onBack}>Back</button>
        </div>
      </div>

      {locked && !isAccounts && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'var(--accent)' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="password" value={unlockPassword} placeholder="Admin password" style={{ flex: 1 }}
              onChange={e => { setUnlockPassword(e.target.value); setUnlockError(''); }}
              onKeyDown={e => { if (e.key === 'Enter') void handleUnlock(); }} />
            <button className="btn btn-primary" onClick={() => void handleUnlock()} disabled={!unlockPassword}>Unlock</button>
          </div>
          {unlockError && <div className="warning" style={{ marginTop: 8 }}>{unlockError}</div>}
        </div>
      )}
      {locked && isAccounts && (
        <div className="card" style={{ marginBottom: 16 }}>
          <p style={{ fontSize: 13 }}>Changing settings requires an admin account.</p>
        </div>
      )}

      {loadError && <div className="warning">{loadError}</div>}

      {config && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <InstanceCard config={config} onConfigUpdate={setConfig} disabled={locked} />
            <AddressBook network={network} disabled={locked} />
            {isAccounts && isAdmin && <UserManager />}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <HostingManager config={config} onConfigUpdate={setConfig} disabled={locked} isAccounts={isAccounts} />
            <BackupRestore disabled={locked} />

            <div className="card" style={locked ? { opacity: 0.5, pointerEvents: 'none' } : {}}>
              <h2>Reset Instance</h2>
              {resetStep === 0 && (
                <button className="btn btn-secondary btn-full" style={{ color: 'var(--red)' }} onClick={() => void handleReset()}>Reset Instance</button>
              )}
              {resetStep === 1 && (
                <>
                  <div className="warning">
                    This deletes the configuration, address book and users. Share files are not affected and still control the vault.
                  </div>
                  <div style={{ display: 'flex', gap: 12 }}>
                    <button className="btn btn-secondary" onClick={() => setResetStep(0)}>Cancel</button>
                    <button className="btn btn-secondary" style={{ color: 'var(--red)', flex: 1 }} onClick={() => void handleReset()}>I understand, continue</button>
                  </div>
                </>
              )}
              {resetStep === 2 && (
                <>
                  <input value={resetInput} onChange={e => setResetInput(e.target.value)} placeholder="Type RESET" style={{ width: '100%', marginBottom: 12 }} />
                  {resetError && <div className="warning">{resetError}</div>}
                  <div style={{ display: 'flex', gap: 12 }}>
                    <button className="btn btn-secondary" onClick={() => { setResetStep(0); setResetInput(''); }}>Cancel</button>
                    <button className="btn btn-secondary" style={{ color: 'var(--red)', flex: 1 }} onClick={() => void handleReset()}>Confirm Reset</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Instance ──

function InstanceCard({ config, onConfigUpdate, disabled }: { config: VaultConfig; onConfigUpdate: (c: VaultConfig) => void; disabled?: boolean }) {
  const [esploraUrl, setEsploraUrl] = useState(config.esploraUrl ?? '');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const save = async (value: string | null) => {
    setError('');
    setMessage('');
    try {
      const res = await setChainApi(value);
      onConfigUpdate({ ...config, esploraUrl: value ?? undefined, chainApiUrl: res.chainApiUrl });
      if (value === null) setEsploraUrl('');
      setMessage(`Using ${res.chainApiUrl}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="card">
      <h2>Instance</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', fontSize: 13, marginBottom: 16 }}>
        <span style={{ color: 'var(--white-dim)' }}>Network</span><span>{NETWORK_LABELS[config.network]}</span>
        <span style={{ color: 'var(--white-dim)' }}>Storage</span><span>{STORAGE_LABELS[config.storageMode]}</span>
        <span style={{ color: 'var(--white-dim)' }}>Sign-in</span><span>{config.authMode === 'accounts' ? 'Accounts' : 'Admin password'}</span>
        {config.vault && (<>
          <span style={{ color: 'var(--white-dim)' }}>Threshold</span>
          <span>{config.vault.minSigners} of {vaultParties(config.vault)}</span>
        </>)}
      </div>

      {config.vaultAddress && (
        <>
          <div style={{ fontSize: 12, color: 'var(--white-dim)' }}>Vault address</div>
          <div className="pubkey-display" style={{ fontSize: 12 }}>{config.vaultAddress}</div>
          <a href={explorerAddressUrl(config.chainApiUrl, config.vaultAddress)} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: 'var(--accent)' }}>View on explorer ↗</a>
        </>
      )}

      <div style={{ marginTop: 16, ...(disabled ? { opacity: 0.5, pointerEvents: 'none' as const } : {}) }}>
        <div className="form-row">
          <label>
            Chain API (Esplora URL)
            <input value={esploraUrl} onChange={e => setEsploraUrl(e.target.value)} placeholder={config.chainApiUrl} style={{ fontFamily: 'monospace', fontSize: 12 }} />
          </label>
        </div>
        <p style={{ fontSize: 12, color: 'var(--white-dim)' }}>
          Leave empty for mempool.space. A self-hosted mempool or electrs server keeps your vault address private.
        </p>
        {error && <div className="warning">{error}</div>}
        {message && <div style={{ fontSize: 13, color: 'var(--accent)', marginBottom: 8 }}>{message}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" style={{ flex: 1 }} disabled={!esploraUrl.trim() || esploraUrl.trim() === config.esploraUrl} onClick={() => void save(esploraUrl.trim())}>Save</button>
          {config.esploraUrl && <button className="btn btn-secondary" onClick={() => void save(null)}>Use default</button>}
        </div>
      </div>
    </div>
  );
}

// ── Hosting Manager ──

function HostingManager({ config, onConfigUpdate, disabled, isAccounts }: { config: VaultConfig; onConfigUpdate: (c: VaultConfig) => void; disabled?: boolean; isAccounts?: boolean }) {
  const hosting = config.hosting;
  const [domain, setDomain] = useState(hosting?.domain || '');
  const [port, setPort] = useState(hosting?.port?.toString() || '443');
  const [path, setPath] = useState(hosting?.path || '');
  const [httpsEnabled, setHttpsEnabled] = useState(hosting?.httpsEnabled ?? true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [everybodyCanRead, setEverybodyCanRead] = useState(true);

  useEffect(() => {
    if (isAccounts) {
      getVisibility().then(r => setEverybodyCanRead(r.everybodyCanRead)).catch(() => {});
    }
  }, [isAccounts]);

  const hasChanges = domain !== (hosting?.domain || '')
    || port !== (hosting?.port?.toString() || '')
    || path !== (hosting?.path || '')
    || httpsEnabled !== (hosting?.httpsEnabled || false);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const portNum = port ? parseInt(port, 10) : undefined;
      const result = await updateHosting(domain, httpsEnabled, portNum, path);
      onConfigUpdate(result.config);
      if (result.warning) {
        setMessage(result.warning);
      } else {
        setMessage(httpsEnabled ? 'Domain configured with HTTPS. Certificate provisioning started.' : 'Hosting configured.');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await removeHosting();
      setDomain(''); setPort(''); setPath(''); setHttpsEnabled(false);
      onConfigUpdate({ ...config, hosting: undefined });
      setMessage('Hosting configuration removed.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={disabled ? { opacity: 0.5, pointerEvents: 'none' } : {}}>
      <h2>Hosting</h2>
      <p style={{ fontSize: 13, color: 'var(--white-dim)', marginBottom: 16 }}>
        Configure the external URL for this instance.
      </p>

      <div className="form-row">
        <label>
          Domain
          <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="e.g. vault.example.com" />
        </label>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div className="form-row" style={{ width: 90 }}>
          <label>
            Port
            <input value={port} onChange={e => {
              const val = e.target.value.replace(/\D/g, '');
              setPort(val);
              if (val === '80') setHttpsEnabled(false);
              else if (val === '443') setHttpsEnabled(true);
              else if (!httpsEnabled) setHttpsEnabled(true);
            }} placeholder="443" />
          </label>
        </div>
        <div className="form-row" style={{ flex: 1 }}>
          <label>
            Path
            <input value={path} onChange={e => setPath(e.target.value)} placeholder="/vault" />
          </label>
        </div>
        <div style={{ marginBottom: 12 }}>
          <button
            className={`btn ${httpsEnabled ? 'btn-primary' : 'btn-secondary'}`}
            style={{ fontSize: 12, padding: '8px 12px', whiteSpace: 'nowrap' }}
            onClick={() => setHttpsEnabled(!httpsEnabled)}
            title={httpsEnabled ? 'HTTPS enabled' : 'HTTP only'}
          >
            {httpsEnabled ? 'SSL' : 'SSL'}
          </button>
        </div>
      </div>

      {domain.trim() && (
        <div style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--accent)', marginBottom: 16 }}>
          {httpsEnabled ? 'https' : 'http'}://{domain}{port && port !== '443' && port !== '80' ? `:${port}` : ''}{path || ''}
        </div>
      )}

      {error && <div className="warning" style={{ marginBottom: 12 }}>{error}</div>}
      {message && <div style={{ fontSize: 13, color: 'var(--accent)', marginBottom: 12 }}>{message}</div>}

      <div style={{ display: 'flex', gap: 12 }}>
        <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleSave} disabled={saving || !hasChanges}>
          {saving ? <span className="spinner" /> : 'Save'}
        </button>
        {hosting && (
          <button className="btn btn-secondary" onClick={handleRemove} disabled={saving}>Remove</button>
        )}
      </div>

      {isAccounts && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--gray-dark)' }}>
          <input
            type="checkbox"
            checked={everybodyCanRead}
            onChange={() => {
              const newVal = !everybodyCanRead;
              setEverybodyCanRead(newVal);
              setVisibility(newVal).catch(e => { setEverybodyCanRead(!newVal); setError((e as Error).message); });
            }}
          />
          Let visitors who are not signed in view the vault page (read-only)
        </label>
      )}
    </div>
  );
}

// ── Backup & Restore ──

function BackupRestore({ disabled }: { disabled?: boolean }) {
  const [backupPassword, setBackupPassword] = useState('');
  const [restorePassword, setRestorePassword] = useState('');
  const [mode, setMode] = useState<'idle' | 'backup' | 'restore'>('idle');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleBackup = async () => {
    if (!backupPassword) { setError('Password required'); return; }
    setLoading(true); setError('');
    try {
      const result = await downloadBackup(backupPassword);
      const blob = new Blob([result.encrypted], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `otzi-backup-${new Date().toISOString().slice(0, 10)}.enc`;
      a.click();
      URL.revokeObjectURL(url);
      setMessage('Backup downloaded.');
      setMode('idle'); setBackupPassword('');
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };

  const handleRestore = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.enc,.txt,.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      if (!restorePassword) { setError('Password required'); return; }
      setLoading(true); setError('');
      try {
        const encrypted = (await file.text()).trim();
        await restoreBackup(encrypted, restorePassword);
        window.location.reload();
      } catch (err) { setError((err as Error).message); }
      finally { setLoading(false); }
    };
    input.click();
  };

  return (
    <div className="card" style={disabled ? { opacity: 0.5, pointerEvents: 'none' } : {}}>
      <h2>Backup</h2>
      <p style={{ fontSize: 13, color: 'var(--white-dim)', marginBottom: 12 }}>
        Encrypted backup of the configuration (vault public key, address book, hosting, sign-in) and users. Share files are not included — they stay with the parties.
      </p>

      {mode === 'idle' && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => setMode('backup')}>
            Download Backup
          </button>
          <button className="btn btn-secondary" onClick={() => setMode('restore')}>
            Restore
          </button>
        </div>
      )}

      {mode === 'backup' && (
        <div>
          <div className="form-row">
            <label>
              Backup Password
              <input type="password" autoFocus value={backupPassword}
                onChange={e => setBackupPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleBackup()}
                placeholder="Choose a password to encrypt the backup" />
            </label>
          </div>
          {error && <div className="warning" style={{ marginBottom: 8 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleBackup} disabled={loading || !backupPassword}>
              {loading ? <span className="spinner" /> : 'Download'}
            </button>
            <button className="btn btn-secondary" onClick={() => { setMode('idle'); setError(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {mode === 'restore' && (
        <div>
          <div className="form-row">
            <label>
              Backup Password
              <input type="password" autoFocus value={restorePassword}
                onChange={e => setRestorePassword(e.target.value)}
                placeholder="Password used when creating the backup" />
            </label>
          </div>
          {error && <div className="warning" style={{ marginBottom: 8 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleRestore} disabled={loading || !restorePassword}>
              {loading ? <span className="spinner" /> : 'Select Backup File'}
            </button>
            <button className="btn btn-secondary" onClick={() => { setMode('idle'); setError(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {message && <div style={{ fontSize: 13, color: 'var(--accent)', marginTop: 8 }}>{message}</div>}
    </div>
  );
}
