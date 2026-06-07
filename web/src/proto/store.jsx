// NovaMail data store — replaces the prototype's mock data.jsx with the real
// Fastify Admin API. It maps API resources to the prototype's NM_DATA shapes so
// the screens stay byte-identical, and exposes window.Store for CRUD/telemetry.
import { api } from '../api.ts';

export const PROVIDER_TYPE_LABEL = {
  ses: 'Amazon SES', m365: 'Microsoft 365', gmail: 'Gmail / XOAUTH2', smtp: 'Generic SMTP', direct: 'Direct-to-MX',
};

// Provider auth-mode <-> DB CHECK (xoauth2|smtp-auth|ip|iam) translation.
const AUTH_TO_DB = { 'XOAUTH2': 'xoauth2', 'AWS-SIGV4': 'iam', 'PLAIN': 'smtp-auth', 'LOGIN': 'smtp-auth', 'NONE': 'ip' };
const AUTH_FROM_DB = { xoauth2: 'XOAUTH2', iam: 'AWS-SIGV4', 'smtp-auth': 'PLAIN', ip: 'NONE' };
const z24 = () => Array.from({ length: 24 }, () => 0);
const fmtSize = (n) => (n == null ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const star = (v) => (v == null || v === '' ? '*' : v);
const unstar = (v) => (v === '*' || v === '' ? null : v);

// Live cache in the prototype's exact shape.
const NM_DATA = {
  SERVER: { name: 'relay-kw', version: 'v1', nodes: [] },
  // 24-length zero arrays so Sparkline always has data (telemetry fills real values).
  SERIES: { relayed: z24(), deferred: z24(), bounced: z24(), queue: z24(), latency: z24() },
  METRICS: { relayed24h: 0, deferred24h: 0, bounced24h: 0, acceptRate: 100, queueDepth: 0, p50Latency: 0, p95Latency: 0, dkimSigned: 100 },
  PROVIDERS: [], ROUTING_RULES: [], RELAY_DOMAINS: [], RATE_LIMITS: [], ACCOUNTS: [],
  MESSAGES: [], QUEUES: [], PROVIDER_TYPE_LABEL,
  RELAY_CLIENTS: [], SUPPRESSIONS: [], AUDIT: [], OPERATORS: [], DKIM_KEYS: [], SETTINGS: {}, OPERATOR: null,
};
window.NM_DATA = NM_DATA;

const bump = () => { try { window.bumpData ? window.bumpData() : window.dispatchEvent(new Event('nm:data')); } catch { /* */ } };

// ---- mappers: API row -> prototype shape ----
const fmtWhen = (s) => { if (!s) return '—'; try { return new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return '—'; } };
function mapProvider(p, vol, health) {
  const h = (health || {})[p.name];
  // status from the most recent real attempt (healthy/degraded); idle if disabled or never used.
  const status = !p.enabled ? 'idle' : (h ? h.status : 'idle');
  return {
    id: p.id, name: p.name, type: p.type, endpoint: p.endpoint || '',
    auth_mode: AUTH_FROM_DB[p.auth_mode] || (p.auth_mode || 'NONE').toUpperCase(),
    secret_ref: p.secret_ref || '—', enabled: p.enabled,
    status, sent24h: vol[p.name] || 0, lastUsed: h ? fmtWhen(h.lastUsed) : '—',
  };
}
function mapRule(r) {
  return {
    id: r.id, recipient_domain: star(r.recipient_domain), sender_domain: star(r.sender_domain),
    provider_chain: r.provider_chain || [], priority: r.priority, enabled: r.enabled,
    isDefault: !r.recipient_domain && !r.sender_domain, matched24h: 0,
  };
}
function mapDomain(d, dk, domVol) {
  const k = dk.find((x) => x.domain === d.domain);
  return {
    domain: d.domain, dkim_selector: k ? k.selector : '—',
    dkim: k ? (k.rotation === 'active' ? 'active' : 'pending') : 'pending',
    messages24h: (domVol || {})[(d.domain || '').toLowerCase()] || 0,
    verified: !!k && k.rotation === 'active', enabled: d.enabled !== false,
  };
}
function mapRate(r) {
  // 'domain' kept for the current rate-limits screen (= scope_value); the
  // direction/scope split surfaces in the restructured GUI.
  return { id: r.id, domain: r.scope_value, direction: r.direction, scope: r.scope, per_second: r.per_second, burst: r.burst, enabled: r.enabled, usage: 0, note: r.scope_value === '*' ? 'default' : undefined };
}
function mapAccount(a) {
  return { id: a.id, username: a.username, allowed_sender_domains: a.allowed_sender_domains || [], ip_allowlist: a.ip_allowlist || [], enabled: a.enabled !== false, lastAuth: '—', sent24h: 0 };
}

async function loadMessages() {
  const list = await api('/messages?limit=40');
  // fetch event timelines (bounded) so the trace view renders verbatim
  const withEvents = await Promise.all(list.slice(0, 40).map(async (m) => {
    let events = [];
    try { events = await api(`/messages/${m.id}/events`); } catch { /* */ }
    const lastProv = [...events].reverse().find((e) => e.provider);
    return {
      id: m.id, mail_from: m.mail_from || '<>', rcpt_to: m.rcpt_to || [], subject: m.subject || '—',
      status: m.status, attempts: m.attempts, provider: lastProv ? lastProv.provider : '—',
      size: fmtSize(m.size_bytes), created_at: m.created_at,
      events: events.map((e) => ({ kind: e.kind, provider: e.provider, detail: e.detail || '', at: e.at })),
    };
  }));
  return withEvents;
}

async function loadAll() {
  const [providers, rules, domains, dkim, rates, accounts, messages] = await Promise.all([
    api('/providers').catch(() => []),
    api('/routing-rules').catch(() => []),
    api('/relay-domains').catch(() => []),
    api('/dkim-keys').catch(() => []),
    api('/rate-limits').catch(() => []),
    api('/accounts').catch(() => []),
    loadMessages().catch(() => []),
  ]);
  // Management-plane resources (best-effort; absent endpoints leave [] defaults).
  const [relayClients, suppressions, audit, operators, settings] = await Promise.all([
    api('/relay-clients').catch(() => []),
    api('/suppressions').catch(() => []),
    api('/audit?limit=200').catch(() => []),
    api('/auth/admin/list-users?limit=200').catch(() => ({ users: [] })),
    api('/settings').catch(() => []),
  ]);

  await checkSession();

  let metrics = null, queues = [];
  try { metrics = await api('/metrics'); } catch { /* telemetry optional */ }
  try { queues = await api('/queues'); } catch { /* */ }

  const vol = (metrics && metrics.providerVolume) || {};
  const health = (metrics && metrics.providerHealth) || {};
  const domVol = (metrics && metrics.domainVolume) || {};
  NM_DATA.PROVIDERS = providers.map((p) => mapProvider(p, vol, health));
  NM_DATA.ROUTING_RULES = rules.map(mapRule);
  NM_DATA.RELAY_DOMAINS = domains.map((d) => mapDomain(d, dkim, domVol));
  NM_DATA.RATE_LIMITS = rates.map(mapRate);
  NM_DATA.ACCOUNTS = accounts.map(mapAccount);
  NM_DATA.MESSAGES = messages;
  NM_DATA.QUEUES = queues;
  NM_DATA.RELAY_CLIENTS = (relayClients || []).map((c) => ({ id: c.id, cidr: c.cidr, description: c.description || '', allowed_sender_domains: c.allowed_sender_domains || [], enabled: c.enabled !== false }));
  NM_DATA.SUPPRESSIONS = (suppressions || []).map((s) => ({ address: s.address, reason: s.reason, source: s.source || '—', created_at: s.created_at }));
  NM_DATA.AUDIT = (audit || []).map((a) => ({ id: a.id, actor: a.actor, action: a.action, target: a.target || '', at: a.at }));
  NM_DATA.OPERATORS = ((operators && operators.users) || []).map((u) => ({ id: u.id, username: u.email, role: u.role || 'user', enabled: !u.banned }));
  NM_DATA.DKIM_KEYS = (dkim || []).map((k) => ({ id: k.id, domain: k.domain, selector: k.selector, rotation: k.rotation || 'active' }));
  NM_DATA.SETTINGS = Object.fromEntries((settings || []).map((s) => [s.key, s.value]));
  if (metrics) {
    NM_DATA.METRICS = { ...NM_DATA.METRICS, ...metrics.metrics };
    NM_DATA.SERIES = { ...NM_DATA.SERIES, ...metrics.series };
    if (metrics.server) NM_DATA.SERVER = metrics.server;
  }
  bump();
}

// ---- writes: prototype shape -> API ----
async function save(coll, f, item) {
  if (coll === 'providers') {
    const body = { name: f.name, type: f.type, endpoint: f.type === 'direct' ? null : (f.endpoint || null), auth_mode: AUTH_TO_DB[f.auth_mode] || 'ip', enabled: !!f.enabled, secret_ref: f.type === 'direct' ? null : (f.secret_ref && f.secret_ref !== '—' ? f.secret_ref : null) };
    item ? await api(`/providers/${item.id}`, { method: 'PUT', body }) : await api('/providers', { method: 'POST', body });
  } else if (coll === 'rules') {
    const body = { recipient_domain: unstar(f.recipient_domain), sender_domain: unstar(f.sender_domain), provider_chain: f.provider_chain, priority: Number(f.priority), enabled: !!f.enabled };
    item ? await api(`/routing-rules/${item.id}`, { method: 'PUT', body }) : await api('/routing-rules', { method: 'POST', body });
  } else if (coll === 'domains') {
    if (!item) await api('/relay-domains', { method: 'POST', body: { domain: f.domain, enabled: f.enabled !== false } });
  } else if (coll === 'ratelimits') {
    const body = { direction: f.direction || 'out', scope: f.scope || 'recipient_domain', scope_value: f.domain, per_second: Number(f.per_second), burst: Number(f.burst), enabled: !!f.enabled };
    item ? await api(`/rate-limits/${item.id}`, { method: 'PUT', body }) : await api('/rate-limits', { method: 'POST', body });
  } else if (coll === 'accounts') {
    if (!item) await api('/accounts', { method: 'POST', body: { username: f.username, password: f.password, allowed_sender_domains: f.allowed_sender_domains, ip_allowlist: f.ip_allowlist || [] } });
    else await api(`/accounts/${item.id}`, { method: 'PUT', body: { allowed_sender_domains: f.allowed_sender_domains, ip_allowlist: f.ip_allowlist || [], enabled: !!f.enabled, ...(f.password ? { password: f.password } : {}) } });
  } else if (coll === 'relayclients') {
    const body = { cidr: f.cidr, description: f.description || '', allowed_sender_domains: f.allowed_sender_domains || [], enabled: !!f.enabled };
    item ? await api(`/relay-clients/${item.id}`, { method: 'PUT', body }) : await api('/relay-clients', { method: 'POST', body });
  } else if (coll === 'suppressions') {
    await api('/suppressions', { method: 'POST', body: { address: f.address, reason: f.reason || 'manual' } });
  } else if (coll === 'operators') {
    await api('/auth/admin/create-user', { method: 'POST', body: { email: f.username, password: f.password, name: f.username, role: f.role || 'admin' } });
  }
  await loadAll();
}

async function remove(coll, item) {
  if (coll === 'operators') {
    await api('/auth/admin/remove-user', { method: 'POST', body: { userId: item.id } });
    await loadAll();
    return;
  }
  const path = { providers: 'providers', rules: 'routing-rules', domains: 'relay-domains', ratelimits: 'rate-limits', accounts: 'accounts', relayclients: 'relay-clients', suppressions: 'suppressions', dkim: 'dkim-keys' }[coll];
  let id;
  if (coll === 'domains') id = encodeURIComponent(item.domain);
  else if (coll === 'suppressions') id = encodeURIComponent(item.address);
  else id = item.id || encodeURIComponent(item.domain);
  await api(`/${path}/${id}`, { method: 'DELETE' });
  await loadAll();
}

async function toggle(coll, item) {
  try {
    if (coll === 'providers') await api(`/providers/${item.id}`, { method: 'PUT', body: { enabled: !item.enabled } });
    else if (coll === 'rules') await api(`/routing-rules/${item.id}`, { method: 'PUT', body: { enabled: !item.enabled } });
    else if (coll === 'ratelimits') await api(`/rate-limits/${item.id}`, { method: 'PUT', body: { enabled: !item.enabled } });
    else if (coll === 'domains') await api(`/relay-domains/${encodeURIComponent(item.domain)}`, { method: 'PUT', body: { enabled: !item.enabled } });
    else if (coll === 'accounts') await api(`/accounts/${item.id}`, { method: 'PUT', body: { enabled: !item.enabled } });
    else if (coll === 'relayclients') await api(`/relay-clients/${item.id}`, { method: 'PUT', body: { enabled: !item.enabled } });
  } catch (e) {
    window.nmToast && window.nmToast(String(e.message || e), 'danger');
  }
  await loadAll();
}

// Lighter poll for live dashboards/queue — telemetry + message list, no per-
// message event timelines.
async function refreshLight() {
  try {
    const [metrics, queues, list] = await Promise.all([
      api('/metrics').catch(() => null),
      api('/queues').catch(() => []),
      api('/messages?limit=40').catch(() => null),
    ]);
    if (queues) NM_DATA.QUEUES = queues;
    if (metrics) {
      NM_DATA.METRICS = { ...NM_DATA.METRICS, ...metrics.metrics };
      NM_DATA.SERIES = { ...NM_DATA.SERIES, ...metrics.series };
      if (metrics.server) NM_DATA.SERVER = metrics.server;
      const vol = metrics.providerVolume || {};
      const health = metrics.providerHealth || {};
      NM_DATA.PROVIDERS = NM_DATA.PROVIDERS.map((p) => ({ ...p, sent24h: vol[p.name] || p.sent24h, status: !p.enabled ? 'idle' : (health[p.name] ? health[p.name].status : p.status), lastUsed: health[p.name] ? fmtWhen(health[p.name].lastUsed) : p.lastUsed }));
    }
    if (list) {
      // merge new list rows, preserving already-loaded event timelines
      const byId = Object.fromEntries(NM_DATA.MESSAGES.map((m) => [m.id, m]));
      NM_DATA.MESSAGES = list.map((m) => ({
        id: m.id, mail_from: m.mail_from || '<>', rcpt_to: m.rcpt_to || [], subject: m.subject || '—',
        status: m.status, attempts: m.attempts, provider: byId[m.id] ? byId[m.id].provider : '—',
        size: fmtSize(m.size_bytes), created_at: m.created_at, events: byId[m.id] ? byId[m.id].events : [],
      }));
    }
    bump();
  } catch { /* */ }
}

// ---- auth (better-auth, cookie sessions) ----
async function login(email, password) {
  await api('/auth/sign-in/email', { method: 'POST', body: { email, password } });
  await checkSession();
}
async function logout() {
  try { await api('/auth/sign-out', { method: 'POST', body: {} }); } catch { /* */ }
  NM_DATA.OPERATOR = null;
}
async function checkSession() {
  try {
    const s = await api('/auth/get-session');
    NM_DATA.OPERATOR = s && s.user ? { username: s.user.email, role: s.user.role || 'user', id: s.user.id } : null;
  } catch { NM_DATA.OPERATOR = null; }
  return NM_DATA.OPERATOR;
}
async function changePassword(current, next) {
  return api('/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next, revokeOtherSessions: false } });
}

// ---- one-off actions ----
async function generateDKIM(domain, selector) {
  const res = await api('/dkim-keys/generate', { method: 'POST', body: { domain, selector } });
  await loadAll();
  return res; // { dns: { name, type, value } }
}
async function purgeQueue(name) { await api(`/queues/${encodeURIComponent(name)}/purge`, { method: 'POST' }); await refreshLight(); }
async function requeueMessage(id) { await api(`/messages/${id}/requeue`, { method: 'POST' }); await refreshLight(); }
async function saveSetting(key, value) { await api(`/settings/${encodeURIComponent(key)}`, { method: 'PUT', body: { value } }); await loadAll(); }
// testProvider verifies a provider's connectivity + auth without sending; returns {ok, error?}.
async function testProvider(id) { try { return await api(`/providers/${id}/test`, { method: 'POST' }); } catch (e) { return { ok: false, error: String(e.message || e) }; } }

window.Store = { loadAll, refreshLight, save, remove, toggle, login, logout, checkSession, changePassword, generateDKIM, purgeQueue, requeueMessage, saveSetting, testProvider };
export const Store = window.Store;
