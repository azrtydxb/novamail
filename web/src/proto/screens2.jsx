/* global React, I */
/* NovaMail — Incoming/Outgoing/Observe screens added in the mail-flow restructure.
   Reuses the shared primitives (PageHeader, ScreenBody, DataTable, Btn, Chip,
   Toggle, RowActions, StatusBadge) and window.Store for live data + CRUD. */
const { useState: useS2State, useEffect: useS2Effect } = React;

const openCreate2 = (coll, preset) => window.nmModal({ coll, mode: 'create', preset });
const openEdit2 = (coll, item) => window.nmModal({ coll, mode: 'edit', item });
const openDelete2 = (coll, item) => window.nmModal({ kind: 'confirm', coll, item });

/* ---- Relay clients (trusted IP/CIDR, no-auth relay) ---- */
function RelayClients() {
  useDataVersion();
  const { RELAY_CLIENTS } = window.NM_DATA;
  const cols = [
    { key: 'cidr', label: 'Source range', mono: true, render: (r) => <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><I.Globe size={13} style={{ color: 'var(--fg-3)' }} />{r.cidr}</span> },
    { key: 'description', label: 'Description', render: (r) => <span style={{ color: 'var(--fg-2)' }}>{r.description || '—'}</span> },
    { key: 'allowed_sender_domains', label: 'Allowed senders', render: (r) => <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>{r.allowed_sender_domains.length ? r.allowed_sender_domains.map(d => <Chip key={d}>{d}</Chip>) : <Chip>any</Chip>}</div> },
    { key: 'enabled', label: 'On', align: 'center', width: 60, render: (r) => <div style={{ display: 'flex', justifyContent: 'center' }} onClick={(e) => e.stopPropagation()}><Toggle size="sm" on={r.enabled} onChange={() => window.Store.toggle('relayclients', r)} /></div> },
    { key: 'act', label: '', align: 'right', width: 72, render: (r) => <RowActions onEdit={() => openEdit2('relayclients', r)} onDelete={() => openDelete2('relayclients', r)} /> },
  ];
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <PageHeader icon={<I.Globe size={18} />} eyebrow="incoming" title="Relay clients" count={RELAY_CLIENTS.length}
        sub="trusted source ranges that may relay WITHOUT SMTP AUTH (IP-authenticated)"
        actions={<Btn kind="primary" icon={<I.Plus size={13} />} size="sm" onClick={() => openCreate2('relayclients')}>add range</Btn>} />
      <ScreenBody><DataTable columns={cols} rows={RELAY_CLIENTS} rowKey={(r) => r.id} onRowClick={(r) => openEdit2('relayclients', r)} /></ScreenBody>
    </div>
  );
}

/* ---- Rate limits, split by direction ---- */
function RateLimitTable({ direction }) {
  useDataVersion();
  const rows = (window.NM_DATA.RATE_LIMITS || []).filter((r) => (r.direction || 'out') === direction);
  const inbound = direction === 'in';
  const cols = [
    { key: 'scope', label: 'Scope', mono: true, render: (r) => <Chip tone="accent">{r.scope || (inbound ? 'global' : 'recipient_domain')}</Chip> },
    { key: 'domain', label: 'Key', mono: true, render: (r) => <span style={{ color: r.domain === '*' ? 'var(--fg-4)' : 'var(--fg-1)' }}>{r.domain === '*' ? 'all' : r.domain}</span> },
    { key: 'per_second', label: 'Per second', align: 'right', mono: true, render: (r) => <span>{r.per_second}<span style={{ color: 'var(--fg-4)' }}>/s</span></span> },
    { key: 'burst', label: 'Burst', align: 'right', mono: true, render: (r) => r.burst },
    { key: 'enabled', label: 'On', align: 'center', width: 60, render: (r) => <div style={{ display: 'flex', justifyContent: 'center' }} onClick={(e) => e.stopPropagation()}><Toggle size="sm" on={r.enabled} onChange={() => window.Store.toggle('ratelimits', r)} /></div> },
    { key: 'act', label: '', align: 'right', width: 72, render: (r) => <RowActions onEdit={() => openEdit2('ratelimits', r)} onDelete={() => openDelete2('ratelimits', r)} /> },
  ];
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <PageHeader icon={<I.Gauge size={18} />} eyebrow={inbound ? 'incoming' : 'outgoing'} title={inbound ? 'Inbound rate limits' : 'Outbound rate limits'} count={rows.length}
        sub={inbound ? 'token buckets on submission · per account / source IP / global → 451 when exceeded' : 'token buckets on delivery · per recipient domain / provider / global'}
        actions={<Btn kind="primary" icon={<I.Plus size={13} />} size="sm" onClick={() => openCreate2('ratelimits', { direction, scope: inbound ? 'account' : 'recipient_domain' })}>new limit</Btn>} />
      <ScreenBody><DataTable columns={cols} rows={rows} rowKey={(r) => r.id} onRowClick={(r) => openEdit2('ratelimits', r)} /></ScreenBody>
    </div>
  );
}
function RateLimitsIn() { return <RateLimitTable direction="in" />; }
function RateLimitsOut() { return <RateLimitTable direction="out" />; }

