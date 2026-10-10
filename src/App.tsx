import { useState, useEffect, useCallback } from 'react';
import { InstallWizard } from './components/InstallWizard';
import { DKGWizard } from './components/DKGWizard';
import { VaultPage } from './components/VaultPage';
import { Settings } from './components/Settings';
import { SignIn } from './components/SignIn';
import { PortableConfigBanner } from './components/PortableConfigBanner';
import { getStatus, getAuthMe, unlock, isAdminSession, type StatusResponse } from './lib/api';
import { toggleTheme, getTheme } from './lib/theme';
import './styles/global.css';
import './styles/ceremony.css';

type View = 'loading' | 'wizard' | 'unlock' | 'signIn' | 'dkg' | 'vault' | 'settings';
type ReadyStatus = Extract<StatusResponse, { state: 'ready' }>;

/** Inline SVG icon — Ötzi segmented Ö (single character for favicons/small contexts) */
export function OtziLogo({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 256 256"
      fill="var(--logo-color)"
      width={size}
      height={size}
      className={className}
      aria-label="Ötzi"
    >
      <polygon points="96,78 104,72 152,72 160,78 152,84 104,84" />
      <polygon points="90,84 97,91 97,147 90,154 83,147 83,91" />
      <polygon points="166,84 173,91 173,147 166,154 159,147 159,91" />
      <polygon points="96,178 104,172 152,172 160,178 152,184 104,184" />
      <polygon points="96,155 104,163 96,171 88,163" />
      <polygon points="160,155 168,163 160,171 152,163" />
      <g opacity="0.9">
        <rect x="108" y="48" width="16" height="12" />
        <rect x="132" y="48" width="16" height="12" />
      </g>
    </svg>
  );
}

/** Full "Ötzi" wordmark — 16-segment display style, lowercase tzi at half height */
export function OtziWordmark({ height = 40, className }: { height?: number; className?: string }) {
  const w = height * (262 / 152);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 262 152"
      fill="var(--logo-color)"
      width={w}
      height={height}
      className={className}
      aria-label="Ötzi"
    >
      {/* Ö (thinner 14px verticals, hex horizontals) */}
      <g opacity="0.9">
        <rect x="36" y="8" width="16" height="12" />
        <rect x="60" y="8" width="16" height="12" />
      </g>
      <polygon points="24,38 32,32 80,32 88,38 80,44 32,44" />
      <polygon points="18,44 25,51 25,107 18,114 11,107 11,51" />
      <polygon points="94,44 101,51 101,107 94,114 87,107 87,51" />
      <polygon points="24,138 32,132 80,132 88,138 80,144 32,144" />
      <polygon points="24,115 32,123 24,131 16,123" />
      <polygon points="88,115 96,123 88,131 80,123" />
      {/* t: split verticals + left-half crossbar + bottom */}
      <polygon points="120,52 127,59 127,79 120,86 113,79 113,59" />
      <polygon points="120,98 127,105 127,125 120,132 113,125 113,105" />
      <polygon points="127,92 131,86 145,86 149,92 145,98 131,98" />
      <polygon points="127,138 133,132 158,132 164,138 158,144 133,144" />
      {/* z: hex horizontals + 16-seg diagonal */}
      <polygon points="176,92 182,86 214,86 220,92 214,98 182,98" />
      <polygon points="208,98 222,98 188,132 174,132" />
      <polygon points="176,138 182,132 214,132 220,138 214,144 182,144" />
      {/* i: cheated dot + stem */}
      <rect x="240" y="74" width="12" height="10" />
      <polygon points="246,92 253,99 253,137 246,144 239,137 239,99" />
    </svg>
  );
}

export function ThemeToggle({ fixed }: { fixed?: boolean } = {}) {
  const [theme, setThemeState] = useState(getTheme);
  return (
    <button
      className={`theme-toggle${fixed ? ' theme-toggle-fixed' : ''}`}
      onClick={() => setThemeState(toggleTheme())}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
    >
      {theme === 'dark' ? '\u2600' : '\u263E'}
    </button>
  );
}

