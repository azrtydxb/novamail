/* NovaMail app shell — ported from the prototype. Preferences persist to
   localStorage (the design-review tweaks panel does not ship; the same prefs
   live in Settings). Live data comes from the Admin API via window.Store. */
const { useState: useAppState, useEffect: useAppEffect } = React;

const PREF_DEFAULTS = {
  theme: 'dark', accent: 'violet', fontPair: 'jetbrains-inter', density: 'cozy',
  dashboardLayout: 'overview', traceStyle: 'timeline',
};

const FONT_PAIRS = {
  'jetbrains-inter': { mono: "'JetBrains Mono', ui-monospace, monospace", sans: "'Inter', ui-sans-serif, system-ui, sans-serif", display: "'JetBrains Mono', ui-monospace, monospace" },
  'ibm-inter':       { mono: "'IBM Plex Mono', ui-monospace, monospace", sans: "'Inter', ui-sans-serif, system-ui, sans-serif", display: "'IBM Plex Mono', ui-monospace, monospace" },
  'mono-only':       { mono: "'JetBrains Mono', ui-monospace, monospace", sans: "'JetBrains Mono', ui-monospace, monospace", display: "'JetBrains Mono', ui-monospace, monospace" },
};

const ROUTE_TITLE = {
  dashboard: 'dashboard', messages: 'messages', queue: 'queue', providers: 'providers',
  rules: 'routing-rules', domains: 'relay-domains', accounts: 'accounts', settings: 'settings',
  ratelimits_in: 'inbound-limits', ratelimits_out: 'outbound-limits', relayclients: 'relay-clients',
  dkim: 'dkim-keys', suppressions: 'suppressions', audit: 'audit-log', operators: 'operators',
};

function usePrefs() {
  const [t, setT] = useAppState(() => {
    try { return { ...PREF_DEFAULTS, ...JSON.parse(localStorage.getItem('nm:prefs') || '{}') }; }
    catch { return PREF_DEFAULTS; }
  });
  const setTweak = (patch) => setT((s) => {
    const n = { ...s, ...patch };
    try { localStorage.setItem('nm:prefs', JSON.stringify(n)); } catch { /* */ }
    return n;
  });
  return [t, setTweak];
}

/* Live telemetry from real data (queues + metrics), refreshed on every data bump. */
function useLiveTelemetry() {
  const [, force] = useAppState(0);
  useAppEffect(() => {
    const h = () => force((v) => v + 1);
    window.addEventListener('nm:data', h);
    return () => window.removeEventListener('nm:data', h);
  }, []);
  const m = window.NM_DATA.METRICS, q = window.NM_DATA.QUEUES || [];
  const inRate = q.reduce((a, x) => a + (x.in || 0), 0);
  const outRate = q.reduce((a, x) => a + (x.out || 0), 0);
  return { queueDepth: m.queueDepth || 0, inRate, outRate };
}

function TopBar({ route, onToggleSidebar, onToggleTheme, theme, onOpenPalette }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 44, padding: '0 14px', borderBottom: '1px solid var(--line)', background: 'var(--bg)', flexShrink: 0 }}>
      <IconBtn title="Toggle sidebar (⌘B)" onClick={onToggleSidebar}><I.PanelLeft size={15} /></IconBtn>
      <div className="mono" style={{ fontSize: 12, color: 'var(--fg-2)', display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ color: 'var(--fg-3)' }}>relay-kw</span>
        <span style={{ color: 'var(--fg-4)' }}>/</span>
        <span style={{ color: 'var(--fg-1)' }}>{ROUTE_TITLE[route]}</span>
      </div>
      <div style={{ flex: 1 }} />
      <IconBtn title="Toggle theme" onClick={onToggleTheme}>{theme === 'dark' ? <I.Sun size={15} /> : <I.Moon size={15} />}</IconBtn>
      <button onClick={onOpenPalette} className="mono" style={{
        display: 'flex', alignItems: 'center', gap: 8, height: 30, padding: '0 9px 0 11px', borderRadius: 7,
        background: 'var(--bg-1)', border: '1px solid var(--line)', color: 'var(--fg-3)', fontSize: 12,
      }}
        onMouseEnter={(e) => e.currentTarget.style.borderColor = 'var(--line-strong)'}
        onMouseLeave={(e) => e.currentTarget.style.borderColor = 'var(--line)'}
      ><I.Command size={13} />command<span className="kbd">⌘K</span></button>
    </div>
  );
}

