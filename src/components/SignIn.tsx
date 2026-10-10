import { useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import {
  passkeyLoginOptions, passkeyLogin, passkeyRegisterOptions, passkeyRegister,
  bitcoinLogin, bitcoinRegister, setSession, type SignInResult,
} from '../lib/api';
import { BitcoinSignature, type BitcoinProof } from './BitcoinSignature';
import { OtziWordmark } from '../App';

interface Props {
  onSignedIn: () => void;
  onJoinSession: (code: string) => void;
}

export function SignIn({ onSignedIn, onJoinSession }: Props) {
  const [mode, setMode] = useState<'signin' | 'invite'>('signin');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [label, setLabel] = useState('');
  const [sessionCode, setSessionCode] = useState('');

  const finish = (res: SignInResult) => {
    if (res.authenticated && res.token && res.role) {
      setSession(res.token, res.role);
      onSignedIn();
      return;
    }
    if (res.needsInvite) {
      setMode('invite');
      setInfo('This wallet is not registered yet. Enter an invite code to register it.');
      return;
    }
    throw new Error('Sign-in failed');
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const passkeySignIn = () => run(async () => {
    const { options } = await passkeyLoginOptions();
    finish(await passkeyLogin(await startAuthentication({ optionsJSON: options })));
  });

  const passkeyInvite = () => run(async () => {
    const { options } = await passkeyRegisterOptions(label || 'Ötzi user');
    finish(await passkeyRegister(await startRegistration({ optionsJSON: options }), inviteCode, label || undefined));
  });

  const bitcoinSignIn = async (p: BitcoinProof) => finish(await bitcoinLogin(p.address, p.challenge, p.signature));
  const bitcoinInvite = async (p: BitcoinProof) => finish(await bitcoinRegister(p.address, p.challenge, p.signature, inviteCode, label || undefined));

  return (
    <div className="ceremony">
      <div style={{ textAlign: 'center', marginBottom: 8 }}>
        <OtziWordmark height={48} />
      </div>
      <p className="subtitle" style={{ textAlign: 'center' }}>{mode === 'signin' ? 'Sign in' : 'Register with an invite'}</p>

      {mode === 'signin' && (
        <div className="card">
          <button className="btn btn-primary btn-full" style={{ marginBottom: 8 }} disabled={busy} onClick={() => void passkeySignIn()}>
            {busy ? <span className="spinner" /> : 'Sign in with passkey'}
          </button>
          <BitcoinSignature actionLabel="Sign in" busy={busy} onSigned={bitcoinSignIn} />
          {error && <div className="warning" style={{ marginTop: 12 }}>{error}</div>}
          <button className="btn btn-secondary btn-full" style={{ marginTop: 16 }} onClick={() => { setMode('invite'); setError(''); }}>
            I have an invite code
          </button>
        </div>
      )}

      {mode === 'invite' && (
        <div className="card">
          {info && <p style={{ fontSize: 13, color: 'var(--accent)' }}>{info}</p>}
          <div className="form-row">
            <label>
              Invite code
              <input value={inviteCode} maxLength={8} onChange={e => setInviteCode(e.target.value.toUpperCase().trim())} style={{ fontFamily: 'monospace', letterSpacing: '0.1em' }} />
            </label>
          </div>
          <div className="form-row">
            <label>
              Your name
              <input value={label} maxLength={64} onChange={e => setLabel(e.target.value)} />
            </label>
          </div>
          {inviteCode.length === 8 && (
            <>
              <button className="btn btn-primary btn-full" style={{ marginBottom: 8 }} disabled={busy} onClick={() => void passkeyInvite()}>
                {busy ? <span className="spinner" /> : 'Register a passkey'}
              </button>
              <BitcoinSignature actionLabel="Register" busy={busy} onSigned={bitcoinInvite} />
            </>
          )}
          {error && <div className="warning" style={{ marginTop: 12 }}>{error}</div>}
          <button className="btn btn-secondary btn-full" style={{ marginTop: 16 }} onClick={() => { setMode('signin'); setError(''); setInfo(''); }}>
            Back to sign in
          </button>
        </div>
      )}

      <div className="card">
        <h2>Co-sign</h2>
        <p style={{ fontSize: 13, color: 'var(--white-dim)' }}>Joining a signing session needs no account — only the session code and your share file.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={sessionCode}
            maxLength={6}
            placeholder="CODE"
            onChange={e => setSessionCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            style={{ flex: 1, fontFamily: 'monospace', fontSize: 18, letterSpacing: '0.15em', textAlign: 'center' }}
          />
          <button className="btn btn-primary" disabled={sessionCode.length !== 6} onClick={() => onJoinSession(sessionCode)}>Join</button>
        </div>
      </div>
    </div>
  );
}
