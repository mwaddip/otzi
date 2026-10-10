import { Router, type Request, type Response, type RequestHandler } from 'express';
import { ConfigStore } from '../lib/config-store.js';
import { validateAddressBook } from '../lib/address-book.js';

export function addressBookRoutes(store: ConfigStore, requireAdmin: RequestHandler, requireRead: RequestHandler): Router {
  const r = Router();

  /** GET /api/address-book */
  r.get('/', requireRead, (_req: Request, res: Response) => {
    res.json({ entries: store.get().addressBook });
  });

  /** PUT /api/address-book — replace the whole book */
  r.put('/', requireAdmin, (req: Request, res: Response) => {
    let entries;
    try {
      entries = validateAddressBook((req.body as { entries?: unknown }).entries, store.get().network);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
      return;
    }
    store.update({ addressBook: entries });
    res.json({ ok: true, entries });
  });

  return r;
}
