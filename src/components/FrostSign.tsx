import { useState, useCallback, useRef, useEffect } from 'react';
import {
  signRound1,
  signRound2,
  signAggregate,
  verifySignature,
  type SigningCommitment,
  type SigningNonces,
  type SignatureShare,
} from '@mwaddip/frots';
import {
  encodeFrostSignR1,
  decodeFrostSignR1,
  encodeFrostSignR2,
  decodeFrostSignR2,
  type SighashInfo,
  type FrostSignatureSet,
} from '../lib/frost-sign';
import { decodeEnvelope, getSessionIdPrefix } from '../lib/dkg';
import { fromHex, toHex } from '../lib/hex';
import type { RelayClient } from '../lib/relay';
import type { DecryptedShare } from '../lib/share-file';

type FrostPhase = 'round1' | 'round2' | 'complete' | 'failed';

interface FrostSignProps {
  /** Sighashes this party computed itself from the approved transaction. */
  sighashes: SighashInfo[];
  share: DecryptedShare;
  isLeader: boolean;
  relayClient: RelayClient;
  onSignaturesReady: (sigs: FrostSignatureSet) => void;
  onCancel: () => void;
}

const FROST_STATE_PREFIX = 'FROST-STATE:';
const FROST_COMPLETE_PREFIX = 'FROST-COMPLETE:';
const LEADER = 0;

const byIdentifier = <T extends { identifier: number }>(a: T, b: T) => a.identifier - b.identifier;

