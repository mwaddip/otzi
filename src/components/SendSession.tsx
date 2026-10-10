/**
 * Send ceremonies: LeaderSession (initiator) and JoinerSession (co-signer).
 * Protocol: facts/INTERFACES.md §7–§8.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { broadcastSend, type PrepareResponse } from '../lib/api';
import { analyzeProposal, type ProposalAnalysis } from '../lib/bitcoin';
import { toVaultKey } from '../lib/dkg';
import { useRelay, sessionLink } from '../lib/use-relay';
import type { DecryptedShare } from '../lib/share-file';
import type { FrostSignatureSet } from '../lib/frost-sign';
import type { AddressBookEntry, HostingConfig, NetworkName, SendProposal, VaultKey } from '../lib/vault-types';
import { ProposalReview } from './ProposalReview';
import { ShareImport } from './ShareImport';
import { SessionPanel } from './SessionPanel';
import { FrostSign } from './FrostSign';

export interface SendResult {
  txid: string;
  broadcast: boolean;
  payments: Array<{ address: string; amount: number }>;
  fee: number;
}

const PROPOSAL = 'PROPOSAL:';
const PROPOSAL_REQ = 'PROPOSAL-REQ:';
const REJECT = 'REJECT:';
const LEADER = 0;

const encodeText = (s: string) => new TextEncoder().encode(s);

function resultFrom(analysis: ProposalAnalysis, broadcast: boolean, txid = analysis.txid): SendResult {
  return {
    txid,
    broadcast,
    payments: analysis.outputs.filter(o => !o.isChange).map(o => ({ address: o.address, amount: o.amount })),
    fee: analysis.fee,
  };
}

// ── Leader ──

interface LeaderProps {
  network: NetworkName;
  vault: VaultKey;
  hosting?: HostingConfig | null;
  prepared: PrepareResponse;
  addressBook: AddressBookEntry[];
  onFinished: (result: SendResult) => void;
  onCancel: () => void;
}

export function LeaderSession({ network, vault, hosting, prepared, addressBook, onFinished, onCancel }: LeaderProps) {
  const [step, setStep] = useState<'review' | 'share' | 'session'>('review');
  const [share, setShare] = useState<DecryptedShare | null>(null);
  const [error, setError] = useState('');
  const [broadcasting, setBroadcasting] = useState(false);
  const [signatures, setSignatures] = useState<FrostSignatureSet | null>(null);
  const { relay, create, close } = useRelay();

  const checked = useMemo(() => {
    try { return { analysis: analyzeProposal(prepared.proposal, vault, network), error: '' }; } catch (e) { return { analysis: null, error: (e as Error).message }; }
  }, [prepared, vault, network]);
  const analysis = checked.analysis;

  // Sighashes from the loaded share's own key package
  const shareChecked = useMemo(() => {
    if (!share) return { sighashes: null, error: '' };
    try {
      return { sighashes: analyzeProposal(prepared.proposal, toVaultKey(share.publicKeyPackage), network).sighashes, error: '' };
    } catch (e) {
      return { sighashes: null, error: (e as Error).message };
    }
  }, [share, prepared, network]);
  const sighashes = shareChecked.sighashes;

  const handleShare = useCallback((s: DecryptedShare) => {
    setShare(s);
    setStep('session');
    void create(s.threshold, s.threshold);
  }, [create]);

  // Serve the proposal to co-signers; watch for rejections
  useEffect(() => {
    const client = relay.client;
    if (!client || !relay.ready) return;
    const payload = encodeText(PROPOSAL + btoa(JSON.stringify(prepared.proposal satisfies SendProposal)));
    void client.broadcast(payload);
    const handler = (from: number, data: Uint8Array) => {
      const text = new TextDecoder().decode(data);
      if (text.startsWith(PROPOSAL_REQ)) void client.send(from, payload);
      else if (text.startsWith(REJECT)) setError(`Party ${Number(text.slice(REJECT.length)) + 1} rejected the transaction.`);
    };
    client.on('message', handler);
    return () => client.off('message', handler);
  }, [relay.client, relay.ready, prepared]);

  const doBroadcast = useCallback(async (sigs: FrostSignatureSet) => {
    if (!analysis) return;
    setBroadcasting(true);
    setError('');
    try {
      const res = await broadcastSend(prepared.challengeToken, sigs.signatures);
      close();
      onFinished(resultFrom(analysis, true, res.txid));
    } catch (e) {
      setError(`Broadcast failed: ${(e as Error).message}`);
    } finally {
      setBroadcasting(false);
    }
  }, [analysis, prepared, close, onFinished]);

  const handleSignatures = useCallback((sigs: FrostSignatureSet) => {
    setSignatures(sigs);
    void doBroadcast(sigs);
  }, [doBroadcast]);

  const cancel = () => { close(); onCancel(); };

  if (!analysis) {
    return (
      <div className="card">
        <div className="warning">Cannot sign this transaction: {checked.error}</div>
        <button className="btn btn-secondary btn-full" onClick={cancel}>Back</button>
      </div>
    );
  }

  return (
    <>
      {step === 'review' && (
        <ProposalReview
          analysis={analysis}
          addressBook={addressBook}
          title="Review send"
          approveLabel="Approve & sign"
          rejectLabel="Cancel"
          onApprove={() => setStep('share')}
          onReject={cancel}
        />
      )}
      {step === 'share' && (
        <>
          <ShareImport network={network} vault={vault} onShareLoaded={handleShare} />
          <button className="btn btn-secondary btn-full" onClick={cancel}>Cancel</button>
        </>
      )}
      {step === 'session' && share && (
        <>
          <SessionPanel
            relay={relay}
            link={relay.code ? sessionLink(relay.code, hosting) : undefined}
            waitingFor={`Send this link to ${share.threshold - 1} co-signer${share.threshold > 2 ? 's' : ''}`}
          />
          {relay.ready && relay.client && sighashes && !error && !signatures && (
            <FrostSign
              sighashes={sighashes}
              share={share}
              isLeader
              relayClient={relay.client}
              onSignaturesReady={handleSignatures}
              onCancel={cancel}
            />
          )}
          {broadcasting && <div className="card" style={{ textAlign: 'center' }}><div className="spinner" /> Broadcasting…</div>}
          {(error || shareChecked.error) && <div className="warning">{error || shareChecked.error}</div>}
          {error && signatures && !broadcasting && (
            <button className="btn btn-primary btn-full" style={{ marginBottom: 8 }} onClick={() => void doBroadcast(signatures)}>Retry broadcast</button>
          )}
          {!broadcasting && <button className="btn btn-secondary btn-full" onClick={cancel}>{signatures ? 'Close' : 'Cancel session'}</button>}
        </>
      )}
    </>
  );
}

// ── Co-signer ──

interface JoinerProps {
  code: string;
  network: NetworkName;
  /** Instance vault when readable; the share file's own key package is authoritative for signing. */
  vault?: VaultKey;
  addressBook: AddressBookEntry[];
  onFinished: (result: SendResult) => void;
  onCancel: () => void;
}

