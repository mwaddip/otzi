import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './lib/config-store.js';
import { UserStore } from './lib/users.js';
import { createAuthMiddleware } from './lib/auth.js';
import { configRoutes } from './routes/config.js';
import { hostingRoutes } from './routes/hosting.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes, inviteRoutes } from './routes/users.js';
import { btcRoutes } from './routes/btc.js';
import { addressBookRoutes } from './routes/address-book.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8080', 10);
const RELAY_PORT = parseInt(process.env.RELAY_PORT || '8081', 10);

const store = new ConfigStore();
const userStore = new UserStore();
const app = express();

app.use(express.json({ limit: '10mb' }));

// Try to auto-load persistent config on startup
try { store.load(); } catch (e) {
  const msg = (e as Error).message;
  if (msg !== 'Not initialized' && msg !== 'Password required to unlock') {
    console.warn('[startup] Config load failed:', msg);
  }
}

// Auth middleware
const { requireAdmin, requireUser, requireRead } = createAuthMiddleware(store, userStore);

// API routes
app.use('/api', configRoutes(store, userStore, requireAdmin, requireRead));
app.use('/api/auth', authRoutes(store, userStore));
app.use('/api/users', userRoutes(userStore, requireAdmin));
app.use('/api/invites', inviteRoutes(userStore, requireAdmin));
app.use('/api/hosting', hostingRoutes(store, requireAdmin, requireRead));
app.use('/api/btc', btcRoutes(store, requireUser, requireRead));
app.use('/api/address-book', addressBookRoutes(store, requireAdmin, requireRead));

// Relay session count and party limit (proxied from relay /sessions endpoint)
app.get('/api/relay/sessions', async (_req, res) => {
  try {
    const resp = await fetch(`http://127.0.0.1:${RELAY_PORT}/sessions`);
    const data = await resp.json() as { active?: number; maxParties?: number };
    res.json({ active: data.active ?? 0, maxParties: data.maxParties ?? 10 });
  } catch {
    res.json({ active: 0, maxParties: 10 });
  }
});

// Unknown API routes
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Proxy WebSocket to relay
const wsProxy = createProxyMiddleware({
  target: `http://127.0.0.1:${RELAY_PORT}`,
  ws: true,
  changeOrigin: true,
});
app.use('/ws', wsProxy);

// Serve frontend static files
const distDir = join(__dirname, '..', 'dist');
app.use(express.static(distDir));
app.get('*', (_req, res) => {
  res.sendFile(join(distDir, 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`otzi backend listening on :${PORT}`);
});

// Wire WebSocket upgrade to the proxy
server.on('upgrade', wsProxy.upgrade);

// Graceful shutdown
function shutdown() {
  console.log('Shutting down...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000); // force after 5s
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Export for route registration by other modules
export { store };
