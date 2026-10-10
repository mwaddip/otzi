import { Router, type Request, type Response, type RequestHandler } from 'express';
import { toPublic, type UserStore, type Role } from '../lib/users.js';
import { isValidSignInAddress } from '../lib/btc-message.js';

const isRole = (r: unknown): r is Role => r === 'admin' || r === 'user';

export function userRoutes(userStore: UserStore, requireAdmin: RequestHandler): Router {
  const r = Router();

  r.get('/', requireAdmin, (_req: Request, res: Response) => {
    res.json({ users: userStore.listUsers().map(toPublic) });
  });

  /** Add a user identified by a Bitcoin address */
  r.post('/', requireAdmin, (req: Request, res: Response) => {
    const { label, role, address } = req.body as { label?: string; role?: unknown; address?: string };
    const cleanLabel = (label || '').trim().slice(0, 64);
    const addr = (address || '').trim();
    if (!cleanLabel || !isRole(role)) { res.status(400).json({ error: 'label and role ("admin" or "user") required' }); return; }
    if (!isValidSignInAddress(addr)) { res.status(400).json({ error: 'Invalid Bitcoin address' }); return; }
    try {
      const user = userStore.addUser(cleanLabel, role, { type: 'bitcoin', address: addr });
      res.json({ ok: true, user: toPublic(user) });
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
    }
  });

  r.patch('/:id', requireAdmin, (req: Request, res: Response) => {
    const { role } = req.body as { role?: unknown };
    if (!isRole(role)) { res.status(400).json({ error: 'role must be "admin" or "user"' }); return; }
    try {
      userStore.updateRole(req.params.id!, role);
      res.json({ ok: true });
    } catch (e) {
      const msg = (e as Error).message;
      res.status(msg === 'User not found' ? 404 : 409).json({ error: msg });
    }
  });

  r.delete('/:id', requireAdmin, (req: Request, res: Response) => {
    try {
      userStore.removeUser(req.params.id!);
      res.json({ ok: true });
    } catch (e) {
      const msg = (e as Error).message;
      res.status(msg === 'User not found' ? 404 : 409).json({ error: msg });
    }
  });

  return r;
}

export function inviteRoutes(userStore: UserStore, requireAdmin: RequestHandler): Router {
  const r = Router();

  r.get('/', requireAdmin, (_req: Request, res: Response) => {
    res.json({ invites: userStore.listInvites() });
  });

  r.post('/', requireAdmin, (req: Request, res: Response) => {
    const { role, maxUses, expiresAt } = req.body as { role?: unknown; maxUses?: unknown; expiresAt?: unknown };
    if (typeof maxUses !== 'number' || !Number.isInteger(maxUses) || maxUses < 1) {
      res.status(400).json({ error: 'maxUses must be a positive integer' });
      return;
    }
    if (typeof expiresAt !== 'number' || expiresAt <= Date.now()) {
      res.status(400).json({ error: 'expiresAt must be a future timestamp' });
      return;
    }
    const invite = userStore.createInvite(isRole(role) ? role : 'user', maxUses, expiresAt);
    res.json({ ok: true, invite });
  });

  r.delete('/:code', requireAdmin, (req: Request, res: Response) => {
    userStore.removeInvite(req.params.code!);
    res.json({ ok: true });
  });

  r.get('/settings/visibility', requireAdmin, (_req: Request, res: Response) => {
    res.json({ everybodyCanRead: userStore.getEverybodyCanRead() });
  });

  r.post('/settings/visibility', requireAdmin, (req: Request, res: Response) => {
    const { everybodyCanRead } = req.body as { everybodyCanRead?: unknown };
    if (typeof everybodyCanRead !== 'boolean') {
      res.status(400).json({ error: 'everybodyCanRead must be a boolean' });
      return;
    }
    userStore.setEverybodyCanRead(everybodyCanRead);
    res.json({ ok: true });
  });

  return r;
}
