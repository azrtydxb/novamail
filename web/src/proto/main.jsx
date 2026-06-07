/* NovaMail app shell — ported from the prototype. Preferences persist to
   localStorage (the design-review tweaks panel does not ship; the same prefs
   live in Settings). Live data comes from the Admin API via window.Store. */
const { useState: useAppState, useEffect: useAppEffect, useRef: useAppRef } = React;

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
  dkim: 'dkim-keys', deliverability: 'deliverability', suppressions: 'suppressions', audit: 'audit-log', operators: 'operators',
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

function UserMenu({ operator, onLogout }) {
  const [open, setOpen] = useAppState(false);
  const ref = useAppRef(null);
  useAppEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const name = (operator && operator.username) || 'operator';
  const role = (operator && operator.role) || '';
  const initial = name.charAt(0).toUpperCase();
  const Item = ({ icon, label, onClick, danger }) => (
    <button onClick={() => { setOpen(false); onClick(); }} className="mono" style={{
      display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 12px', fontSize: 12.5,
      color: danger ? 'var(--accent-danger)' : 'var(--fg-1)', textAlign: 'left',
    }}
      onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-hover)'}
      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
    >{icon}{label}</button>
  );
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} title={name} style={{
        display: 'flex', alignItems: 'center', gap: 7, height: 30, padding: '0 7px 0 5px', borderRadius: 7,
        background: open ? 'var(--bg-2)' : 'transparent', border: '1px solid', borderColor: open ? 'var(--line-strong)' : 'transparent',
      }}
        onMouseEnter={(e) => { if (!open) e.currentTarget.style.background = 'var(--bg-hover)'; }}
        onMouseLeave={(e) => { if (!open) e.currentTarget.style.background = 'transparent'; }}
      >
        <span className="mono" style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--accent)', color: 'var(--accent-fg)', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{initial}</span>
        <span className="mono" style={{ fontSize: 12, color: 'var(--fg-2)', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <I.ChevronD size={13} style={{ color: 'var(--fg-4)' }} />
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 38, right: 0, width: 210, background: 'var(--bg-1)', border: '1px solid var(--line-strong)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: 5, zIndex: 120, animation: 'fadeUp 130ms ease' }}>
          <div style={{ padding: '8px 12px 10px', borderBottom: '1px solid var(--line)', marginBottom: 5 }}>
            <div style={{ fontSize: 13, color: 'var(--fg)', fontWeight: 500 }}>{name}</div>
            <div className="mono" style={{ fontSize: 10.5, color: 'var(--fg-4)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 2 }}>{role || 'operator'}</div>
          </div>
          <Item icon={<I.Users size={14} />} label="Profile" onClick={() => window.nmModal({ kind: 'profile' })} />
          <Item icon={<I.Lock size={14} />} label="Change password" onClick={() => window.nmModal({ kind: 'password' })} />
          <div style={{ height: 1, background: 'var(--line)', margin: '5px 0' }} />
          <Item icon={<I.ArrowRight size={14} />} label="Log out" onClick={onLogout} danger />
        </div>
      )}
    </div>
  );
}

function TopBar({ route, onToggleSidebar, onToggleTheme, theme, onOpenPalette, operator, onLogout }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', height: 44, padding: '0 14px', borderBottom: '1px solid var(--line)', background: 'var(--bg)', flexShrink: 0 }}>
      {/* left: sidebar toggle + breadcrumb */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <IconBtn title="Toggle sidebar (⌘B)" onClick={onToggleSidebar}><I.PanelLeft size={15} /></IconBtn>
        <div className="mono" style={{ fontSize: 12, color: 'var(--fg-2)', display: 'flex', alignItems: 'center', gap: 7, overflow: 'hidden' }}>
          <span style={{ color: 'var(--fg-3)' }}>relay-kw</span>
          <span style={{ color: 'var(--fg-4)' }}>/</span>
          <span style={{ color: 'var(--fg-1)', whiteSpace: 'nowrap' }}>{ROUTE_TITLE[route]}</span>
        </div>
      </div>
      {/* center: command / search */}
      <button onClick={onOpenPalette} className="mono" style={{
        display: 'flex', alignItems: 'center', gap: 8, height: 30, width: 320, maxWidth: '40vw', padding: '0 10px', borderRadius: 7,
        background: 'var(--bg-1)', border: '1px solid var(--line)', color: 'var(--fg-3)', fontSize: 12,
      }}
        onMouseEnter={(e) => e.currentTarget.style.borderColor = 'var(--line-strong)'}
        onMouseLeave={(e) => e.currentTarget.style.borderColor = 'var(--line)'}
      ><I.Search size={13} /><span style={{ flex: 1, textAlign: 'left' }}>search or run a command…</span><span className="kbd">⌘K</span></button>
      {/* right: theme + user menu */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
        <IconBtn title="Toggle theme" onClick={onToggleTheme}>{theme === 'dark' ? <I.Sun size={15} /> : <I.Moon size={15} />}</IconBtn>
        <UserMenu operator={operator} onLogout={onLogout} />
      </div>
    </div>
  );
}

function App() {
  const [t, setTweak] = usePrefs();
  const [authed, setAuthed] = useAppState(null); // null = checking session, false = login, true = app
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

  // Resolve the session cookie on mount (cookies aren't synchronously readable).
  useAppEffect(() => {
    window.Store.checkSession().then((op) => setAuthed(!!op));
  }, []);

  // Load live data once authed, then poll telemetry (queues/metrics/messages).
  useAppEffect(() => {
    if (authed !== true) return;
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

  if (authed === null) return <div style={{ height: '100vh', background: 'var(--bg)' }} />;
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
  else if (route === 'deliverability') main = <Deliverability />;
  else if (route === 'suppressions') main = <Suppressions />;
  else if (route === 'audit') main = <AuditLog />;
  else if (route === 'operators') main = <Operators />;
  else if (route === 'settings') main = <Settings t={t} setTweak={setTweak} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg)' }}>
      <TopBar route={route} theme={t.theme} operator={window.NM_DATA.OPERATOR} onLogout={() => { window.Store.logout(); setAuthed(false); }} onToggleSidebar={() => setSidebarOpen((s) => !s)} onToggleTheme={() => setTweak({ theme: t.theme === 'dark' ? 'light' : 'dark' })} onOpenPalette={() => setPaletteOpen(true)} />
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
