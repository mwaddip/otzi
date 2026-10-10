import { useState, useEffect, useRef } from 'react';
import { getFeeRates, prepareSend, type PrepareResponse } from '../lib/api';
import { isValidAddress, formatBtc, parseAmountSats, type AmountUnit } from '../lib/bitcoin';
import { labelFor } from '../lib/address-book';
import type { AddressBookEntry, NetworkName } from '../lib/vault-types';

type FeeLevel = 'low' | 'normal' | 'high' | 'custom';

const UNIT_LABELS: Record<AmountUnit, string> = { btc: 'BTC', mbtc: 'mBTC', ubtc: '\u00B5BTC', sats: 'sats' };
const FEE_LABELS: Record<FeeLevel, string> = { low: 'Low', normal: 'Normal', high: 'High', custom: 'Custom' };

interface Props {
  network: NetworkName;
  /** Confirmed balance in sats. */
  balance: number;
  addressBook: AddressBookEntry[];
  onPrepared: (prepared: PrepareResponse, to: string) => void;
  onCancel: () => void;
}

export function BtcSend({ network, balance, addressBook, onPrepared, onCancel }: Props) {
  const [to, setTo] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [unit, setUnit] = useState<AmountUnit>('btc');
  const [sendMax, setSendMax] = useState(false);
  const [feeLevel, setFeeLevel] = useState<FeeLevel>('normal');
  const [customFee, setCustomFee] = useState('');
  const [feeRates, setFeeRates] = useState<{ low: number; normal: number; high: number; fallback?: boolean } | null>(null);
  const [error, setError] = useState('');
  const [preparing, setPreparing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    getFeeRates().then(setFeeRates).catch(() => setFeeRates({ low: 1, normal: 5, high: 10, fallback: true }));
  }, []);

  const amountSats = sendMax ? balance : parseAmountSats(amountStr, unit);
  const feeRate = feeLevel === 'custom' ? Number(customFee) : feeRates?.[feeLevel] ?? NaN;
  const recipient = to.trim();
  const recipientLabel = recipient ? labelFor(addressBook, recipient) : undefined;
  const recipientValid = !recipient || isValidAddress(recipient, network);

  const handlePrepare = async () => {
    setError('');
    if (!recipient) { setError('Enter a recipient address'); return; }
    if (!isValidAddress(recipient, network)) { setError(`Not a valid ${network} address`); return; }
    if (!sendMax && (!Number.isFinite(amountSats) || amountSats <= 0)) { setError('Enter a valid amount'); return; }
    if (!sendMax && amountSats > balance) { setError('Amount exceeds the confirmed balance'); return; }
    if (!(feeRate > 0)) { setError('Enter a fee rate'); return; }

    setPreparing(true);
    try {
      onPrepared(await prepareSend(recipient, sendMax ? 'max' : amountSats, feeRate), recipient);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPreparing(false);
    }
  };

  return (
    <div className="card">
      <h2>Send</h2>
      <div style={{ fontSize: 13, color: 'var(--white-dim)', marginBottom: 16 }}>
        Available: <strong>{formatBtc(balance)} BTC</strong> (confirmed)
      </div>

      <label style={{ fontSize: 13, color: 'var(--gray-light)', display: 'block', marginBottom: 4 }}>Recipient</label>
      {addressBook.length > 0 && (
        <select
          value={recipientLabel ? recipient : ''}
          onChange={e => setTo(e.target.value)}
          style={{ width: '100%', marginBottom: 8, fontSize: 13 }}
        >
          <option value="">Address book…</option>
          {addressBook.map(e => <option key={e.address} value={e.address}>{e.label} — {e.address.slice(0, 12)}…{e.address.slice(-6)}</option>)}
        </select>
      )}
      <input
        ref={inputRef}
        value={to}
        onChange={e => setTo(e.target.value.trim())}
        placeholder={network === 'mainnet' ? 'bc1p… / bc1q… / 3… / 1…' : 'tb1p… / tb1q… / 2… / m… / n…'}
        style={{ width: '100%', marginBottom: 4, fontFamily: 'monospace', fontSize: 13 }}
      />
      <div style={{ fontSize: 12, minHeight: 18, marginBottom: 8, color: recipientValid ? 'var(--white-dim)' : 'var(--red)' }}>
        {!recipientValid ? `Not a valid ${network} address` : recipientLabel ? `Address book: ${recipientLabel}` : recipient ? 'Not in address book' : ''}
      </div>

      <label style={{ fontSize: 13, color: 'var(--gray-light)', display: 'block', marginBottom: 4 }}>Amount</label>
      <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
        <input
          inputMode="decimal"
          value={sendMax ? 'Everything' : amountStr}
          disabled={sendMax}
          onChange={e => setAmountStr(e.target.value.replace(',', '.'))}
          placeholder="0.00"
          style={{ flex: 1, fontFamily: 'monospace' }}
        />
        <select value={unit} onChange={e => setUnit(e.target.value as AmountUnit)} disabled={sendMax} style={{ width: 90, fontSize: 13 }}>
          {(Object.keys(UNIT_LABELS) as AmountUnit[]).map(u => <option key={u} value={u}>{UNIT_LABELS[u]}</option>)}
        </select>
        <button className={`btn ${sendMax ? 'btn-primary' : 'btn-secondary'}`} style={{ fontSize: 13, padding: '6px 12px' }} onClick={() => setSendMax(m => !m)}>
          Max
        </button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--white-dim)', minHeight: 18, marginBottom: 12 }}>
        {sendMax ? 'All confirmed coins, minus the network fee' : unit !== 'sats' && amountSats > 0 ? `= ${amountSats.toLocaleString()} sats` : ''}
      </div>

      <label style={{ fontSize: 13, color: 'var(--gray-light)', display: 'block', marginBottom: 4 }}>Fee rate</label>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        {(Object.keys(FEE_LABELS) as FeeLevel[]).map(level => (
          <button
            key={level}
            className={`btn ${feeLevel === level ? 'btn-primary' : 'btn-secondary'}`}
            style={{ flex: 1, fontSize: 13, padding: '6px 0' }}
            onClick={() => setFeeLevel(level)}
          >
            {FEE_LABELS[level]}
            {level !== 'custom' && feeRates && <span style={{ display: 'block', fontSize: 11, opacity: 0.7 }}>{feeRates[level]} sat/vB</span>}
          </button>
        ))}
      </div>
      {feeLevel === 'custom' && (
        <input
          inputMode="decimal"
          value={customFee}
          onChange={e => setCustomFee(e.target.value.replace(',', '.'))}
          placeholder="sat/vB"
          style={{ width: '100%', marginBottom: 8, fontFamily: 'monospace' }}
        />
      )}
      {feeRates?.fallback && (
        <div style={{ fontSize: 12, color: 'var(--accent)', marginBottom: 8 }}>Fee estimates unavailable — check the rate or use Custom.</div>
      )}

      {error && <div className="warning" style={{ marginBottom: 12 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" style={{ flex: 2 }} onClick={() => void handlePrepare()} disabled={preparing || !feeRates}>
          {preparing ? <span className="spinner" /> : 'Review'}
        </button>
      </div>
    </div>
  );
}
