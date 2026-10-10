import { useState, useEffect } from 'react';
import { getAddressBook, saveAddressBook } from '../lib/api';
import {
  parseAddressBookFile, mergeAddressBooks, downloadAddressBook, validateEntries, MAX_LABEL, MAX_NOTE,
} from '../lib/address-book';
import type { AddressBookEntry, NetworkName } from '../lib/vault-types';

interface Props {
  network: NetworkName;
  disabled?: boolean;
}

interface PendingImport {
  fileName: string;
  incoming: AddressBookEntry[];
  merged: ReturnType<typeof mergeAddressBooks>;
}

export function AddressBook({ network, disabled }: Props) {
  const [entries, setEntries] = useState<AddressBookEntry[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<AddressBookEntry>({ label: '', address: '', note: '' });
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getAddressBook().then(r => setEntries(r.entries)).catch(e => setError((e as Error).message));
  }, []);

  const save = async (next: AddressBookEntry[], done: string) => {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const res = await saveAddressBook(validateEntries(next, network));
      setEntries(res.entries);
      setMessage(done);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (i: number | 'new') => {
    setEditing(i);
    setDraft(i === 'new' ? { label: '', address: '', note: '' } : { note: '', ...entries[i]! });
    setError('');
    setMessage('');
  };

  const commitEdit = async () => {
    const entry = { label: draft.label, address: draft.address.trim(), ...(draft.note?.trim() ? { note: draft.note } : {}) };
    const next = editing === 'new' ? [...entries, entry] : entries.map((e, i) => (i === editing ? entry : e));
    if (await save(next, editing === 'new' ? 'Entry added.' : 'Entry updated.')) setEditing(null);
  };

  const remove = (i: number) => void save(entries.filter((_, j) => j !== i), 'Entry removed.');

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.otzi.json,application/json';
    input.onchange = async e => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      setError('');
      setMessage('');
      try {
        const incoming = parseAddressBookFile(JSON.parse(await file.text()), network);
        setPending({ fileName: file.name, incoming, merged: mergeAddressBooks(entries, incoming) });
      } catch (err) {
        setError(err instanceof SyntaxError ? 'Not a JSON file' : (err as Error).message);
      }
    };
    input.click();
  };

  const applyImport = async (mode: 'merge' | 'replace') => {
    if (!pending) return;
    const next = mode === 'merge' ? pending.merged.entries : pending.incoming;
    if (await save(next, mode === 'merge' ? 'Address book merged.' : 'Address book replaced.')) setPending(null);
  };

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 8 }}>
        <h2 style={{ marginBottom: 0 }}>Address Book</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" style={{ fontSize: 13, padding: '6px 12px' }} disabled={entries.length === 0} onClick={() => downloadAddressBook(entries, network)}>Export</button>
          <button className="btn btn-secondary" style={{ fontSize: 13, padding: '6px 12px' }} disabled={disabled} onClick={handleImport}>Import</button>
        </div>
      </div>

      {entries.length === 0 && editing === null && (
        <p style={{ fontSize: 13, color: 'var(--white-dim)' }}>No addresses yet. Named addresses appear in the send form and on co-signers' approval screens.</p>
      )}

      {entries.map((e, i) => (
        editing === i ? null : (
          <div key={e.address} style={{ padding: '8px 0', borderBottom: '1px solid var(--border-dim)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{e.label}</div>
              <div style={{ fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all', color: 'var(--white-dim)' }}>{e.address}</div>
              {e.note && <div style={{ fontSize: 12, color: 'var(--gray-light)' }}>{e.note}</div>}
            </div>
            {!disabled && (
              <div style={{ display: 'flex', gap: 4 }}>
                <button className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 8px' }} onClick={() => startEdit(i)}>Edit</button>
                <button className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 8px', color: 'var(--red)' }} disabled={saving} onClick={() => remove(i)}>✕</button>
              </div>
            )}
          </div>
        )
      ))}

      {editing !== null && (
        <div style={{ padding: 12, marginTop: 8, border: '1px solid var(--border-dim)', background: 'var(--bg)' }}>
          <div className="form-row"><label>Label<input value={draft.label} maxLength={MAX_LABEL} onChange={e => setDraft({ ...draft, label: e.target.value })} /></label></div>
          <div className="form-row"><label>Address<input value={draft.address} onChange={e => setDraft({ ...draft, address: e.target.value })} style={{ fontFamily: 'monospace', fontSize: 12 }} /></label></div>
          <div className="form-row"><label>Note (optional)<input value={draft.note ?? ''} maxLength={MAX_NOTE} onChange={e => setDraft({ ...draft, note: e.target.value })} /></label></div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn btn-primary" style={{ flex: 1 }} disabled={saving || !draft.label.trim() || !draft.address.trim()} onClick={() => void commitEdit()}>Save</button>
          </div>
        </div>
      )}

      {pending && (
        <div style={{ padding: 12, marginTop: 8, border: '1px solid var(--accent)', background: 'var(--accent-tint)' }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Import {pending.fileName}</div>
          <div style={{ fontSize: 13, marginBottom: 12 }}>
            {pending.incoming.length} entr{pending.incoming.length === 1 ? 'y' : 'ies'} in the file.
            <div><strong>Merge:</strong> {pending.merged.added} new, {pending.merged.updated} relabelled, {pending.merged.unchanged} unchanged; {entries.length - pending.merged.updated - pending.merged.unchanged} existing kept.</div>
            <div><strong>Replace:</strong> the book becomes the file's {pending.incoming.length} entr{pending.incoming.length === 1 ? 'y' : 'ies'} ({entries.length} current removed).</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary" onClick={() => setPending(null)}>Cancel</button>
            <button className="btn btn-secondary" style={{ flex: 1 }} disabled={saving} onClick={() => void applyImport('replace')}>Replace</button>
            <button className="btn btn-primary" style={{ flex: 1 }} disabled={saving} onClick={() => void applyImport('merge')}>Merge</button>
          </div>
        </div>
      )}

      {error && <div className="warning" style={{ marginTop: 8 }}>{error}</div>}
      {message && <div style={{ fontSize: 13, color: 'var(--accent)', marginTop: 8 }}>{message}</div>}

      {editing === null && !pending && !disabled && (
        <button className="btn btn-primary btn-full" style={{ marginTop: 12 }} onClick={() => startEdit('new')}>Add address</button>
      )}
    </div>
  );
}
