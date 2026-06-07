/* global React, I */
/* NovaMail sidebar — brand, search, nav sections, cluster-status footer */

function Sidebar({ route, onNavigate, onCollapse, onOpenPalette, queueDepth }) {
  const { SERVER, PROVIDERS, RELAY_DOMAINS, ACCOUNTS, RELAY_CLIENTS, SUPPRESSIONS } = window.NM_DATA;

  const NAV = [
    { group: null, items: [
      { id: 'dashboard', label: 'Dashboard', icon: <I.Activity size={15} /> },
    ]},
    { group: 'incoming', items: [
      { id: 'relayclients', label: 'Relay clients', icon: <I.Globe size={15} />, hint: (RELAY_CLIENTS || []).length || undefined },
      { id: 'accounts', label: 'Accounts', icon: <I.Key size={15} />, hint: ACCOUNTS.filter(a => a.enabled).length },
      { id: 'ratelimits_in', label: 'Inbound limits', icon: <I.Gauge size={15} /> },
    ]},
    { group: 'routing', items: [
      { id: 'domains', label: 'Relay domains', icon: <I.Globe size={15} />, hint: RELAY_DOMAINS.length },
      { id: 'rules', label: 'Routing rules', icon: <I.Route size={15} /> },
    ]},
    { group: 'outgoing', items: [
      { id: 'providers', label: 'Providers', icon: <I.Server size={15} />, hint: PROVIDERS.filter(p => p.enabled).length },
      { id: 'dkim', label: 'DKIM keys', icon: <I.Shield size={15} /> },
      { id: 'deliverability', label: 'Deliverability', icon: <I.Activity size={15} /> },
      { id: 'ratelimits_out', label: 'Outbound limits', icon: <I.Gauge size={15} /> },
    ]},
    { group: 'observe', items: [
      { id: 'messages', label: 'Messages', icon: <I.Mail size={15} />, hint: 'trace' },
      { id: 'queue', label: 'Queue', icon: <I.Layers size={15} />, hint: queueDepth },
      { id: 'suppressions', label: 'Suppressions', icon: <I.Ban size={15} />, hint: (SUPPRESSIONS || []).length || undefined },
      { id: 'audit', label: 'Audit log', icon: <I.List size={15} /> },
      { id: 'operators', label: 'Operators', icon: <I.Users size={15} /> },
      { id: 'settings', label: 'Settings', icon: <I.Settings size={15} /> },
    ]},
  ];

  const Row = ({ item }) => {
    const active = route === item.id;
    return (
      <button onClick={() => onNavigate(item.id)} style={{
        display: 'flex', alignItems: 'center', gap: 9, width: '100%',
        height: 'var(--row)', minHeight: 28, paddingLeft: 9, paddingRight: 9, borderRadius: 6,
        position: 'relative', textAlign: 'left', fontSize: 'var(--fs-base)',
        color: active ? 'var(--fg)' : 'var(--fg-1)',
        background: active ? 'var(--accent-soft)' : 'transparent',
        transition: 'background 120ms, color 120ms',
      }}
        onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--bg-hover)'; }}
        onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
      >
        {active && <span style={{ position: 'absolute', left: 0, top: 5, bottom: 5, width: 2, background: 'var(--accent)', borderRadius: 2 }} />}
        <span style={{ color: active ? 'var(--accent)' : 'var(--fg-3)', display: 'flex' }}>{item.icon}</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
        {item.hint != null && <span className="mono" style={{ color: 'var(--fg-4)', fontSize: 11 }}>{item.hint}</span>}
      </button>
    );
  };

  const healthy = SERVER.nodes.filter(n => n.state === 'healthy').length;

  return (
    <aside style={{
      display: 'flex', flexDirection: 'column', width: '100%', height: '100%',
      background: 'var(--bg-1)', borderRight: '1px solid var(--line)', fontSize: 'var(--fs-base)',
    }}>
      {/* brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 10px 8px', height: 48 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, padding: '2px 6px' }}>
          <I.Logo size={22} />
          <span className="mono" style={{ fontWeight: 600, color: 'var(--fg)', letterSpacing: 0.3, fontSize: 14 }}>
            nova<span style={{ color: 'var(--accent)' }}>mail</span>
          </span>
          <span className="mono" style={{ color: 'var(--fg-4)', fontSize: 10 }}>{SERVER.version}</span>
        </div>
        <IconBtn title="Collapse sidebar (⌘B)" onClick={onCollapse} size={26}><I.PanelLeft size={14} /></IconBtn>
      </div>

      {/* search → palette */}
      <div style={{ padding: '0 10px 8px' }}>
        <button onClick={onOpenPalette} style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', height: 32,
          padding: '0 9px', borderRadius: 7, background: 'var(--bg-input)',
          border: '1px solid var(--line)', color: 'var(--fg-3)',
        }}
          onMouseEnter={(e) => e.currentTarget.style.borderColor = 'var(--line-strong)'}
          onMouseLeave={(e) => e.currentTarget.style.borderColor = 'var(--line)'}
        >
          <I.Search size={13} />
          <span className="mono" style={{ flex: 1, textAlign: 'left', fontSize: 12 }}>search…</span>
          <span className="kbd">⌘K</span>
        </button>
      </div>

      {/* nav */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '2px 8px 8px' }}>
        {NAV.map((sec, i) => (
          <div key={i} style={{ marginBottom: 6 }}>
            {sec.group && (
              <div className="mono" style={{
                padding: '8px 7px 4px', fontSize: 10, letterSpacing: '0.12em',
                textTransform: 'uppercase', color: 'var(--fg-4)', fontWeight: 500,
              }}>{sec.group}</div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {sec.items.map(it => <Row key={it.id} item={it} />)}
            </div>
          </div>
        ))}
      </div>

      {/* cluster status footer — 28px rail */}
      <div style={{
        borderTop: '1px solid var(--line)', height: 28, padding: '0 11px',
        display: 'flex', alignItems: 'center', gap: 8, fontSize: 11,
        fontFamily: 'var(--font-mono)', color: 'var(--fg-2)', background: 'var(--bg-1)', flexShrink: 0,
      }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 6px', borderRadius: 3, background: 'oklch(0.78 0.16 155 / 0.15)', color: 'var(--accent-good)' }}>
          <span className="pulse" style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--accent-good)' }} />
          {healthy}/{SERVER.nodes.length} nodes
        </span>
        <span style={{ color: 'var(--fg-3)' }}>nova-bus</span>
        <div style={{ flex: 1 }} />
        <span title="quorum queues" style={{ color: 'var(--fg-3)' }}>4.x</span>
      </div>
    </aside>
  );
}

window.Sidebar = Sidebar;