export function FrostSign({ sighashes, share, isLeader, relayClient, onSignaturesReady, onCancel }: FrostSignProps) {
  const { keyPackage, publicKeyPackage, threshold, partyId } = share;
  const N = sighashes.length;

  const [phase, setPhase] = useState<FrostPhase>('round1');
  const [error, setError] = useState('');

  const noncesRef = useRef<SigningNonces[]>([]);
  const myCommitmentsRef = useRef<SigningCommitment[]>([]);
  const mySharesRef = useRef<SignatureShare[]>([]);
  const collectedR1Ref = useRef<Map<number, SigningCommitment[]>>(new Map());
  const collectedR2Ref = useRef<Map<number, SignatureShare[]>>(new Map());
  const [r1Count, setR1Count] = useState(0);
  const [r2Count, setR2Count] = useState(0);
  const blobsSentRef = useRef<Set<number>>(new Set());
  const phaseRef = useRef<FrostPhase>('round1');
  phaseRef.current = phase;

  // Envelope session id: the first sighash, identical for every signer of this transaction
  const sessionIdRef = useRef<Uint8Array>(fromHex(sighashes[0]!.hash));
  const sidPrefix = getSessionIdPrefix(sessionIdRef.current);

  const fail = useCallback((msg: string) => {
    setError(msg);
    setPhase('failed');
  }, []);

  const commitmentsFor = (i: number) => [...collectedR1Ref.current.values()].map(c => c[i]!).sort(byIdentifier);

  // ── Round 1: nonces + commitments for every sighash ──
  const doRound1 = useCallback(() => {
    const rng = { fillBytes(dest: Uint8Array) { crypto.getRandomValues(dest); } };
    const nonces: SigningNonces[] = [];
    const commitments: SigningCommitment[] = [];
    for (let i = 0; i < N; i++) {
      const out = signRound1(keyPackage, rng);
      nonces.push(out.nonces);
      commitments.push(out.commitments);
    }
    noncesRef.current = nonces;
    myCommitmentsRef.current = commitments;
    collectedR1Ref.current.set(partyId, commitments);
    setR1Count(collectedR1Ref.current.size);
    void relayClient.broadcast(new TextEncoder().encode(encodeFrostSignR1(partyId, commitments, sessionIdRef.current)));
    blobsSentRef.current.add(1);
  }, [N, keyPackage, partyId, relayClient]);

  // ── Round 2: signature shares ──
  const doRound2 = useCallback(() => {
    if (phaseRef.current !== 'round1') return;
    try {
      const shares: SignatureShare[] = [];
      for (let i = 0; i < N; i++) {
        shares.push(signRound2(keyPackage, noncesRef.current[i]!, fromHex(sighashes[i]!.hash), commitmentsFor(i), { tweaked: true }));
      }
      mySharesRef.current = shares;
      collectedR2Ref.current.set(partyId, shares);
      setR2Count(collectedR2Ref.current.size);
      setPhase('round2');
      void relayClient.broadcast(new TextEncoder().encode(encodeFrostSignR2(partyId, shares, sessionIdRef.current)));
      blobsSentRef.current.add(2);
    } catch (e) {
      fail(e instanceof Error ? e.message : 'Round 2 failed');
    }
  }, [N, sighashes, keyPackage, partyId, relayClient, fail]);

  // ── Aggregate (leader) ──
  const doAggregate = useCallback(() => {
    try {
      const signatures = sighashes.map((s, i) => {
        const shares = [...collectedR2Ref.current.values()].map(x => x[i]!).sort(byIdentifier);
        const sig = signAggregate(shares, fromHex(s.hash), commitmentsFor(i), publicKeyPackage, { tweaked: true });
        return { index: s.index, signature: toHex(sig) };
      });
      setPhase('complete');
      void relayClient.broadcast(new TextEncoder().encode(FROST_COMPLETE_PREFIX + JSON.stringify(signatures)));
      onSignaturesReady({ signatures });
    } catch (e) {
      fail(e instanceof Error ? e.message : 'Aggregation failed');
    }
  }, [sighashes, publicKeyPackage, relayClient, onSignaturesReady, fail]);

  // ── Joiner: accept the leader's signatures only if they verify under the vault key ──
  const acceptLeaderSignatures = useCallback((sigs: Array<{ index: number; signature: string }>) => {
    if (!Array.isArray(sigs) || sigs.length !== N) { fail('Leader sent the wrong number of signatures'); return; }
    for (const s of sighashes) {
      const sig = sigs.find(x => x.index === s.index);
      if (!sig || !/^[0-9a-f]{128}$/i.test(sig.signature)
        || !verifySignature(fromHex(sig.signature), fromHex(s.hash), publicKeyPackage.verifyingKey)) {
        fail(`Leader's signature for input ${s.index} does not verify`);
        return;
      }
    }
    setPhase('complete');
    onSignaturesReady({ signatures: sigs });
  }, [N, sighashes, publicKeyPackage, onSignaturesReady, fail]);

  // Start round 1 once
  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current || N === 0) return;
    initRef.current = true;
    doRound1();
  }, [N, doRound1]);

  // ── State sync ──
  const broadcastState = useCallback(() => {
    const round = phase === 'round1' ? 1 : phase === 'round2' ? 2 : phase === 'complete' ? 3 : 0;
    if (round === 0) return;
    const sent = [...blobsSentRef.current].join(',');
    void relayClient.broadcast(new TextEncoder().encode(`${FROST_STATE_PREFIX}${partyId}:${round}:${sent}`));
  }, [relayClient, phase, partyId]);

  useEffect(() => { broadcastState(); }, [broadcastState, r1Count, r2Count]);

  useEffect(() => {
    const iv = setInterval(broadcastState, 500);
    return () => clearInterval(iv);
  }, [broadcastState]);

  // ── Leader drives rounds ──
  useEffect(() => {
    if (!isLeader) return;
    if (phase === 'round1' && r1Count >= threshold) doRound2();
    else if (phase === 'round2' && r2Count >= threshold) doAggregate();
  }, [isLeader, phase, r1Count, r2Count, threshold, doRound2, doAggregate]);

  // ── Incoming relay messages ──
  useEffect(() => {
    const handler = (from: number, payload: Uint8Array) => {
      const text = new TextDecoder().decode(payload);

      if (text.startsWith(FROST_COMPLETE_PREFIX)) {
        if (isLeader || from !== LEADER || phaseRef.current === 'complete') return;
        try {
          acceptLeaderSignatures(JSON.parse(text.slice(FROST_COMPLETE_PREFIX.length)));
        } catch {
          fail('Leader sent malformed signatures');
        }
        return;
      }

      const state = text.match(/^FROST-STATE:(\d+):(\d+):([\d,]*)$/);
      if (state) {
        const peerRound = parseInt(state[2]!, 10);
        // Re-send our blob for the round the peer is in
        if (peerRound === 1 && blobsSentRef.current.has(1)) {
          void relayClient.broadcast(new TextEncoder().encode(encodeFrostSignR1(partyId, myCommitmentsRef.current, sessionIdRef.current)));
        }
        if (peerRound === 2 && blobsSentRef.current.has(2)) {
          void relayClient.broadcast(new TextEncoder().encode(encodeFrostSignR2(partyId, mySharesRef.current, sessionIdRef.current)));
        }
        // Joiner follows the leader into round 2
        if (!isLeader && from === LEADER && peerRound >= 2 && phaseRef.current === 'round1'
          && collectedR1Ref.current.size >= threshold) {
          doRound2();
        }
        return;
      }

      const env = decodeEnvelope(text);
      if (!env || env.sid !== sidPrefix || env.from === partyId) return;

      // Blobs are keyed by vault party ID (relay IDs follow join order and differ)
      const r1 = decodeFrostSignR1(text);
      if (r1 && r1.commitments.length === N && r1.commitments.every(c => c.identifier === r1.partyId + 1)
        && !collectedR1Ref.current.has(r1.partyId)) {
        collectedR1Ref.current.set(r1.partyId, r1.commitments);
        setR1Count(collectedR1Ref.current.size);
        return;
      }
      const r2 = decodeFrostSignR2(text);
      if (r2 && r2.shares.length === N && r2.shares.every(x => x.identifier === r2.partyId + 1)
        && !collectedR2Ref.current.has(r2.partyId)) {
        collectedR2Ref.current.set(r2.partyId, r2.shares);
        setR2Count(collectedR2Ref.current.size);
      }
    };

    relayClient.on('message', handler);
    return () => { relayClient.off('message', handler); };
  }, [relayClient, partyId, isLeader, threshold, N, sidPrefix, doRound2, acceptLeaderSignatures, fail]);

  return (
    <div className="card">
      <h2>Signing</h2>
      {phase === 'round1' && (
        <div className="threshold-hint" style={{ textAlign: 'center', padding: '8px 0' }}>
          <div className="spinner" style={{ margin: '0 auto 8px' }} />
          Round 1 — commitments {r1Count}/{threshold}
          {r1Count < threshold ? ' · waiting for co-signers to approve' : ''}
        </div>
      )}
      {phase === 'round2' && (
        <div className="threshold-hint" style={{ textAlign: 'center', padding: '8px 0' }}>
          <div className="spinner" style={{ margin: '0 auto 8px' }} />
          Round 2 — signature shares {r2Count}/{threshold}
        </div>
      )}
      {phase === 'complete' && (
        <div className="success-box">
          Signed {N} input{N !== 1 ? 's' : ''}.
        </div>
      )}
      {phase === 'failed' && (
        <>
          <div className="warning">{error || 'Signing failed'}</div>
          <button className="btn btn-secondary btn-full" onClick={onCancel}>Close session</button>
        </>
      )}
    </div>
  );
}
