import type { ProposalAnalysis } from '../lib/bitcoin';
import { formatBtc } from '../lib/bitcoin';
import { labelFor } from '../lib/address-book';
import type { AddressBookEntry } from '../lib/vault-types';

interface Props {
  analysis: ProposalAnalysis;
  addressBook: AddressBookEntry[];
  title: string;
  approveLabel: string;
  rejectLabel?: string;
  /** Session fingerprint to compare with the initiator before approving. */
  fingerprint?: string;
  busy?: boolean;
  onApprove: () => void;
  onReject: () => void;
}

const HIGH_FEE_RATE = 200; // sat/vB

function Amount({ sats }: { sats: number }) {
  return (
    <span style={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
      {formatBtc(sats)} BTC <span style={{ color: 'var(--white-dim)', fontSize: 12 }}>({sats.toLocaleString()} sats)</span>
    </span>
  );
}

export function ProposalReview({ analysis, addressBook, title, approveLabel, rejectLabel = 'Reject', fingerprint, busy, onApprove, onReject }: Props) {
  const payments = analysis.outputs.filter(o => !o.isChange);
  const change = analysis.outputs.filter(o => o.isChange).reduce((s, o) => s + o.amount, 0);
  const sent = payments.reduce((s, o) => s + o.amount, 0);
  const highFee = analysis.feeRate > HIGH_FEE_RATE || analysis.fee > sent;

  return (
    <div className="card">
      <h2>{title}</h2>
      <p style={{ fontSize: 13, color: 'var(--white-dim)' }}>
        Decoded from the transaction itself. Check every line before approving.
      </p>

      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--white-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '16px 0 8px' }}>
        Pays
      </div>
      {payments.length === 0 && <div style={{ fontSize: 14 }}>Nothing leaves the vault (consolidation).</div>}
      {payments.map((o, i) => {
        const label = labelFor(addressBook, o.address);
        return (
          <div key={i} style={{ padding: 12, marginBottom: 8, border: '1px solid var(--border-dim)', background: 'var(--bg)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
              <strong style={{ fontSize: 14 }}>{label ?? 'Not in address book'}</strong>
              <Amount sats={o.amount} />
            </div>
            <div style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all', color: label ? 'var(--white)' : 'var(--accent)' }}>{o.address}</div>
          </div>
        );
      })}

      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', fontSize: 13, marginTop: 16 }}>
        <span style={{ color: 'var(--white-dim)' }}>Change to vault</span>
        <span>{change > 0 ? <Amount sats={change} /> : 'none'}</span>
        <span style={{ color: 'var(--white-dim)' }}>Network fee</span>
        <span><Amount sats={analysis.fee} /> · {analysis.feeRate.toFixed(1)} sat/vB</span>
        <span style={{ color: 'var(--white-dim)' }}>Coins spent</span>
        <span>{analysis.inputs.length} ({formatBtc(analysis.totalIn)} BTC)</span>
        <span style={{ color: 'var(--white-dim)' }}>Transaction ID</span>
        <span style={{ fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all' }}>{analysis.txid}</span>
      </div>

      {fingerprint && (
        <div style={{ marginTop: 16, padding: 10, border: '1px solid var(--border-dim)', fontSize: 13 }}>
          <div style={{ color: 'var(--white-dim)', fontSize: 12 }}>Session fingerprint — must match the initiator's</div>
          <div style={{ fontFamily: 'monospace', fontSize: 15, fontWeight: 600 }}>{fingerprint}</div>
        </div>
      )}

      {highFee && (
        <div className="warning" style={{ marginTop: 16 }}>
          Unusually high fee: {analysis.feeRate.toFixed(1)} sat/vB{analysis.fee > sent ? ', more than the amount sent' : ''}.
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onReject} disabled={busy}>{rejectLabel}</button>
        <button className="btn btn-primary" style={{ flex: 2 }} onClick={onApprove} disabled={busy}>
          {busy ? <span className="spinner" /> : approveLabel}
        </button>
      </div>
    </div>
  );
}
