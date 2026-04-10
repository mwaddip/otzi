import { useState, useEffect, useRef } from 'react';
import { getBtcFees, prepareBtcSend } from '../lib/api';
import type { SighashInfo } from '../lib/frost-sign';

type AmountUnit = 'btc' | 'mbtc' | 'ubtc' | 'sats';
type FeeLevel = 'low' | 'normal' | 'high';

const UNIT_LABELS: Record<AmountUnit, string> = {
  btc: 'BTC',
  mbtc: 'mBTC',
  ubtc: '\u00B5BTC',
  sats: 'sats',
};

const UNIT_DIVISORS: Record<AmountUnit, number> = {
  btc: 1e8,
  mbtc: 1e5,
  ubtc: 1e2,
  sats: 1,
};

const FEE_LABELS: Record<FeeLevel, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
};

interface Props {
  balance: string | null;
  onPrepared: (sighashes: SighashInfo[], challengeToken: string, summary: BtcTxSummary) => void;
  onCancel: () => void;
}

export interface BtcTxSummary {
  to: string;
  amount: number;
  fee: number;
  change: number;
}

export function BtcSend({ balance, onPrepared, onCancel }: Props) {
  const [to, setTo] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [unit, setUnit] = useState<AmountUnit>('btc');
  const [feeLevel, setFeeLevel] = useState<FeeLevel>('normal');
  const [feeRates, setFeeRates] = useState<Record<FeeLevel, number> | null>(null);
  const [error, setError] = useState('');
  const [preparing, setPreparing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus recipient input
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Fetch fee rates
  useEffect(() => {
    getBtcFees().then(fees => {
      setFeeRates({ low: fees.low, normal: fees.normal, high: fees.high });
    }).catch(() => {
      setFeeRates({ low: 1, normal: 5, high: 10 });
    });
  }, []);

  const amountSats = Math.round(parseFloat(amountStr || '0') * UNIT_DIVISORS[unit]);
  const balanceSats = parseInt(balance || '0', 10);
  const selectedFeeRate = feeRates?.[feeLevel] ?? 5;

  const handlePrepare = async () => {
    setError('');

    if (!to.trim()) { setError('Enter a destination address'); return; }
    if (!amountSats || amountSats <= 0) { setError('Enter a valid amount'); return; }
    if (amountSats > balanceSats) { setError('Insufficient balance'); return; }

    setPreparing(true);
    try {
      const result = await prepareBtcSend({
        to: to.trim(),
        amount: amountSats,
        feeRate: selectedFeeRate,
      });
      onPrepared(result.sighashes, result.challengeToken, {
        to: to.trim(),
        amount: amountSats,
        fee: result.estimatedFee,
        change: result.changeAmount,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPreparing(false);
    }
  };

  return (
    <div className="card">
      <h2>Send BTC</h2>

      {/* Balance */}
      <div style={{ fontSize: 13, color: 'var(--white-dim)', marginBottom: 16 }}>
        Available: <strong>{(balanceSats / 1e8).toFixed(8)} BTC</strong>
      </div>

      {/* Recipient */}
      <label style={{ fontSize: 13, color: 'var(--gray-light)', display: 'block', marginBottom: 4 }}>Recipient</label>
      <input
        ref={inputRef}
        value={to}
        onChange={e => setTo(e.target.value.trim())}
        placeholder="bc1p... / bc1q... / 3... / 1..."
        style={{ width: '100%', marginBottom: 12, fontFamily: 'monospace', fontSize: 13 }}
      />

      {/* Amount */}
      <label style={{ fontSize: 13, color: 'var(--gray-light)', display: 'block', marginBottom: 4 }}>Amount</label>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          type="number"
          value={amountStr}
          onChange={e => setAmountStr(e.target.value)}
          placeholder="0.00"
          min="0"
          step="any"
          style={{ flex: 1, fontFamily: 'monospace' }}
        />
        <select
          value={unit}
          onChange={e => setUnit(e.target.value as AmountUnit)}
          style={{ width: 90, fontSize: 13 }}
        >
          {(Object.keys(UNIT_LABELS) as AmountUnit[]).map(u => (
            <option key={u} value={u}>{UNIT_LABELS[u]}</option>
          ))}
        </select>
      </div>

      {/* Amount in sats (conversion helper) */}
      {unit !== 'sats' && amountSats > 0 && (
        <div style={{ fontSize: 12, color: 'var(--white-dim)', marginBottom: 12, marginTop: -8 }}>
          = {amountSats.toLocaleString()} sats
        </div>
      )}

      {/* Fee */}
      <label style={{ fontSize: 13, color: 'var(--gray-light)', display: 'block', marginBottom: 4 }}>Fee rate</label>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(Object.keys(FEE_LABELS) as FeeLevel[]).map(level => (
          <button
            key={level}
            className={`btn ${feeLevel === level ? 'btn-primary' : 'btn-secondary'}`}
            style={{ flex: 1, fontSize: 13, padding: '6px 0' }}
            onClick={() => setFeeLevel(level)}
          >
            {FEE_LABELS[level]}
            {feeRates && (
              <span style={{ display: 'block', fontSize: 11, opacity: 0.7 }}>
                {feeRates[level]} sat/vB
              </span>
            )}
          </button>
        ))}
      </div>

      {error && <div className="warning" style={{ marginBottom: 12 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onCancel}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          style={{ flex: 2 }}
          onClick={handlePrepare}
          disabled={preparing || !to || !amountSats || !feeRates}
        >
          {preparing ? <span className="spinner" /> : 'Initiate'}
        </button>
      </div>
    </div>
  );
}
