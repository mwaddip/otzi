import { Router, type Request, type Response, type RequestHandler } from 'express';
import { ConfigStore } from '../lib/config-store.js';
import { getProvider } from '../lib/opnet-client.js';

export function walletRoutes(store: ConfigStore, requireAdmin: RequestHandler): Router {
  const r = Router();

  /** GET /api/wallet/balance — BTC balance in satoshis */
  r.get('/balance', async (req: Request, res: Response) => {
    try {
      const config = store.get();
      if (!config.wallet) {
        res.json({ balance: 0, configured: false });
        return;
      }
      const provider = getProvider(config.network);
      const balanceAddr = config.permafrost?.frostP2tr || config.wallet.p2tr;
      const balance = await provider.getBalance(balanceAddr, true);
      res.json({ balance: balance.toString(), configured: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return r;
}
