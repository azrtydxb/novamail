// NovaMail data store — replaces the prototype's mock data.jsx with the real
// Fastify Admin API. It maps API resources to the prototype's NM_DATA shapes so
// the screens stay byte-identical, and exposes window.Store for CRUD/telemetry.
import { api } from '../api.ts';

export const PROVIDER_TYPE_LABEL = {
  ses: 'Amazon SES', m365: 'Microsoft 365', gmail: 'Gmail / XOAUTH2', smtp: 'Generic SMTP',
};

// Provider auth-mode <-> DB CHECK (xoauth2|smtp-auth|ip|iam) translation.
const AUTH_TO_DB = { 'XOAUTH2': 'xoauth2', 'AWS-SIGV4': 'iam', 'PLAIN': 'smtp-auth', 'LOGIN': 'smtp-auth', 'NONE': 'ip' };
const AUTH_FROM_DB = { xoauth2: 'XOAUTH2', iam: 'AWS-SIGV4', 'smtp-auth': 'PLAIN', ip: 'NONE' };
const z24 = () => Array.from({ length: 24 }, () => 0);
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
};
window.NM_DATA = NM_DATA;

const bump = () => { try { window.bumpData ? window.bumpData() : window.dispatchEvent(new Event('nm:data')); } catch { /* */ } };

// ---- mappers: API row -> prototype shape ----
function mapProvider(p, vol) {
  return {
    id: p.id, name: p.name, type: p.type, endpoint: p.endpoint || '',
    auth_mode: AUTH_FROM_DB[p.auth_mode] || (p.auth_mode || 'NONE').toUpperCase(),
    secret_ref: p.secret_ref || '—', enabled: p.enabled,
    status: p.enabled ? 'healthy' : 'idle', sent24h: vol[p.name] || 0, lastUsed: '—',
  };
}
function mapRule(r) {
  return {
    id: r.id, recipient_domain: star(r.recipient_domain), sender_domain: star(r.sender_domain),
    provider_chain: r.provider_chain || [], priority: r.priority, enabled: r.enabled,
    isDefault: !r.recipient_domain && !r.sender_domain, matched24h: 0,
  };
}
function mapDomain(d, dk) {
  const k = dk.find((x) => x.domain === d.domain);
  return {
    domain: d.domain, dkim_selector: k ? k.selector : '—',
    dkim: k ? (k.rotation === 'active' ? 'active' : 'pending') : 'pending',
    messages24h: 0, verified: !!k && k.rotation === 'active', enabled: d.enabled !== false,
  };
}
function mapRate(r) {
  return { domain: r.domain, per_second: r.per_second, burst: r.burst, enabled: r.enabled, usage: 0, note: r.domain === '*' ? 'default' : undefined };
}
function mapAccount(a) {
  return { id: a.id, username: a.username, allowed_sender_domains: a.allowed_sender_domains || [], enabled: a.enabled !== false, lastAuth: '—', sent24h: 0 };
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
      size: '—', created_at: m.created_at,
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
  let metrics = null, queues = [];
  try { metrics = await api('/metrics'); } catch { /* telemetry optional */ }
  try { queues = await api('/queues'); } catch { /* */ }

  const vol = (metrics && metrics.providerVolume) || {};
  NM_DATA.PROVIDERS = providers.map((p) => mapProvider(p, vol));
  NM_DATA.ROUTING_RULES = rules.map(mapRule);
  NM_DATA.RELAY_DOMAINS = domains.map((d) => mapDomain(d, dkim));
  NM_DATA.RATE_LIMITS = rates.map(mapRate);
  NM_DATA.ACCOUNTS = accounts.map(mapAccount);
  NM_DATA.MESSAGES = messages;
  NM_DATA.QUEUES = queues;
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
    const body = { name: f.name, type: f.type, endpoint: f.endpoint, auth_mode: AUTH_TO_DB[f.auth_mode] || 'ip', enabled: !!f.enabled, secret_ref: f.secret_ref && f.secret_ref !== '—' ? f.secret_ref : null };
    item ? await api(`/providers/${item.id}`, { method: 'PUT', body }) : await api('/providers', { method: 'POST', body });
  } else if (coll === 'rules') {
    const body = { recipient_domain: unstar(f.recipient_domain), sender_domain: unstar(f.sender_domain), provider_chain: f.provider_chain, priority: Number(f.priority), enabled: !!f.enabled };
    item ? await api(`/routing-rules/${item.id}`, { method: 'PUT', body }) : await api('/routing-rules', { method: 'POST', body });
  } else if (coll === 'domains') {
    if (!item) await api('/relay-domains', { method: 'POST', body: { domain: f.domain, enabled: !!f.verified || true } });
  } else if (coll === 'ratelimits') {
    const body = { domain: f.domain, per_second: Number(f.per_second), burst: Number(f.burst), enabled: !!f.enabled };
    item ? await api(`/rate-limits/${encodeURIComponent(item.domain)}`, { method: 'PUT', body }) : await api('/rate-limits', { method: 'POST', body });
  } else if (coll === 'accounts') {
    if (!item) await api('/accounts', { method: 'POST', body: { username: f.username, password: f.password, allowed_sender_domains: f.allowed_sender_domains } });
    else await api(`/accounts/${item.id}`, { method: 'PUT', body: { allowed_sender_domains: f.allowed_sender_domains, enabled: !!f.enabled, ...(f.password ? { password: f.password } : {}) } });
  }
  await loadAll();
}

async function remove(coll, item) {
  const path = { providers: 'providers', rules: 'routing-rules', domains: 'relay-domains', ratelimits: 'rate-limits', accounts: 'accounts' }[coll];
  const id = coll === 'domains' || coll === 'ratelimits' ? encodeURIComponent(item.domain) : (item.id || encodeURIComponent(item.domain));
  await api(`/${path}/${id}`, { method: 'DELETE' });
  await loadAll();
}

async function toggle(coll, item) {
  try {
    if (coll === 'providers') await api(`/providers/${item.id}`, { method: 'PUT', body: { enabled: !item.enabled } });
    else if (coll === 'rules') await api(`/routing-rules/${item.id}`, { method: 'PUT', body: { enabled: !item.enabled } });
    else if (coll === 'ratelimits') await api(`/rate-limits/${encodeURIComponent(item.domain)}`, { method: 'PUT', body: { enabled: !item.enabled } });
    else if (coll === 'domains') await api(`/relay-domains/${encodeURIComponent(item.domain)}`, { method: 'PUT', body: { enabled: !item.enabled } });
    else if (coll === 'accounts') await api(`/accounts/${item.id}`, { method: 'PUT', body: { enabled: !item.enabled } });
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
      NM_DATA.PROVIDERS = NM_DATA.PROVIDERS.map((p) => ({ ...p, sent24h: vol[p.name] || p.sent24h }));
    }
    if (list) {
      // merge new list rows, preserving already-loaded event timelines
      const byId = Object.fromEntries(NM_DATA.MESSAGES.map((m) => [m.id, m]));
      NM_DATA.MESSAGES = list.map((m) => ({
        id: m.id, mail_from: m.mail_from || '<>', rcpt_to: m.rcpt_to || [], subject: m.subject || '—',
        status: m.status, attempts: m.attempts, provider: byId[m.id] ? byId[m.id].provider : '—',
        size: '—', created_at: m.created_at, events: byId[m.id] ? byId[m.id].events : [],
      }));
    }
    bump();
  } catch { /* */ }
}

window.Store = { loadAll, refreshLight, save, remove, toggle };
export const Store = window.Store;
