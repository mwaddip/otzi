/**
 * DKGWizard — FROST distributed key generation ceremony.
 *
 * join → commit (FROST round 1) → shares (FROST round 2) → verify → complete
 *
 * Each party runs this in its own browser over one encrypted relay session.
 * Protocol: facts/INTERFACES.md §6.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  dkgRound1, dkgRound2, dkgFinalize, signRound1, signRound2, signAggregate, verifySignature,
  type Round1SecretPackage, type Round2SecretPackage, type KeyPackage, type PublicKeyPackage,
  type SigningCommitment, type SigningNonces, type SignatureShare,
} from '@mwaddip/frots';
import {
  generateSessionId, getSessionIdPrefix, encodeSessionConfig, decodeSessionConfig, identifyBlob,
  encodeFrostRound1, decodeFrostRound1, encodeFrostRound2, decodeFrostRound2,
  partyIdToFrostId, frostIdToPartyId, dkgVerifyMessage, toVaultKey,
  type FrostRound1Package, type FrostRound2Package,
} from '../lib/dkg';
import { encodeFrostSignR1, decodeFrostSignR1, encodeFrostSignR2, decodeFrostSignR2 } from '../lib/frost-sign';
import { encryptShareFile, downloadShareFile, type DecryptedShare } from '../lib/share-file';
import { vaultPaymentFromInternalKey } from '../lib/bitcoin';
import { toHex } from '../lib/hex';
import { useRelay, sessionLink } from '../lib/use-relay';
import { getRelayInfo, getHosting, saveVault, adminUnlock, setSession, isAdminSession } from '../lib/api';
import { NETWORK_LABELS, type HostingConfig, type NetworkName } from '../lib/vault-types';
import { PasswordModal } from './PasswordModal';
import { SessionPanel } from './SessionPanel';
import { ShareImport } from './ShareImport';
import { OtziWordmark } from '../App';

type Step = 'join' | 'commit' | 'shares' | 'verify' | 'complete';
const STEPS: Step[] = ['join', 'commit', 'shares', 'verify', 'complete'];
const STEP_TITLES: Record<Step, string> = {
  join: 'Start', commit: 'Commit', shares: 'Shares', verify: 'Verify', complete: 'Complete',
};

const rng = { fillBytes(dest: Uint8Array) { crypto.getRandomValues(dest); } };
const RESEND_MS = 3000;

interface Ceremony {
  step: Step;
  t: number;
  n: number;
  sid: Uint8Array | null;
  me: number;
  error: string;
  sessionBlob: string | null;
  r1Secret: Round1SecretPackage | null;
  r1Blob: string | null;
  r1: Map<number, FrostRound1Package>;
  r2Secret: Round2SecretPackage | null;
  r2Blobs: Map<number, string>;
  r2: Map<number, FrostRound2Package>;
  barriers: Record<'commit' | 'shares', Set<number>>;
  keyPackage: KeyPackage | null;
  pkp: PublicKeyPackage | null;
  verifyMsg: Uint8Array | null;
  nonces: SigningNonces | null;
  commitBlob: string | null;
  shareBlob: string | null;
  vc: Map<number, SigningCommitment>;
  vs: Map<number, SignatureShare>;
}

function freshCeremony(): Ceremony {
  return {
    step: 'join', t: 2, n: 3, sid: null, me: -1, error: '', sessionBlob: null,
    r1Secret: null, r1Blob: null, r1: new Map(),
    r2Secret: null, r2Blobs: new Map(), r2: new Map(),
    barriers: { commit: new Set(), shares: new Set() },
    keyPackage: null, pkp: null, verifyMsg: null, nonces: null, commitBlob: null, shareBlob: null,
    vc: new Map(), vs: new Map(),
  };
}

function PartyTracker({ collected, total, me, label }: { collected: number[]; total: number; me: number; label: string }) {
  return (
    <div className="party-tracker">
      <span className="tracker-label">{label}:</span>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={`tracker-dot ${collected.includes(i) ? 'collected' : ''} ${i === me ? 'self' : ''}`}>
          {i + 1}{collected.includes(i) ? ' ✓' : ' ○'}
        </span>
      ))}
    </div>
  );
}

interface Props {
  network: NetworkName;
  onComplete: () => void;
  initialSessionCode?: string | null;
}

export function DKGWizard({ network, onComplete, initialSessionCode }: Props) {
  const c = useRef<Ceremony>(freshCeremony()).current;
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick(x => x + 1), []);
  const { relay, create, join, close } = useRelay();
  const clientRef = useRef(relay.client);
  clientRef.current = relay.client;
  const sendChain = useRef<Promise<void>>(Promise.resolve());

  const [threshold, setThreshold] = useState(2);
  const [parties, setParties] = useState(3);
  const [maxParties, setMaxParties] = useState(10);
  const [joinCode, setJoinCode] = useState(initialSessionCode ?? '');
  const [hosting, setHosting] = useState<HostingConfig | null>(null);
  const [mode, setMode] = useState<'choose' | 'existing'>('choose');
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'needs-admin' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  const [adminPassword, setAdminPassword] = useState('');

  useEffect(() => {
    getRelayInfo().then(r => setMaxParties(r.maxParties)).catch(() => {});
    getHosting().then(r => setHosting(r.hosting ?? null)).catch(() => {});
  }, []);

  // ── Sending (serialized so each peer receives our blobs in order) ──

  const send = useCallback((text: string, to?: number) => {
    const client = clientRef.current;
    if (!client) return;
    const bytes = new TextEncoder().encode(text);
    sendChain.current = sendChain.current
      .then(() => (to === undefined ? client.broadcast(bytes) : client.send(to, bytes)))
      .catch(() => { /* relay reports errors via its error event */ });
  }, []);

  /** Re-send everything this party has produced so far; receivers ignore duplicates. */
  const resend = useCallback(() => {
    if (c.step === 'join' || c.step === 'complete' || c.error) return;
    if (c.sessionBlob) send(c.sessionBlob);
    if (c.r1Blob) send(c.r1Blob);
    for (const [to, blob] of c.r2Blobs) send(blob, to);
    if (c.barriers.commit.has(c.me)) send(`BARRIER:commit:${c.me}`);
    if (c.barriers.shares.has(c.me)) send(`BARRIER:shares:${c.me}`);
    if (c.commitBlob) send(c.commitBlob);
    if (c.shareBlob) send(c.shareBlob);
  }, [c, send]);

  // ── Ceremony state machine ──

  const advance = useCallback(() => {
    if (c.error || !c.sid) { bump(); return; }
    try {
      for (let guard = 0; guard < 5; guard++) {
        const before = c.step;

        if (c.step === 'commit') {
          if (!c.r1Secret) {
            const { secretPackage, package: pkg } = dkgRound1(partyIdToFrostId(c.me), c.n, c.t, rng);
            c.r1Secret = secretPackage;
            c.r1.set(c.me, pkg);
            c.r1Blob = encodeFrostRound1(pkg, c.sid);
            send(c.r1Blob);
          }
          if (c.r1.size === c.n && !c.barriers.commit.has(c.me)) {
            c.barriers.commit.add(c.me);
            send(`BARRIER:commit:${c.me}`);
          }
          if (c.barriers.commit.size === c.n) c.step = 'shares';
        }

        if (c.step === 'shares') {
          if (!c.r2Secret) {
            const others = new Map([...c.r1].filter(([p]) => p !== c.me).map(([, pkg]) => [pkg.identifier, pkg]));
            const { secretPackage, packages } = dkgRound2(c.r1Secret!, others);
            c.r2Secret = secretPackage;
            for (const [recipient, pkg] of packages) {
              const to = frostIdToPartyId(recipient);
              const blob = encodeFrostRound2(pkg, c.sid);
              c.r2Blobs.set(to, blob);
              send(blob, to);
            }
          }
          if (c.r2.size === c.n - 1 && !c.barriers.shares.has(c.me)) {
            c.barriers.shares.add(c.me);
            send(`BARRIER:shares:${c.me}`);
          }
          if (c.barriers.shares.size === c.n) c.step = 'verify';
        }

        if (c.step === 'verify') {
          if (!c.keyPackage) {
            const others = new Map([...c.r1].filter(([p]) => p !== c.me).map(([, pkg]) => [pkg.identifier, pkg]));
            const received = new Map([...c.r2.values()].map(pkg => [pkg.sender, pkg]));
            const { keyPackage, publicKeyPackage } = dkgFinalize(c.r2Secret!, others, received);
            c.keyPackage = keyPackage;
            c.pkp = publicKeyPackage;
            c.verifyMsg = dkgVerifyMessage(c.sid, network, publicKeyPackage);
            const { nonces, commitments } = signRound1(keyPackage, rng);
            c.nonces = nonces;
            c.vc.set(c.me, commitments);
            c.commitBlob = encodeFrostSignR1(c.me, [commitments], c.sid);
            send(c.commitBlob);
          }
          const commitments = () => [...c.vc.values()].sort((a, b) => a.identifier - b.identifier);
          if (c.vc.size === c.n && !c.vs.has(c.me)) {
            const share = signRound2(c.keyPackage, c.nonces!, c.verifyMsg!, commitments(), { tweaked: true });
            c.vs.set(c.me, share);
            c.shareBlob = encodeFrostSignR2(c.me, [share], c.sid);
            send(c.shareBlob);
          }
          if (c.vs.size === c.n) {
            const shares = [...c.vs.values()].sort((a, b) => a.identifier - b.identifier);
            const sig = signAggregate(shares, c.verifyMsg!, commitments(), c.pkp!, { tweaked: true });
            if (!verifySignature(sig, c.verifyMsg!, c.pkp!.verifyingKey)) throw new Error('Verification signature is invalid');
            c.step = 'complete';
          }
        }

        if (c.step === before) break;
      }
    } catch (e) {
      c.error = e instanceof Error ? e.message : String(e);
    }
    bump();
  }, [c, network, send, bump]);

  // ── Incoming relay messages ──

  useEffect(() => {
    const client = relay.client;
    if (!client) return;
    const handler = (from: number, payload: Uint8Array) => {
      const text = new TextDecoder().decode(payload);

      const barrier = text.match(/^BARRIER:(commit|shares):(\d+)$/);
      if (barrier) {
        const pid = Number(barrier[2]);
        if (pid === from) c.barriers[barrier[1] as 'commit' | 'shares'].add(pid);
        advance();
        return;
      }

      const info = identifyBlob(text);
      if (!info) return;

      if (info.type === 'session') {
        if (from !== 0 || c.sid) return;
        const config = decodeSessionConfig(text);
        if (!config) return;
        if (config.network !== network) {
          c.error = `The session is for ${config.network}; this instance is on ${network}.`;
          bump();
          return;
        }
        c.t = config.t;
        c.n = config.n;
        c.sid = Uint8Array.from(config.sid.match(/.{2}/g)!.map(h => parseInt(h, 16)));
        c.me = client.partyId;
        c.step = 'commit';
        advance();
        return;
      }

      if (!c.sid || info.sid !== getSessionIdPrefix(c.sid) || info.from !== from || from === c.me) return;
      if (info.to !== -1 && info.to !== c.me) return;

      if (info.type === 'frost-r1') {
        const pkg = decodeFrostRound1(text);
        if (pkg && !c.r1.has(from)) {
          if (pkg.commitment.length !== c.t) { c.error = `Party ${from + 1} sent an invalid commitment`; bump(); return; }
          c.r1.set(from, pkg);
        }
      } else if (info.type === 'frost-r2') {
        const pkg = decodeFrostRound2(text);
        if (pkg && pkg.recipient === partyIdToFrostId(c.me) && !c.r2.has(from)) c.r2.set(from, pkg);
      } else if (info.type === 'frost-sign-r1') {
        const d = decodeFrostSignR1(text);
        const commitment = d?.commitments[0];
        if (d && d.partyId === from && commitment?.identifier === from + 1 && !c.vc.has(from)) c.vc.set(from, commitment);
      } else if (info.type === 'frost-sign-r2') {
        const d = decodeFrostSignR2(text);
        const share = d?.shares[0];
        if (d && d.partyId === from && share?.identifier === from + 1 && !c.vs.has(from)) c.vs.set(from, share);
      }
      advance();
    };
    client.on('message', handler);
    return () => client.off('message', handler);
  }, [relay.client, c, network, advance, bump]);

  // Creator starts the ceremony once everyone is connected
  useEffect(() => {
    const client = relay.client;
    if (!client || !relay.ready || client.partyId !== 0 || c.sid) return;
    c.sid = generateSessionId();
    c.me = 0;
    c.t = threshold;
    c.n = parties;
    c.sessionBlob = encodeSessionConfig(threshold, parties, network, c.sid);
    send(c.sessionBlob);
    c.step = 'commit';
    advance();
  }, [relay.client, relay.ready, c, threshold, parties, network, send, advance]);

  // Periodic re-send until complete
  useEffect(() => {
    if (!relay.ready) return;
    const iv = setInterval(resend, RESEND_MS);
    return () => clearInterval(iv);
  }, [relay.ready, resend]);

  // Auto-join from ?session=CODE
  const autoJoined = useRef(false);
  useEffect(() => {
    if (autoJoined.current || !initialSessionCode || initialSessionCode.length !== 6) return;
    autoJoined.current = true;
    void join(initialSessionCode);
  }, [initialSessionCode, join]);

  const restart = () => {
    close();
    Object.assign(c, freshCeremony());
    setDownloaded(false);
    setSaveState('idle');
    bump();
  };

  // ── Completion ──

  const vaultAddress = c.pkp ? vaultPaymentFromInternalKey(toHex(c.pkp.untweakedVerifyingKey), network).address : '';

  const trySave = useCallback(async () => {
    if (!c.pkp) return;
    try {
      await saveVault(toVaultKey(c.pkp));
      setSaveState('saved');
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 401 || status === 403) setSaveState('needs-admin');
      else { setSaveState('error'); setSaveError((e as Error).message); }
    }
  }, [c]);

  const handleDownload = useCallback(async (password: string) => {
    if (!c.keyPackage || !c.pkp) return;
    try {
      const file = await encryptShareFile(c.keyPackage, c.pkp, network, c.me, password);
      downloadShareFile(file);
      setDownloaded(true);
      setShowPasswordModal(false);
      if (isAdminSession()) await trySave();
    } catch (e) {
      c.error = `Could not create the share file: ${(e as Error).message}`;
      setShowPasswordModal(false);
      bump();
    }
  }, [c, network, trySave, bump]);

  const handleAdminSave = async () => {
    try {
      const { token } = await adminUnlock(adminPassword);
      setSession(token, 'password-admin');
      setAdminPassword('');
      await trySave();
    } catch (e) {
      setSaveError((e as Error).message);
    }
  };

  const handleExistingShare = async (share: DecryptedShare) => {
    try {
      await saveVault(toVaultKey(share.publicKeyPackage));
      onComplete();
    } catch (e) {
      c.error = (e as Error).message;
      bump();
    }
  };

  // ── Render ──

  const stepIndex = STEPS.indexOf(c.step);
  const inCeremony = c.step !== 'join' && c.step !== 'complete';

  return (
    <div className="ceremony">
      <div style={{ textAlign: 'center', marginBottom: 8 }}>
        <OtziWordmark height={44} />
      </div>
      <h1 style={{ textAlign: 'center', fontSize: 18, fontWeight: 500, marginBottom: 0 }}>Create the vault key</h1>
      <p className="subtitle">
        {c.sid ? `${c.t}-of-${c.n} · ${NETWORK_LABELS[network]}` : `Distributed key generation · ${NETWORK_LABELS[network]}`}
      </p>

      <div className="steps">
        {STEPS.map((s, i) => (
          <div key={s} title={STEP_TITLES[s]} className={`step-dot ${i === stepIndex ? 'active' : ''} ${i < stepIndex ? 'done' : ''}`} />
        ))}
      </div>

      {inCeremony && <div className="warning">Do not refresh this page — the ceremony lives in this tab's memory.</div>}

      {c.error && (
        <div className="card">
          <div className="warning">{c.error}</div>
          <button className="btn btn-secondary btn-full" onClick={restart}>Start over</button>
        </div>
      )}

      {/* ── Join / create ── */}
      {c.step === 'join' && !c.error && !relay.client && mode === 'choose' && (
        <div className="card">
          <h2>Join a ceremony</h2>
          <div className="form-row" style={{ marginBottom: 16 }}>
            <label>
              Session code
              <input
                value={joinCode}
                maxLength={6}
                placeholder="Paste the code you received"
                onChange={e => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                style={{ fontFamily: 'monospace', fontSize: 18, letterSpacing: '0.15em', textAlign: 'center' }}
              />
            </label>
          </div>
          <button className="btn btn-primary btn-full" disabled={joinCode.length !== 6} onClick={() => void join(joinCode)}>Join</button>

          <h2 style={{ marginTop: 24 }}>Or start a new one</h2>
          <div className="form-row">
            <label>
              Threshold (T)
              <select value={threshold} onChange={e => { const t = Number(e.target.value); setThreshold(t); setParties(p => Math.max(p, t)); }}>
                {Array.from({ length: maxParties - 1 }, (_, i) => i + 2).map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label>
              Parties (N)
              <select value={parties} onChange={e => setParties(Number(e.target.value))}>
                {Array.from({ length: maxParties - 1 }, (_, i) => i + 2).filter(n => n >= threshold).map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
          <p style={{ fontSize: 13, color: 'var(--white-dim)' }}>
            Any {threshold} of {parties} parties can spend. Fewer cannot.
          </p>
          <button className="btn btn-primary btn-full" onClick={() => void create(parties, threshold)}>Create session</button>

          {isAdminSession() && (
            <button className="btn btn-secondary btn-full" style={{ marginTop: 16 }} onClick={() => setMode('existing')}>
              Use existing share file
            </button>
          )}
        </div>
      )}

      {c.step === 'join' && mode === 'existing' && !relay.client && (
        <>
          <ShareImport network={network} title="Connect an existing vault" onShareLoaded={s => void handleExistingShare(s)} />
          <button className="btn btn-secondary btn-full" onClick={() => setMode('choose')}>Back</button>
        </>
      )}

      {c.step === 'join' && relay.client && !c.error && (
        <>
          <SessionPanel
            relay={relay}
            link={relay.client.partyId === 0 && relay.code ? sessionLink(relay.code, hosting) : undefined}
            waitingFor={relay.client.partyId === 0 ? `Share this link with ${parties - 1} other part${parties - 1 === 1 ? 'y' : 'ies'}` : 'Waiting for all parties to join'}
          />
          {relay.ready && (
            <div className="card" style={{ textAlign: 'center' }}><div className="spinner" style={{ margin: '0 auto' }} /> Starting…</div>
          )}
          <button className="btn btn-secondary btn-full" onClick={restart}>Cancel</button>
        </>
      )}
      {c.step === 'join' && !relay.client && relay.error && <div className="warning">{relay.error}</div>}

      {/* ── Ceremony steps ── */}
      {inCeremony && !c.error && (
        <div className="card">
          {relay.fingerprint && (
            <div style={{ marginBottom: 12 }}>
              <span style={{ fontSize: 12, color: 'var(--white-dim)' }}>Session fingerprint — compare with every party</span>
              <div style={{ fontFamily: 'monospace', fontSize: 16, fontWeight: 600 }}>{relay.fingerprint}</div>
            </div>
          )}
          {c.step === 'commit' && (
            <>
              <h2>Commit</h2>
              <p>Each party commits to its secret polynomial and proves knowledge of it.</p>
              <PartyTracker collected={[...c.r1.keys()]} total={c.n} me={c.me} label="Commitments" />
              <PartyTracker collected={[...c.barriers.commit]} total={c.n} me={c.me} label="Ready" />
            </>
          )}
          {c.step === 'shares' && (
            <>
              <h2>Shares</h2>
              <p>Each party sends every other party a private share.</p>
              <PartyTracker collected={[c.me, ...c.r2.keys()]} total={c.n} me={c.me} label="Shares" />
              <PartyTracker collected={[...c.barriers.shares]} total={c.n} me={c.me} label="Ready" />
            </>
          )}
          {c.step === 'verify' && (
            <>
              <h2>Verify</h2>
              <p>All parties sign a transcript of the ceremony with the new key.</p>
              <PartyTracker collected={[...c.vc.keys()]} total={c.n} me={c.me} label="Commitments" />
              <PartyTracker collected={[...c.vs.keys()]} total={c.n} me={c.me} label="Signatures" />
            </>
          )}
          {relay.error && <div className="warning" style={{ marginTop: 12 }}>{relay.error}</div>}
        </div>
      )}

      {/* ── Complete ── */}
      {c.step === 'complete' && c.pkp && !c.error && (
        <div className="card">
          <h2>Vault created</h2>
          <div className="success-box">
            All {c.n} parties hold a share of the key and proved it by signing together. Any {c.t} of them can spend.
          </div>

          <div style={{ fontSize: 12, color: 'var(--white-dim)' }}>Vault address — compare with every party</div>
          <div className="pubkey-display" style={{ fontSize: 13 }}>{vaultAddress}</div>
          {relay.fingerprint && (
            <div style={{ fontSize: 12, color: 'var(--white-dim)', marginBottom: 16 }}>Session fingerprint: <span style={{ fontFamily: 'monospace' }}>{relay.fingerprint}</span></div>
          )}

          {!downloaded && (
            <button className="btn btn-primary btn-full" onClick={() => setShowPasswordModal(true)}>
              Download share file (party {c.me + 1})
            </button>
          )}
          {downloaded && (
            <div className="success-box">Share file downloaded. Keep it and its password safe — both are needed to sign.</div>
          )}

          {downloaded && saveState === 'needs-admin' && (
            <div style={{ marginTop: 12 }}>
              <p style={{ fontSize: 13 }}>Enter the admin password to connect this instance to the vault.</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="password" value={adminPassword} onChange={e => setAdminPassword(e.target.value)} style={{ flex: 1 }} />
                <button className="btn btn-secondary" onClick={() => void handleAdminSave()} disabled={!adminPassword}>Save</button>
              </div>
            </div>
          )}
          {saveError && <div className="warning" style={{ marginTop: 12 }}>{saveError}</div>}

          {downloaded && (
            <button className="btn btn-secondary btn-full" style={{ marginTop: 16 }} onClick={() => { close(); onComplete(); }}>
              {saveState === 'saved' ? 'Open vault' : 'Continue'}
            </button>
          )}
        </div>
      )}

      {showPasswordModal && (
        <PasswordModal partyId={c.me} onConfirm={p => void handleDownload(p)} onCancel={() => setShowPasswordModal(false)} />
      )}
    </div>
  );
}
