/* global React, I */
/* NovaMail config screens — reusable DataTable + Routing / Domains / Rate limits / Accounts */
const { useState: useTblState } = React;

function DataTable({ columns, rows, rowKey, onRowClick }) {
  return (
    <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 680 }}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className="mono" style={{
                  textAlign: c.align || 'left', padding: '10px 14px', fontSize: 10.5,
                  letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--fg-4)',
                  fontWeight: 500, borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap',
                  width: c.width,
                }}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined} style={{
                borderBottom: ri < rows.length - 1 ? '1px solid var(--line)' : 0,
                cursor: onRowClick ? 'pointer' : 'default', transition: 'background 120ms',
              }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
              >
                {columns.map((c) => (
                  <td key={c.key} style={{
                    padding: '11px 14px', fontSize: 12.5, color: 'var(--fg-1)',
                    textAlign: c.align || 'left', verticalAlign: 'middle',
                    fontFamily: c.mono ? 'var(--font-mono)' : 'inherit', whiteSpace: c.nowrap ? 'nowrap' : 'normal',
                  }}>{c.render ? c.render(r) : r[c.key]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RowActions({ onEdit, onDelete }) {
  return (
    <div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
      {onEdit && <IconBtn title="Edit" onClick={onEdit} size={26}><I.Edit size={13} /></IconBtn>}
      {onDelete && <IconBtn title="Delete" onClick={onDelete} size={26}><I.Trash size={13} /></IconBtn>}
    </div>
  );
}

function toggleField(coll, item) { window.Store.toggle(coll, item); }

function UsageBar({ value }) {
  const tone = value > 0.8 ? 'var(--accent-danger)' : value > 0.6 ? 'var(--accent-warn)' : 'var(--accent-good)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 120 }}>
      <div style={{ flex: 1, height: 5, borderRadius: 3, background: 'var(--bg-3)', overflow: 'hidden' }}>
        <div style={{ width: `${Math.round(value * 100)}%`, height: '100%', background: tone, borderRadius: 3 }} />
      </div>
      <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', width: 30, textAlign: 'right' }}>{Math.round(value * 100)}%</span>
    </div>
  );
}

function Chip({ children, tone }) {
  const t = tone ? TONE[tone] : null;
  return <span className="mono" style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 7px', borderRadius: 4, fontSize: 11, background: t ? t.soft : 'var(--bg-2)', border: '1px solid var(--line)', color: t ? t.fg : 'var(--fg-2)' }}>{children}</span>;
}

function useToggleMap(rows, key, field) {
  const [map, setMap] = useTblState(() => Object.fromEntries(rows.map(r => [r[key], r[field]])));
  return [map, (k) => setMap(m => ({ ...m, [k]: !m[k] }))];
}

const openCreate = (coll) => window.nmModal({ coll, mode: 'create' });
const openEdit = (coll, item) => window.nmModal({ coll, mode: 'edit', item });
const openDelete = (coll, item) => window.nmModal({ kind: 'confirm', coll, item });

/* ---- Routing rules ---- */
function RoutingRules() {
  useDataVersion();
  const { ROUTING_RULES, PROVIDERS } = window.NM_DATA;
  const provName = (id) => (PROVIDERS.find(p => p.id === id) || {}).name || id;
  const cols = [
    { key: 'priority', label: 'Prio', width: 60, mono: true, render: (r) => r.isDefault ? <Chip>default</Chip> : r.priority },
    { key: 'recipient_domain', label: 'Recipient', mono: true, render: (r) => <span style={{ color: r.recipient_domain === '*' ? 'var(--fg-4)' : 'var(--fg-1)' }}>{r.recipient_domain}</span> },
    { key: 'sender_domain', label: 'Sender', mono: true, render: (r) => <span style={{ color: r.sender_domain === '*' ? 'var(--fg-4)' : 'var(--fg-1)' }}>{r.sender_domain}</span> },
    { key: 'provider_chain', label: 'Provider chain', render: (r) => (
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
        {r.provider_chain.map((id, i) => (
          <React.Fragment key={id}>
            {i > 0 && <I.ArrowRight size={11} style={{ color: 'var(--fg-4)' }} />}
            <Chip tone={i === 0 ? 'accent' : undefined}>{provName(id)}</Chip>
          </React.Fragment>
        ))}
      </div>
    ) },
    { key: 'matched24h', label: 'Matched 24h', align: 'right', mono: true, nowrap: true, render: (r) => <span style={{ color: 'var(--fg-2)' }}>{r.matched24h.toLocaleString()}</span> },
    { key: 'enabled', label: 'On', align: 'center', width: 60, render: (r) => <div style={{ display: 'flex', justifyContent: 'center' }} onClick={(e) => e.stopPropagation()}><Toggle size="sm" on={r.enabled} onChange={() => toggleField('rules', r)} /></div> },
    { key: 'act', label: '', align: 'right', width: 72, render: (r) => <RowActions onEdit={() => openEdit('rules', r)} onDelete={() => openDelete('rules', r)} /> },
  ];
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <PageHeader icon={<I.Route size={18} />} eyebrow="routing" title="Routing rules" count={ROUTING_RULES.length}
        sub="recipient-domain → sender-domain → default · first match wins"
        actions={<Btn kind="primary" icon={<I.Plus size={13} />} size="sm" onClick={() => openCreate('rules')}>new rule</Btn>} />
      <ScreenBody><DataTable columns={cols} rows={ROUTING_RULES} rowKey={(r) => r.id} onRowClick={(r) => !r.isDefault && openEdit('rules', r)} /></ScreenBody>
    </div>
  );
}

/* ---- Relay domains ---- */
function RelayDomains() {
  useDataVersion();
  const { RELAY_DOMAINS } = window.NM_DATA;
  const cols = [
    { key: 'domain', label: 'Domain', mono: true, render: (r) => <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><I.Globe size={13} style={{ color: 'var(--fg-3)' }} />{r.domain}</span> },
    { key: 'dkim_selector', label: 'DKIM selector', mono: true, render: (r) => <span style={{ color: 'var(--fg-2)' }}>{r.dkim_selector}._domainkey</span> },
    { key: 'dkim', label: 'DKIM', render: (r) => <StatusBadge status={r.dkim} dot /> },
    { key: 'verified', label: 'Verified', render: (r) => r.verified ? <span style={{ color: 'var(--accent-good)', display: 'inline-flex', alignItems: 'center', gap: 5 }}><I.CheckCircle size={14} /></span> : <span className="mono" style={{ color: 'var(--accent-warn)', fontSize: 11 }}>awaiting DNS</span> },
    { key: 'messages24h', label: 'Messages 24h', align: 'right', mono: true, nowrap: true, render: (r) => <span style={{ color: 'var(--fg-2)' }}>{r.messages24h.toLocaleString()}</span> },
    { key: 'act', label: '', align: 'right', width: 72, render: (r) => <RowActions onEdit={() => openEdit('domains', r)} onDelete={() => openDelete('domains', r)} /> },
  ];
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <PageHeader icon={<I.Globe size={18} />} eyebrow="routing" title="Relay domains" count={RELAY_DOMAINS.length}
        sub="domains this relay is authorized to send for · DKIM signed at delivery"
        actions={<Btn kind="primary" icon={<I.Plus size={13} />} size="sm" onClick={() => openCreate('domains')}>add domain</Btn>} />
      <ScreenBody><DataTable columns={cols} rows={RELAY_DOMAINS} rowKey={(r) => r.domain} onRowClick={(r) => openEdit('domains', r)} /></ScreenBody>
    </div>
  );
}

/* ---- Rate limits ---- */
function RateLimits() {
  useDataVersion();
  const { RATE_LIMITS } = window.NM_DATA;
  const cols = [
    { key: 'domain', label: 'Domain', mono: true, render: (r) => <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>{r.domain}{r.note && <Chip>{r.note}</Chip>}</span> },
    { key: 'per_second', label: 'Per second', align: 'right', mono: true, render: (r) => <span>{r.per_second}<span style={{ color: 'var(--fg-4)' }}>/s</span></span> },
    { key: 'burst', label: 'Burst', align: 'right', mono: true, render: (r) => r.burst },
    { key: 'usage', label: 'Current usage', width: 180, render: (r) => <UsageBar value={r.usage} /> },
    { key: 'enabled', label: 'On', align: 'center', width: 60, render: (r) => <div style={{ display: 'flex', justifyContent: 'center' }} onClick={(e) => e.stopPropagation()}><Toggle size="sm" on={r.enabled} onChange={() => toggleField('ratelimits', r)} /></div> },
    { key: 'act', label: '', align: 'right', width: 72, render: (r) => <RowActions onEdit={() => openEdit('ratelimits', r)} onDelete={() => openDelete('ratelimits', r)} /> },
  ];
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <PageHeader icon={<I.Gauge size={18} />} eyebrow="routing" title="Rate limits" count={RATE_LIMITS.length}
        sub="per-recipient-domain token buckets · throttled domains dead-letter to wait tiers"
        actions={<Btn kind="primary" icon={<I.Plus size={13} />} size="sm" onClick={() => openCreate('ratelimits')}>new limit</Btn>} />
      <ScreenBody><DataTable columns={cols} rows={RATE_LIMITS} rowKey={(r) => r.domain} onRowClick={(r) => openEdit('ratelimits', r)} /></ScreenBody>
    </div>
  );
}

/* ---- Accounts ---- */
function Accounts() {
  useDataVersion();
  const { ACCOUNTS } = window.NM_DATA;
  const cols = [
    { key: 'username', label: 'Username', mono: true, render: (r) => <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><I.Key size={13} style={{ color: 'var(--fg-3)' }} />{r.username}</span> },
    { key: 'allowed_sender_domains', label: 'Allowed sender domains', render: (r) => <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>{r.allowed_sender_domains.map(d => <Chip key={d}>{d}</Chip>)}</div> },
    { key: 'sent24h', label: 'Sent 24h', align: 'right', mono: true, nowrap: true, render: (r) => <span style={{ color: 'var(--fg-2)' }}>{r.sent24h.toLocaleString()}</span> },
    { key: 'lastAuth', label: 'Last auth', align: 'right', mono: true, nowrap: true, render: (r) => <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{r.lastAuth}</span> },
    { key: 'enabled', label: 'On', align: 'center', width: 60, render: (r) => <div style={{ display: 'flex', justifyContent: 'center' }} onClick={(e) => e.stopPropagation()}><Toggle size="sm" on={r.enabled} onChange={() => toggleField('accounts', r)} /></div> },
    { key: 'act', label: '', align: 'right', width: 72, render: (r) => <RowActions onEdit={() => openEdit('accounts', r)} onDelete={() => openDelete('accounts', r)} /> },
  ];
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <PageHeader icon={<I.Key size={18} />} eyebrow="access" title="Accounts" count={ACCOUNTS.length}
        sub="SMTP submission credentials · passwords envelope-encrypted at rest"
        actions={<Btn kind="primary" icon={<I.Plus size={13} />} size="sm" onClick={() => openCreate('accounts')}>new account</Btn>} />
      <ScreenBody><DataTable columns={cols} rows={ACCOUNTS} rowKey={(r) => r.id} onRowClick={(r) => openEdit('accounts', r)} /></ScreenBody>
    </div>
  );
}

Object.assign(window, { RoutingRules, RelayDomains, RateLimits, Accounts, DataTable, Chip, RowActions });