export function App() {
  const [view, setView] = useState<View>('loading');
  const [status, setStatus] = useState<ReadyStatus | null>(null);
  const [sessionCode, setSessionCode] = useState<string | null>(() => {
    const s = new URLSearchParams(window.location.search).get('session');
    return s && /^[A-Za-z0-9]{6}$/.test(s.trim()) ? s.trim().toUpperCase() : null;
  });

  // The code lives in state; drop it from the URL so a reload does not re-join
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('session')) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);
  const [backupDownloaded, setBackupDownloaded] = useState(false);

  const checkStatus = useCallback(async () => {
    try {
      const s = await getStatus();
      if (s.state === 'fresh') { setView('wizard'); return; }
      if (s.state === 'locked') { setView('unlock'); return; }
      setStatus(s);
      // A session link grants access to that ceremony without signing in
      if (s.authMode === 'accounts' && !sessionCode) {
        const me = await getAuthMe().catch(() => ({ authenticated: false }));
        if (!me.authenticated) { setView('signIn'); return; }
      }
      setView(s.hasVault ? 'vault' : 'dkg');
    } catch (e) {
      console.error('Failed to check status:', e);
      setView('wizard');
    }
  }, [sessionCode]);

  useEffect(() => { void checkStatus(); }, [checkStatus]);

  const joinSession = (code: string) => {
    setSessionCode(code);
  };

  const showBackupBanner = !!status && status.storageMode === 'encrypted-portable' && status.hasVault
    && isAdminSession() && !backupDownloaded && (view === 'vault' || view === 'settings');

  let content: React.ReactNode;
  if (view === 'loading') {
    content = <div className="ceremony"><div className="spinner" /></div>;
  } else if (view === 'wizard') {
    content = <InstallWizard onComplete={() => void checkStatus()} />;
  } else if (view === 'unlock') {
    content = <UnlockScreen onUnlocked={() => void checkStatus()} />;
  } else if (view === 'signIn') {
    content = <SignIn onSignedIn={() => void checkStatus()} onJoinSession={joinSession} />;
  } else if (view === 'dkg' && status) {
    content = <DKGWizard network={status.network} onComplete={() => { setSessionCode(null); void checkStatus(); }} initialSessionCode={sessionCode} />;
  } else if (view === 'settings' && status) {
    content = <Settings network={status.network} authMode={status.authMode} onBack={() => setView('vault')} onStatusChange={() => void checkStatus()} />;
  } else if (status) {
    content = <VaultPage network={status.network} authMode={status.authMode} onSettings={() => setView('settings')} initialSessionCode={sessionCode} />;
  }

  // VaultPage has its own inline ThemeToggle in the header bar
  const showGlobalToggle = view !== 'vault';

  return (
    <>
      {showBackupBanner && <PortableConfigBanner onDownloaded={() => setBackupDownloaded(true)} />}
      {showGlobalToggle && <ThemeToggle fixed />}
      {content}
    </>
  );
}

/** Simple unlock screen for encrypted-persistent mode */
function UnlockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleUnlock = async () => {
    setLoading(true);
    setError('');
    try {
      await unlock(password);
      onUnlocked();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="ceremony">
      <div style={{ textAlign: 'center', marginBottom: 8 }}>
        <OtziWordmark height={48} />
      </div>
      <p className="subtitle" style={{ textAlign: 'center' }}>Enter your password to unlock</p>
      <div className="card">
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Password"
          onKeyDown={e => e.key === 'Enter' && handleUnlock()}
          style={{ width: '100%', marginBottom: 16 }}
        />
        {error && <div className="warning">{error}</div>}
        <button className="btn btn-primary btn-full" onClick={handleUnlock} disabled={loading || !password}>
          {loading ? <span className="spinner" /> : 'Unlock'}
        </button>
      </div>
    </div>
  );
}
