import { useState } from 'react';
import type { RelayState } from '../lib/use-relay';

interface Props {
  relay: RelayState;
  /** Shareable link (creator only). */
  link?: string;
  waitingFor: string;
}

/** Session code / link while parties gather, then the fingerprint once everyone is connected. */
export function SessionPanel({ relay, link, waitingFor }: Props) {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  return (
    <div className="card">
      {relay.code && !relay.ready && (
        <>
          <div style={{ fontSize: 12, color: 'var(--white-dim)' }}>Session code</div>
          <div
            style={{ fontFamily: 'monospace', fontSize: 22, fontWeight: 700, letterSpacing: '0.15em', cursor: 'pointer' }}
            onClick={() => copy(link || relay.code)}
            title="Click to copy"
          >
            {relay.code}
          </div>
          {link && (
            <div
              style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all', color: 'var(--accent)', cursor: 'pointer', margin: '8px 0' }}
              onClick={() => copy(link)}
              title="Click to copy link"
            >
              {link}
            </div>
          )}
          {copied && <div style={{ fontSize: 12, color: 'var(--green)' }}>Copied</div>}
          <div style={{ textAlign: 'center', padding: 12 }}>
            <div className="spinner" style={{ margin: '0 auto 8px' }} />
            <p style={{ fontSize: 14 }}>
              {waitingFor}{relay.total ? ` (${relay.joined}/${relay.total} connected)` : ''}
            </p>
          </div>
        </>
      )}
      {relay.ready && (
        <>
          <div style={{ fontSize: 12, color: 'var(--white-dim)' }}>Session fingerprint — compare with every party</div>
          <div style={{ fontFamily: 'monospace', fontSize: 16, fontWeight: 600 }}>{relay.fingerprint}</div>
        </>
      )}
      {relay.error && <div className="warning" style={{ marginTop: 12 }}>{relay.error}</div>}
    </div>
  );
}
