/** React hook around RelayClient: create or join a session, track readiness and fingerprint. */

import { useState, useRef, useCallback, useEffect } from 'react';
import { RelayClient } from './relay';
import { sessionFingerprint } from './relay-crypto';
import { RELAY_URL } from './api';
import type { HostingConfig } from './vault-types';

export interface RelayState {
  client: RelayClient | null;
  code: string;
  ready: boolean;
  fingerprint: string;
  joined: number;
  total: number;
  error: string;
}

const initial: RelayState = { client: null, code: '', ready: false, fingerprint: '', joined: 0, total: 0, error: '' };

export function useRelay() {
  const [state, setState] = useState<RelayState>(initial);
  const clientRef = useRef<RelayClient | null>(null);

  const close = useCallback(() => {
    clientRef.current?.close();
    clientRef.current = null;
    setState(initial);
  }, []);

  useEffect(() => () => { clientRef.current?.close(); }, []);

  const attach = (client: RelayClient) => {
    clientRef.current = client;
    client.on('joined', (_pid, count, total) => setState(s => ({ ...s, joined: count, total })));
    client.on('ready', pubkeys => {
      void sessionFingerprint(pubkeys).then(fp => setState(s => ({ ...s, ready: true, fingerprint: fp })));
    });
    client.on('error', msg => setState(s => ({ ...s, error: msg })));
  };

  const create = useCallback(async (parties: number, threshold: number) => {
    clientRef.current?.close();
    const client = new RelayClient(RELAY_URL);
    attach(client);
    try {
      const { session } = await client.create(parties, threshold);
      setState({ ...initial, client, code: session, joined: 1, total: parties });
    } catch (e) {
      client.close();
      clientRef.current = null;
      setState({ ...initial, error: (e as Error).message || 'Could not create session' });
    }
  }, []);

  const join = useCallback(async (code: string) => {
    clientRef.current?.close();
    const client = new RelayClient(RELAY_URL);
    attach(client);
    try {
      await client.join(code.trim().toUpperCase());
      setState(s => ({ ...s, client, code: client.sessionCode }));
    } catch (e) {
      client.close();
      clientRef.current = null;
      setState({ ...initial, error: (e as Error).message || 'Could not join session' });
    }
  }, []);

  return { relay: state, create, join, close };
}

/** Shareable link for a session code, derived from the hosting config or the current page. */
export function sessionLink(code: string, hosting?: HostingConfig | null): string {
  if (hosting?.domain) {
    const scheme = hosting.httpsEnabled ? 'https' : 'http';
    const port = hosting.port && hosting.port !== 443 && hosting.port !== 80 ? `:${hosting.port}` : '';
    return `${scheme}://${hosting.domain}${port}${hosting.path || '/'}?session=${code}`;
  }
  return `${window.location.origin}${window.location.pathname}?session=${code}`;
}