function App() {
  const [t, setTweak] = usePrefs();
  const [authed, setAuthed] = useAppState(() => !!(window.Store && window.Store.hasToken && window.Store.hasToken()));
  const [route, setRoute] = useAppState('dashboard');
  const [sidebarOpen, setSidebarOpen] = useAppState(true);
  const [paletteOpen, setPaletteOpen] = useAppState(false);
  const [msgId, setMsgId] = useAppState(null);
  const live = useLiveTelemetry();

  useAppEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = t.theme;
    root.dataset.accent = t.accent;
    root.dataset.density = t.density;
    const fp = FONT_PAIRS[t.fontPair] || FONT_PAIRS['jetbrains-inter'];
    root.style.setProperty('--font-mono', fp.mono);
    root.style.setProperty('--font-sans', fp.sans);
    root.style.setProperty('--font-display', fp.display);
  }, [t.theme, t.accent, t.density, t.fontPair]);

  // Load live data once authed, then poll telemetry (queues/metrics/messages).
  useAppEffect(() => {
    if (!authed) return;
    window.Store.loadAll();
    const light = setInterval(() => window.Store.refreshLight(), 5000);
    const full = setInterval(() => window.Store.loadAll(), 60000);
    return () => { clearInterval(light); clearInterval(full); };
  }, [authed]);

  useAppEffect(() => {
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(true); }
      if (meta && e.key.toLowerCase() === 'b') { e.preventDefault(); setSidebarOpen((s) => !s); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const navigate = (r) => { setRoute(r); };
  const openMessage = (id) => { setMsgId(id || null); setRoute('messages'); };

  if (!authed) return <Login onSignIn={() => setAuthed(true)} />;

  let main;
  if (route === 'dashboard') main = <Dashboard live={live} layout={t.dashboardLayout} onNavigate={navigate} onOpenMessage={openMessage} />;
  else if (route === 'messages') main = <Messages traceStyle={t.traceStyle} initialId={msgId} />;
  else if (route === 'queue') main = <QueueMonitor live={live} />;
  else if (route === 'providers') main = <Providers />;
  else if (route === 'rules') main = <RoutingRules />;
  else if (route === 'domains') main = <RelayDomains />;
  else if (route === 'ratelimits_in') main = <RateLimitsIn />;
  else if (route === 'ratelimits_out') main = <RateLimitsOut />;
  else if (route === 'accounts') main = <Accounts />;
  else if (route === 'relayclients') main = <RelayClients />;
  else if (route === 'dkim') main = <DKIMKeys />;
  else if (route === 'suppressions') main = <Suppressions />;
  else if (route === 'audit') main = <AuditLog />;
  else if (route === 'operators') main = <Operators />;
  else if (route === 'settings') main = <Settings t={t} setTweak={setTweak} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg)' }}>
      <TopBar route={route} theme={t.theme} onToggleSidebar={() => setSidebarOpen((s) => !s)} onToggleTheme={() => setTweak({ theme: t.theme === 'dark' ? 'light' : 'dark' })} onOpenPalette={() => setPaletteOpen(true)} />
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: sidebarOpen ? '248px 1fr' : '1fr', minHeight: 0 }}>
        {sidebarOpen && <Sidebar route={route} onNavigate={navigate} onCollapse={() => setSidebarOpen(false)} onOpenPalette={() => setPaletteOpen(true)} queueDepth={live.queueDepth} />}
        {main}
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={navigate} onOpenMessage={openMessage} />
      <ModalHost />
      <ToastHost />
    </div>
  );
}

window.App = App;
