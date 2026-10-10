import { Router, type Request, type Response, type RequestHandler } from 'express';
import { randomBytes } from 'node:crypto';
import { ConfigStore } from '../lib/config-store.js';
import {
  buildSend, finalizeSend, isValidAddress, vaultPayment,
  InsufficientFundsError, MIN_SEND_SATS, type Prevout,
} from '../lib/bitcoin.js';
import { chainApiUrl, getUtxos, getBalance, broadcastTx, getFeeRates } from '../lib/esplora.js';

interface PreparedTx {
  tx: string;
  prevouts: Prevout[];
  ts: number;
}

const PREPARED_TTL = 30 * 60 * 1000;
const BROADCAST_TTL = 60 * 60 * 1000;

export function btcRoutes(store: ConfigStore, requireUser: RequestHandler, requireRead: RequestHandler): Router {
  const r = Router();

  const prepared = new Map<string, PreparedTx>();
  const broadcasts = new Map<string, { txid?: string; ts: number }>();

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of prepared) if (now - v.ts > PREPARED_TTL) prepared.delete(k);
    for (const [k, v] of broadcasts) if (now - v.ts > BROADCAST_TTL) broadcasts.delete(k);
  }, 60 * 1000).unref();

  /** GET /api/btc/balance — vault balance in sats */
  r.get('/balance', requireRead, async (_req: Request, res: Response) => {
    const config = store.get();
    if (!config.vault) { res.status(400).json({ error: 'No vault' }); return; }
    const { address } = vaultPayment(config.vault, config.network);
    try {
      const balance = await getBalance(chainApiUrl(config), address);
      res.json({ address, ...balance });
    } catch (e) {
      res.status(502).json({ error: `Chain API: ${(e as Error).message}` });
    }
  });

  /** GET /api/btc/fees — fee rate estimates (sat/vB) */
  r.get('/fees', async (_req: Request, res: Response) => {
    if (!store.isLoaded()) { res.status(503).json({ error: 'Instance not ready' }); return; }
    try {
      res.json(await getFeeRates(chainApiUrl(store.get())));
    } catch {
      res.json({ low: 1, normal: 5, high: 10, fallback: true });
    }
  });

  /** POST /api/btc/prepare — build an unsigned send transaction */
  r.post('/prepare', requireUser, async (req: Request, res: Response) => {
    const { to, amount, feeRate } = req.body as { to?: unknown; amount?: unknown; feeRate?: unknown };
    const config = store.get();
    if (!config.vault) { res.status(400).json({ error: 'No vault' }); return; }
    if (typeof to !== 'string' || !isValidAddress(to.trim(), config.network)) {
      res.status(400).json({ error: `Invalid ${config.network} destination address` });
      return;
    }
    if (amount !== 'max' && (typeof amount !== 'number' || !Number.isSafeInteger(amount) || BigInt(amount) < MIN_SEND_SATS)) {
      res.status(400).json({ error: `Amount must be an integer of at least ${MIN_SEND_SATS} sats, or "max"` });
      return;
    }
    if (typeof feeRate !== 'number' || !(feeRate > 0) || feeRate > 10_000) {
      res.status(400).json({ error: 'Fee rate must be between 0 and 10000 sat/vB' });
      return;
    }

    const { address } = vaultPayment(config.vault, config.network);
    let utxos;
    try {
      utxos = (await getUtxos(chainApiUrl(config), address)).filter(u => u.confirmed);
    } catch (e) {
      res.status(502).json({ error: `Chain API: ${(e as Error).message}` });
      return;
    }

    try {
      const send = buildSend({
        utxos,
        vault: config.vault,
        network: config.network,
        to: to.trim(),
        amount: amount === 'max' ? 'max' : BigInt(amount as number),
        feeRate,
      });
      const challengeToken = randomBytes(16).toString('hex');
      prepared.set(challengeToken, { tx: send.tx, prevouts: send.prevouts, ts: Date.now() });
      res.json({
        challengeToken,
        proposal: { network: config.network, tx: send.tx, prevouts: send.prevouts },
        amount: Number(send.amount),
        fee: Number(send.fee),
        change: Number(send.change),
        vsize: send.vsize,
      });
    } catch (e) {
      if (e instanceof InsufficientFundsError) {
        res.status(400).json({ error: 'Insufficient confirmed funds', available: Number(e.available), needed: Number(e.needed) });
        return;
      }
      res.status(400).json({ error: (e as Error).message });
    }
  });

  /** POST /api/btc/broadcast — verify signatures, finalize and broadcast */
  r.post('/broadcast', requireUser, async (req: Request, res: Response) => {
    const { challengeToken, signatures } = req.body as {
      challengeToken?: string;
      signatures?: Array<{ index: number; signature: string }>;
    };
    if (!challengeToken) { res.status(400).json({ error: 'Missing challengeToken' }); return; }

    const existing = broadcasts.get(challengeToken);
    if (existing) {
      if (existing.txid) res.json({ txid: existing.txid, alreadyBroadcast: true });
      else res.status(409).json({ error: 'Broadcast already in progress' });
      return;
    }
    broadcasts.set(challengeToken, { ts: Date.now() });

    const entry = prepared.get(challengeToken);
    const config = store.get();
    if (!entry || !config.vault) {
      broadcasts.delete(challengeToken);
      res.status(400).json({ error: 'Prepared transaction expired or not found — prepare it again' });
      return;
    }

    let signed;
    try {
      if (!Array.isArray(signatures)) throw new Error('signatures must be an array');
      signed = finalizeSend(entry.tx, entry.prevouts, signatures, vaultPayment(config.vault, config.network).outputKey);
    } catch (e) {
      broadcasts.delete(challengeToken);
      res.status(400).json({ error: (e as Error).message });
      return;
    }

    try {
      const txid = await broadcastTx(chainApiUrl(config), signed.hex);
      prepared.delete(challengeToken);
      broadcasts.set(challengeToken, { txid, ts: Date.now() });
      console.log(`[btc/broadcast] ${txid}`);
      res.json({ txid });
    } catch (e) {
      broadcasts.delete(challengeToken);
      res.status(502).json({ error: `Broadcast rejected: ${(e as Error).message}` });
    }
  });

  return r;
}
