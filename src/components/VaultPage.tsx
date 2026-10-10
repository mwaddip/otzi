import { useState, useEffect, useCallback } from 'react';
import {
  getConfig, getBalance, getAddressBook, getRelayInfo, adminUnlock, setSession, getSessionRole,
  saveAddressBook, isAdminSession, type PrepareResponse,
} from '../lib/api';
import { formatBtc, explorerAddressUrl, explorerTxUrl, vaultParties } from '../lib/bitcoin';
import { labelFor } from '../lib/address-book';
import { NETWORK_LABELS, type AddressBookEntry, type AuthMode, type NetworkName, type VaultConfig } from '../lib/vault-types';
import { BtcSend } from './BtcSend';
import { LeaderSession, JoinerSession, type SendResult } from './SendSession';
import { OtziWordmark, ThemeToggle } from '../App';

interface Props {
  network: NetworkName;
  authMode: AuthMode;
  onSettings: () => void;
  initialSessionCode?: string | null;
}

type View =
  | { kind: 'home' }
  | { kind: 'compose' }
  | { kind: 'lead'; prepared: PrepareResponse }
  | { kind: 'join'; code: string }
  | { kind: 'result'; result: SendResult };

export function VaultPage({ network, authMode, onSettings, initialSessionCode }: Props) {
  const [config, setConfig] = useState<VaultConfig | null>(null);
  const [configError, setConfigError] = useState('');
  const [balance, setBalance] = useState<{ confirmed: number; unconfirmed: number } | null>(null);
  const [balanceError, setBalanceError] = useState('');
  const [addressBook, setAddressBook] = useState<AddressBookEntry[]>([]);
  const [view, setView] = useState<View>(initialSessionCode ? { kind: 'join', code: initialSessionCode } : { kind: 'home' });
  const [joinCode, setJoinCode] = useState('');
  const [activeSessions, setActiveSessions] = useState(0);
  const [copied, setCopied] = useState(false);
  const [adminPrompt, setAdminPrompt] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [adminError, setAdminError] = useState('');

  const canSend = authMode === 'password' ? isAdminSession() : getSessionRole() !== null;

  useEffect(() => {
    getConfig().then(setConfig).catch(e => setConfigError((e as Error).message));
    getAddressBook().then(r => setAddressBook(r.entries)).catch(() => {});
  }, []);

  const refreshBalance = useCallback(() => {
    getBalance()
      .then(b => { setBalance({ confirmed: b.confirmed, unconfirmed: b.unconfirmed }); setBalanceError(''); })
      .catch(e => setBalanceError((e as Error).message));
  }, []);

  useEffect(() => {
    if (view.kind !== 'home' && view.kind !== 'compose') return;
    refreshBalance();
    const iv = setInterval(refreshBalance, 30_000);
    return () => clearInterval(iv);
  }, [view.kind, refreshBalance]);

  useEffect(() => {
    if (view.kind !== 'home') return;
    const check = () => getRelayInfo().then(r => setActiveSessions(r.active)).catch(() => {});
    check();
    const iv = setInterval(check, 10_000);
    return () => clearInterval(iv);
  }, [view.kind]);

  const handleSend = () => {
    if (canSend) setView({ kind: 'compose' });
    else if (authMode === 'password') setAdminPrompt(true);
  };

  const handleAdminUnlock = async () => {
    setAdminError('');
    try {
      const { token } = await adminUnlock(adminPassword);
      setSession(token, 'password-admin');
      setAdminPrompt(false);
      setAdminPassword('');
      setView({ kind: 'compose' });
    } catch (e) {
      setAdminError((e as Error).message);
    }
  };

  const address = config?.vaultAddress;
  const vault = config?.vault;

  return (
    <div className="ceremony" style={{ maxWidth: 720 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <OtziWordmark height={32} />
          <p className="subtitle" style={{ marginBottom: 0, marginTop: 2 }}>
            {NETWORK_LABELS[network]}
            {vault ? ` · ${vault.minSigners}-of-${vaultParties(vault)}` : ''}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <ThemeToggle />
          {config && (
            <button onClick={onSettings} style={{ background: 'none', color: 'var(--gray-light)', fontSize: 20, padding: 4 }} title="Settings">⚙</button>
          )}
        </div>
      </div>

      {view.kind === 'home' && (
        <>
          {configError && !config && (
            <div className="card">
              <p style={{ fontSize: 14 }}>Sign in to view this vault, or join a signing session below.</p>
            </div>
          )}
          {config && address && (
            <div className="card">
              <div style={{ fontSize: 12, color: 'var(--white-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Balance</div>
              <div style={{ fontSize: 28, fontWeight: 700, fontFamily: 'monospace', margin: '4px 0' }}>
                {balance ? `${formatBtc(balance.confirmed)} BTC` : '—'}
              </div>
              {balance && balance.unconfirmed !== 0 && (
                <div style={{ fontSize: 13, color: 'var(--accent)' }}>{balance.unconfirmed > 0 ? '+' : ''}{formatBtc(balance.unconfirmed)} BTC pending</div>
              )}
              {balanceError && <div style={{ fontSize: 12, color: 'var(--red)' }}>{balanceError}</div>}

              <div style={{ fontSize: 12, color: 'var(--white-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 16 }}>Vault address</div>
              <div
                className="pubkey-display"
                style={{ cursor: 'pointer', fontSize: 13 }}
                title="Click to copy"
                onClick={() => void navigator.clipboard.writeText(address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
              >
                {address}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: 'var(--green)' }}>{copied ? 'Copied' : ''}</span>
                <a href={explorerAddressUrl(config.chainApiUrl, address)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>View on explorer ↗</a>
              </div>

              <button className="btn btn-primary btn-full" style={{ marginTop: 16 }} onClick={handleSend} disabled={!balance || balance.confirmed <= 0}>
                Send
              </button>
              {!canSend && authMode === 'accounts' && (
                <p style={{ fontSize: 12, color: 'var(--white-dim)', marginTop: 8 }}>Sign in to start a send.</p>
              )}
            </div>
          )}

          {adminPrompt && (
            <div className="card">
              <h2>Admin password</h2>
              <p style={{ fontSize: 13, color: 'var(--white-dim)' }}>Starting a send requires the admin password.</p>
              <input type="password" value={adminPassword} autoFocus onChange={e => setAdminPassword(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void handleAdminUnlock(); }} style={{ width: '100%', marginBottom: 12 }} />
              {adminError && <div className="warning">{adminError}</div>}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setAdminPrompt(false)}>Cancel</button>
                <button className="btn btn-primary" style={{ flex: 2 }} onClick={() => void handleAdminUnlock()} disabled={!adminPassword}>Continue</button>
              </div>
            </div>
          )}

          <div className="card">
            <h2>Co-sign</h2>
            <p style={{ fontSize: 13, color: 'var(--white-dim)' }}>
              {activeSessions > 0 ? `${activeSessions} session${activeSessions > 1 ? 's' : ''} open. ` : ''}
              Enter the session code you received.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={joinCode}
                maxLength={6}
                placeholder="CODE"
                onChange={e => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                onKeyDown={e => { if (e.key === 'Enter' && joinCode.length === 6) setView({ kind: 'join', code: joinCode }); }}
                style={{ flex: 1, fontFamily: 'monospace', fontSize: 18, letterSpacing: '0.15em', textAlign: 'center' }}
              />
              <button className="btn btn-primary" disabled={joinCode.length !== 6} onClick={() => setView({ kind: 'join', code: joinCode })}>Join</button>
            </div>
          </div>
        </>
      )}

      {view.kind === 'compose' && balance && config && (
        <BtcSend
          network={network}
          balance={balance.confirmed}
          addressBook={addressBook}
          onPrepared={prepared => setView({ kind: 'lead', prepared })}
          onCancel={() => setView({ kind: 'home' })}
        />
      )}

      {view.kind === 'lead' && vault && (
        <LeaderSession
          network={network}
          vault={vault}
          hosting={config?.hosting}
          prepared={view.prepared}
          addressBook={addressBook}
          onFinished={result => setView({ kind: 'result', result })}
          onCancel={() => setView({ kind: 'home' })}
        />
      )}

      {view.kind === 'join' && (
        <JoinerSession
          code={view.code}
          network={network}
          vault={vault}
          addressBook={addressBook}
          onFinished={result => setView({ kind: 'result', result })}
          onCancel={() => { setJoinCode(''); setView({ kind: 'home' }); }}
        />
      )}

      {view.kind === 'result' && (
        <SendResultCard
          result={view.result}
          chainApiUrl={config?.chainApiUrl}
          addressBook={addressBook}
          canEditBook={isAdminSession()}
          onBookSaved={setAddressBook}
          onDone={() => setView({ kind: 'home' })}
        />
      )}
    </div>
  );
}

function SendResultCard({ result, chainApiUrl, addressBook, canEditBook, onBookSaved, onDone }: {
  result: SendResult;
  chainApiUrl?: string;
  addressBook: AddressBookEntry[];
  canEditBook: boolean;
  onBookSaved: (entries: AddressBookEntry[]) => void;
  onDone: () => void;
}) {
  const unknown = result.payments.find(p => !labelFor(addressBook, p.address));
  const [label, setLabel] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!unknown || !label.trim()) return;
    try {
      const res = await saveAddressBook([...addressBook, { label: label.trim(), address: unknown.address }]);
      onBookSaved(res.entries);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="card">
      <h2>{result.broadcast ? 'Sent' : 'Signed'}</h2>
      <div className="success-box">
        {result.broadcast
          ? 'The transaction has been broadcast.'
          : 'Your signature is in. The initiator broadcasts the transaction.'}
      </div>
      {result.payments.map((p, i) => (
        <p key={i} style={{ fontSize: 14 }}>
          {formatBtc(p.amount)} BTC to {labelFor(addressBook, p.address) ?? <span style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>{p.address}</span>}
        </p>
      ))}
      <p style={{ fontSize: 13, color: 'var(--white-dim)' }}>Fee: {result.fee.toLocaleString()} sats</p>
      <div style={{ fontSize: 12, color: 'var(--white-dim)' }}>Transaction ID</div>
      <div className="pubkey-display" style={{ fontSize: 12 }}>{result.txid}</div>
      {chainApiUrl && (
        <a href={explorerTxUrl(chainApiUrl, result.txid)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', fontSize: 13 }}>
          View on explorer ↗
        </a>
      )}

      {canEditBook && unknown && !saved && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13, marginBottom: 4 }}>Save recipient to the address book</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Label" maxLength={64} style={{ flex: 1 }} />
            <button className="btn btn-secondary" onClick={() => void save()} disabled={!label.trim()}>Save</button>
          </div>
          {error && <div className="warning" style={{ marginTop: 8 }}>{error}</div>}
        </div>
      )}
      {saved && <p style={{ fontSize: 13, color: 'var(--green)' }}>Saved to address book.</p>}

      <button className="btn btn-primary btn-full" style={{ marginTop: 16 }} onClick={onDone}>Done</button>
    </div>
  );
}
