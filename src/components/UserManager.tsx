import { useState, useEffect } from 'react';
import { listUsers, addUser, removeUser, updateUserRole, listInvites, createInvite, deleteInvite, getAuthMe } from '../lib/api';
import type { Invite, UserPublic } from '../lib/vault-types';

export function UserManager() {
  const [users, setUsers] = useState<UserPublic[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [myId, setMyId] = useState('');
  const [error, setError] = useState('');

  const [newAddress, setNewAddress] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'user'>('user');
  const [newLabel, setNewLabel] = useState('');

  const [inviteRole, setInviteRole] = useState<'admin' | 'user'>('user');
  const [inviteMaxUses, setInviteMaxUses] = useState(1);
  const [inviteExpiryHours, setInviteExpiryHours] = useState(24);

  useEffect(() => {
    listUsers().then(r => setUsers(r.users)).catch(() => {});
    listInvites().then(r => setInvites(r.invites)).catch(() => {});
    getAuthMe().then(r => { if (r.userId) setMyId(r.userId); }).catch(() => {});
  }, []);

  const act = async (fn: () => Promise<void>) => {
    setError('');
    try { await fn(); } catch (e) { setError((e as Error).message); }
  };

  const handleAddUser = () => act(async () => {
    await addUser(newLabel.trim(), newRole, newAddress.trim());
    setUsers((await listUsers()).users);
    setNewAddress('');
    setNewLabel('');
  });

  const handleRemove = (id: string) => act(async () => {
    await removeUser(id);
    setUsers(prev => prev.filter(u => u.id !== id));
  });

  const handleRoleChange = (id: string, role: 'admin' | 'user') => act(async () => {
    await updateUserRole(id, role);
    setUsers(prev => prev.map(u => (u.id === id ? { ...u, role } : u)));
  });

  const handleCreateInvite = () => act(async () => {
    await createInvite(inviteMaxUses, Date.now() + inviteExpiryHours * 60 * 60 * 1000, inviteRole);
    setInvites((await listInvites()).invites);
  });

  const handleDeleteInvite = (code: string) => act(async () => {
    await deleteInvite(code);
    setInvites(prev => prev.filter(i => i.code !== code));
  });

  return (
    <>
      {error && <div className="warning">{error}</div>}

      <div className="card">
        <h2>Users</h2>
        {users.map(u => (
          <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--gray-dark)' }}>
            <div style={{ minWidth: 0 }}>
              <strong style={{ fontSize: 14 }}>{u.label}</strong>
              <div style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--white-dim)', marginTop: 2, wordBreak: 'break-all' }}>
                {u.credential.type === 'passkey' ? 'Passkey' : u.credential.address}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {u.id === myId ? (
                <span style={{ fontSize: 12, color: 'var(--white-dim)' }}>you · {u.role}</span>
              ) : (
                <>
                  <select value={u.role} onChange={e => void handleRoleChange(u.id, e.target.value as 'admin' | 'user')} style={{ fontSize: 12, padding: '4px 8px' }}>
                    <option value="admin">Admin</option>
                    <option value="user">User</option>
                  </select>
                  <button className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 10px', color: 'var(--red)' }} onClick={() => void handleRemove(u.id)}>Remove</button>
                </>
              )}
            </div>
          </div>
        ))}

        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--gray-dark)' }}>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>Add a Bitcoin wallet user</h3>
          <p style={{ fontSize: 12, color: 'var(--white-dim)' }}>They sign in by signing a message with this address. Passkey users join with an invite code.</p>
          <div className="form-row">
            <label>
              Bitcoin address
              <input value={newAddress} onChange={e => setNewAddress(e.target.value)} placeholder="bc1q… / bc1p… / 1… / 3…" style={{ fontFamily: 'monospace', fontSize: 12 }} />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <div className="form-row" style={{ flex: 1 }}>
              <label>Name<input value={newLabel} maxLength={64} onChange={e => setNewLabel(e.target.value)} /></label>
            </div>
            <div className="form-row" style={{ width: 100 }}>
              <label>
                Role
                <select value={newRole} onChange={e => setNewRole(e.target.value as 'admin' | 'user')}>
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
            </div>
          </div>
          <button className="btn btn-primary" onClick={() => void handleAddUser()} disabled={!newAddress.trim() || !newLabel.trim()}>Add user</button>
        </div>
      </div>

      <div className="card">
        <h2>Invite Codes</h2>
        {invites.length === 0 && <p style={{ color: 'var(--white-dim)', fontSize: 13 }}>No active invites.</p>}
        {invites.map(inv => (
          <div key={inv.code} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--gray-dark)' }}>
            <div>
              <strong style={{ fontFamily: 'monospace', fontSize: 16, letterSpacing: '0.1em' }}>{inv.code}</strong>
              <div style={{ fontSize: 12, color: 'var(--white-dim)', marginTop: 2 }}>
                {inv.role} · {inv.usesLeft} use{inv.usesLeft === 1 ? '' : 's'} left · expires {new Date(inv.expiresAt).toLocaleString()}
              </div>
            </div>
            <button className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 10px', color: 'var(--red)' }} onClick={() => void handleDeleteInvite(inv.code)}>Revoke</button>
          </div>
        ))}

        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--gray-dark)' }}>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>Generate invite</h3>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <div className="form-row" style={{ flex: 1 }}>
              <label>
                Role
                <select value={inviteRole} onChange={e => setInviteRole(e.target.value as 'admin' | 'user')}>
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
            </div>
            <div className="form-row" style={{ flex: 1 }}>
              <label>Max uses<input type="number" min={1} max={100} value={inviteMaxUses} onChange={e => setInviteMaxUses(Number(e.target.value))} /></label>
            </div>
            <div className="form-row" style={{ flex: 1 }}>
              <label>Expires (hours)<input type="number" min={1} max={720} value={inviteExpiryHours} onChange={e => setInviteExpiryHours(Number(e.target.value))} /></label>
            </div>
          </div>
          <button className="btn btn-primary" onClick={() => void handleCreateInvite()}>Generate code</button>
        </div>
      </div>
    </>
  );
}