export function JoinerSession({ code, network, vault, addressBook, onFinished, onCancel }: JoinerProps) {
  const [share, setShare] = useState<DecryptedShare | null>(null);
  const [proposalError, setProposalError] = useState('');
  const [analysis, setAnalysis] = useState<ProposalAnalysis | null>(null);
  const [approved, setApproved] = useState(false);
  const { relay, join, close } = useRelay();
  const shareRef = useRef<DecryptedShare | null>(null);

  const handleShare = useCallback((s: DecryptedShare) => {
    shareRef.current = s;
    setShare(s);
    void join(code);
  }, [code, join]);

  // Receive the proposal from the leader; ask for it until it arrives
  useEffect(() => {
    const client = relay.client;
    if (!client || !relay.ready || !share) return;
    let received = false;
    const handler = (from: number, data: Uint8Array) => {
      const text = new TextDecoder().decode(data);
      if (from !== LEADER || !text.startsWith(PROPOSAL) || received) return;
      received = true;
      try {
        const proposal = JSON.parse(atob(text.slice(PROPOSAL.length))) as SendProposal;
        setAnalysis(analyzeProposal(proposal, toVaultKey(share.publicKeyPackage), share.network));
      } catch (e) {
        setProposalError((e as Error).message || 'Malformed proposal');
      }
    };
    client.on('message', handler);
    const ask = () => { if (!received) void client.broadcast(encodeText(`${PROPOSAL_REQ}${share.partyId}`)); };
    ask();
    const iv = setInterval(ask, 2000);
    return () => { clearInterval(iv); client.off('message', handler); };
  }, [relay.client, relay.ready, share]);

  const reject = useCallback(async () => {
    const client = relay.client;
    // Deliver the rejection before the session closes
    if (client?.isReady && shareRef.current) {
      await client.broadcast(encodeText(`${REJECT}${shareRef.current.partyId}`)).catch(() => {});
    }
    close();
    onCancel();
  }, [relay.client, close, onCancel]);

  const handleSignatures = useCallback(() => {
    if (!analysis) return;
    close();
    onFinished(resultFrom(analysis, false));
  }, [analysis, close, onFinished]);

  if (!share) {
    return (
      <>
        <ShareImport network={network} vault={vault} title={`Join session ${code}`} onShareLoaded={handleShare} />
        <button className="btn btn-secondary btn-full" onClick={onCancel}>Cancel</button>
      </>
    );
  }

  return (
    <>
      <SessionPanel relay={relay} waitingFor="Waiting for all co-signers to connect" />
      {relay.ready && !analysis && !proposalError && (
        <div className="card" style={{ textAlign: 'center' }}>
          <div className="spinner" style={{ margin: '0 auto 8px' }} />
          Waiting for the transaction from the initiator…
        </div>
      )}
      {proposalError && (
        <div className="card">
          <div className="warning">This transaction cannot be signed by this vault: {proposalError}</div>
          <button className="btn btn-primary btn-full" onClick={reject}>Reject</button>
        </div>
      )}
      {analysis && !approved && (
        <ProposalReview
          analysis={analysis}
          addressBook={addressBook}
          title="Approve transaction"
          approveLabel="Approve & sign"
          onApprove={() => setApproved(true)}
          onReject={reject}
        />
      )}
      {analysis && approved && relay.client && (
        <FrostSign
          sighashes={analysis.sighashes}
          share={share}
          isLeader={false}
          relayClient={relay.client}
          onSignaturesReady={handleSignatures}
          onCancel={reject}
        />
      )}
      {!approved && !proposalError && (
        <button className="btn btn-secondary btn-full" onClick={reject}>Leave session</button>
      )}
    </>
  );
}