/* ---- DKIM keys ---- */
function DKIMKeys() {
  useDataVersion();
  const { DKIM_KEYS } = window.NM_DATA;
  const cols = [
    { key: 'domain', label: 'Domain', mono: true, render: (r) => <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><I.Shield size={13} style={{ color: 'var(--fg-3)' }} />{r.domain}</span> },
    { key: 'selector', label: 'Selector', mono: true, render: (r) => <span style={{ color: 'var(--fg-2)' }}>{r.selector}._domainkey</span> },
    { key: 'rotation', label: 'Status', render: (r) => <StatusBadge status={r.rotation === 'active' ? 'active' : r.rotation === 'retiring' ? 'pending' : 'idle'} dot /> },
    { key: 'act', label: '', align: 'right', width: 48, render: (r) => <RowActions onDelete={() => openDelete2('dkim', r)} /> },
  ];
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <PageHeader icon={<I.Shield size={18} />} eyebrow="outgoing" title="DKIM keys" count={DKIM_KEYS.length}
        sub="per-domain signing keys · private key envelope-encrypted · publish the DNS TXT to verify"
        actions={<Btn kind="primary" icon={<I.Plus size={13} />} size="sm" onClick={() => window.nmModal({ kind: 'dkimgen' })}>generate key</Btn>} />
      <ScreenBody><DataTable columns={cols} rows={DKIM_KEYS} rowKey={(r) => r.id} /></ScreenBody>
    </div>
  );
}

/* ---- Suppressions ---- */
function Suppressions() {
  useDataVersion();
  const { SUPPRESSIONS } = window.NM_DATA;
  const reasonTone = { hard_bounce: 'danger', complaint: 'warn', manual: 'accent' };
  const cols = [
    { key: 'address', label: 'Address', mono: true, render: (r) => <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><I.Ban size={13} style={{ color: 'var(--accent-danger)' }} />{r.address}</span> },
    { key: 'reason', label: 'Reason', render: (r) => <Chip tone={reasonTone[r.reason]}>{r.reason}</Chip> },
    { key: 'source', label: 'Source', mono: true, render: (r) => <span style={{ color: 'var(--fg-3)' }}>{r.source}</span> },
    { key: 'created_at', label: 'Added', align: 'right', mono: true, nowrap: true, render: (r) => <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{fmtWhen(r.created_at)}</span> },
    { key: 'act', label: '', align: 'right', width: 48, render: (r) => <RowActions onDelete={() => openDelete2('suppressions', r)} /> },
  ];
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <PageHeader icon={<I.Ban size={18} />} eyebrow="observe" title="Suppressions" count={SUPPRESSIONS.length}
        sub="recipients skipped on send · auto-added on hard bounce / complaint, or manually"
        actions={<Btn kind="primary" icon={<I.Plus size={13} />} size="sm" onClick={() => openCreate2('suppressions')}>suppress address</Btn>} />
      <ScreenBody><DataTable columns={cols} rows={SUPPRESSIONS} rowKey={(r) => r.address} /></ScreenBody>
    </div>
  );
}

/* ---- Audit log (read-only) ---- */
function AuditLog() {
  useDataVersion();
  const { AUDIT } = window.NM_DATA;
  const cols = [
    { key: 'at', label: 'When', mono: true, nowrap: true, width: 150, render: (r) => <span style={{ color: 'var(--fg-3)' }}>{fmtWhen(r.at)}</span> },
    { key: 'actor', label: 'Actor', mono: true, render: (r) => <Chip tone={r.actor === 'api-key' ? undefined : 'accent'}>{r.actor}</Chip> },
    { key: 'action', label: 'Action', mono: true, render: (r) => <span style={{ color: 'var(--fg-1)' }}>{r.action}</span> },
    { key: 'target', label: 'Target', mono: true, render: (r) => <span style={{ color: 'var(--fg-3)' }}>{r.target}</span> },
  ];
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <PageHeader icon={<I.List size={18} />} eyebrow="observe" title="Audit log" count={AUDIT.length}
        sub="every configuration change, attributed to the operator who made it" />
      <ScreenBody><DataTable columns={cols} rows={AUDIT} rowKey={(r) => r.id} /></ScreenBody>
    </div>
  );
}

/* ---- Operators (admin users) ---- */
function Operators() {
  useDataVersion();
  const { OPERATORS } = window.NM_DATA;
  const cols = [
    { key: 'username', label: 'Username', mono: true, render: (r) => <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><I.Users size={13} style={{ color: 'var(--fg-3)' }} />{r.username}</span> },
    { key: 'role', label: 'Role', render: (r) => <Chip tone={r.role === 'admin' ? 'accent' : undefined}>{r.role}</Chip> },
    { key: 'enabled', label: 'Status', render: (r) => <StatusBadge status={r.enabled ? 'active' : 'idle'} dot /> },
    { key: 'act', label: '', align: 'right', width: 48, render: (r) => <RowActions onDelete={() => openDelete2('operators', r)} /> },
  ];
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <PageHeader icon={<I.Users size={18} />} eyebrow="observe" title="Operators" count={OPERATORS.length}
        sub="management-plane logins · distinct from SMTP submission accounts"
        actions={<Btn kind="primary" icon={<I.Plus size={13} />} size="sm" onClick={() => openCreate2('operators')}>new operator</Btn>} />
      <ScreenBody><DataTable columns={cols} rows={OPERATORS} rowKey={(r) => r.id} /></ScreenBody>
    </div>
  );
}

function fmtWhen(s) {
  if (!s) return '—';
  try { return new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return s; }
}

Object.assign(window, { RelayClients, RateLimitsIn, RateLimitsOut, DKIMKeys, Suppressions, AuditLog, Operators });
