/* global React, I */
/* NovaMail Providers — upstream provider cards */
const { useState: useProvState } = React;

function ProviderCard({ p }) {
  const { SERIES } = window.NM_DATA;
  const on = p.enabled;
  const spark = SERIES.relayed.map((v, i) => v * (0.2 + (p.sent24h / 32000)) + i);
  return (
    <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 13, opacity: on ? 1 : 0.62, transition: 'opacity 140ms' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
        <div style={{ width: 34, height: 34, borderRadius: 8, background: 'var(--bg-2)', border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent)', flexShrink: 0 }}>
          <I.Server size={17} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
            <StatusDot status={p.status} pulse={p.status === 'healthy'} />
          </div>
          <div style={{ marginTop: 4 }}><ProviderType type={p.type} /></div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }} onClick={(e) => e.stopPropagation()}>
          <IconBtn size={26} title="Test connection" onClick={async () => {
            window.nmToast(`testing ${p.name}…`, 'info');
            const r = await window.Store.testProvider(p.id);
            window.nmToast(r.ok ? `${p.name}: connection OK` : `${p.name}: ${r.error || 'failed'}`, r.ok ? 'good' : 'danger');
          }}><I.Activity size={13} /></IconBtn>
          <IconBtn size={26} title="Edit" onClick={() => window.nmModal({ coll: 'providers', mode: 'edit', item: p })}><I.Edit size={13} /></IconBtn>
          <IconBtn size={26} title="Delete" onClick={() => window.nmModal({ kind: 'confirm', coll: 'providers', item: p })}><I.Trash size={13} /></IconBtn>
          <Toggle size="sm" on={on} onChange={() => window.Store.toggle('providers', p)} />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: 11.5 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <span className="mono" style={{ color: 'var(--fg-4)', width: 58, flexShrink: 0 }}>endpoint</span>
          <span className="mono" style={{ color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.endpoint}</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="mono" style={{ color: 'var(--fg-4)', width: 58, flexShrink: 0 }}>auth</span>
          <Chip tone="cyan">{p.auth_mode}</Chip>
          {p.secret_ref !== '—' && <span className="mono" style={{ color: 'var(--fg-3)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><I.Lock size={10} />{p.secret_ref}</span>}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10, paddingTop: 11, borderTop: '1px solid var(--line)' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
            <span style={{ fontFamily: 'var(--font-display)', fontSize: 19, fontWeight: 600, color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>{p.sent24h.toLocaleString()}</span>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-4)' }}>sent · 24h</span>
          </div>
          <div className="mono" style={{ fontSize: 10.5, color: 'var(--fg-4)', marginTop: 2 }}>last used {p.lastUsed}</div>
        </div>
        {p.sent24h > 0 && <Sparkline data={spark} w={92} h={28} color={p.status === 'degraded' ? 'var(--accent-warn)' : 'var(--accent)'} />}
      </div>
    </div>
  );
}

function Providers() {
  useDataVersion();
  const { PROVIDERS } = window.NM_DATA;
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <PageHeader icon={<I.Server size={18} />} eyebrow="routing" title="Providers" count={`${PROVIDERS.filter(p => p.enabled).length} active`}
        sub="authenticated upstreams · every message exits via a provider (relay-only)"
        actions={<Btn kind="primary" icon={<I.Plus size={13} />} size="sm" onClick={() => window.nmModal({ coll: 'providers', mode: 'create' })}>new provider</Btn>} />
      <ScreenBody>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
          {PROVIDERS.map(p => <ProviderCard key={p.id} p={p} />)}
        </div>
      </ScreenBody>
    </div>
  );
}

window.Providers = Providers;
