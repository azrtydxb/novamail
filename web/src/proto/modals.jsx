/* global React, I */
/* NovaMail modals — reactive data store, toasts, modal host, CRUD forms */
const { useState: useMState, useEffect: useMEffect, useRef: useMRef } = React;

/* ===== reactive data store ===== */
function bumpData() { window.dispatchEvent(new Event('nm:data')); }
function useDataVersion() {
  const [, set] = useMState(0);
  useMEffect(() => {
    const h = () => set(v => v + 1);
    window.addEventListener('nm:data', h);
    return () => window.removeEventListener('nm:data', h);
  }, []);
}
const COLL = {
  providers:    { arr: 'PROVIDERS',     pk: 'id',       label: 'provider' },
  rules:        { arr: 'ROUTING_RULES', pk: 'id',       label: 'routing rule' },
  domains:      { arr: 'RELAY_DOMAINS', pk: 'domain',   label: 'relay domain' },
  ratelimits:   { arr: 'RATE_LIMITS',   pk: 'domain',   label: 'rate limit' },
  accounts:     { arr: 'ACCOUNTS',      pk: 'id',       label: 'account' },
  relayclients: { arr: 'RELAY_CLIENTS', pk: 'cidr',     label: 'relay client' },
  suppressions: { arr: 'SUPPRESSIONS',  pk: 'address',  label: 'suppression' },
  operators:    { arr: 'OPERATORS',     pk: 'username', label: 'operator' },
  dkim:         { arr: 'DKIM_KEYS',     pk: 'selector', label: 'DKIM key' },
};
const uid = (p) => p + '_' + Math.random().toString(36).slice(2, 8);

/* ===== toast ===== */
function ToastHost() {
  const [toasts, setToasts] = useMState([]);
  useMEffect(() => {
    window.nmToast = (msg, tone = 'good') => {
      const id = uid('t');
      setToasts(t => [...t, { id, msg, tone }]);
      setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3200);
    };
  }, []);
  return (
    <div style={{ position: 'fixed', bottom: 18, right: 18, zIndex: 200, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
      {toasts.map(t => (
        <div key={t.id} className="mono" style={{
          display: 'flex', alignItems: 'center', gap: 9, padding: '10px 14px', borderRadius: 8,
          background: 'var(--bg-1)', border: '1px solid var(--line-strong)', boxShadow: 'var(--shadow-lg)',
          fontSize: 12, color: 'var(--fg-1)', animation: 'fadeUp 160ms ease',
        }}>
          <span style={{ color: TONE[t.tone].fg, display: 'flex' }}><I.CheckCircle size={14} /></span>{t.msg}
        </div>
      ))}
    </div>
  );
}

/* ===== form primitives ===== */
function FRow({ label, hint, children, error }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 5 }}>
        <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>{label}</span>
        {hint && <span className="mono" style={{ fontSize: 10, color: 'var(--fg-4)' }}>{hint}</span>}
        {error && <span className="mono" style={{ fontSize: 10, color: 'var(--accent-danger)', marginLeft: 'auto' }}>{error}</span>}
      </div>
      {children}
    </label>
  );
}
const fieldStyle = {
  width: '100%', padding: '9px 11px', borderRadius: 7, background: 'var(--bg-input)',
  border: '1px solid var(--line)', color: 'var(--fg)', fontSize: 13, outline: 'none',
  fontFamily: 'var(--font-mono)', transition: 'border-color 120ms, box-shadow 120ms',
};
function FText({ value, onChange, placeholder, type = 'text', mono = true, invalid }) {
  return <input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
    style={{ ...fieldStyle, borderColor: invalid ? 'var(--accent-danger)' : 'var(--line)', fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)' }}
    onFocus={(e) => { if (!invalid) { e.target.style.borderColor = 'var(--accent)'; e.target.style.boxShadow = '0 0 0 3px var(--accent-soft)'; } }}
    onBlur={(e) => { e.target.style.borderColor = invalid ? 'var(--accent-danger)' : 'var(--line)'; e.target.style.boxShadow = 'none'; }} />;
}
function FSelect({ value, onChange, options }) {
  return <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...fieldStyle, cursor: 'pointer' }}>
    {options.map(o => { const v = o.value ?? o, l = o.label ?? o; return <option key={v} value={v}>{l}</option>; })}
  </select>;
}
function FNumber({ value, onChange, min = 0 }) {
  return <input type="number" value={value} min={min} onChange={(e) => onChange(Number(e.target.value))} style={fieldStyle}
    onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; e.target.style.boxShadow = '0 0 0 3px var(--accent-soft)'; }}
    onBlur={(e) => { e.target.style.borderColor = 'var(--line)'; e.target.style.boxShadow = 'none'; }} />;
}
function FToggle({ value, onChange, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px', borderRadius: 7, background: 'var(--bg-input)', border: '1px solid var(--line)' }}>
      <Toggle size="sm" on={value} onChange={onChange} />
      <span style={{ fontSize: 12.5, color: 'var(--fg-1)' }}>{label}</span>
    </div>
  );
}
function FChips({ values, onChange, placeholder }) {
  const [draft, setDraft] = useMState('');
  const add = () => { const v = draft.trim(); if (v && !values.includes(v)) onChange([...values, v]); setDraft(''); };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 9px', borderRadius: 7, background: 'var(--bg-input)', border: '1px solid var(--line)' }}>
      {values.map(v => (
        <span key={v} className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 6px 3px 8px', borderRadius: 4, background: 'var(--bg-2)', border: '1px solid var(--line)', fontSize: 11.5, color: 'var(--fg-1)' }}>
          {v}<button onClick={() => onChange(values.filter(x => x !== v))} style={{ display: 'flex', color: 'var(--fg-3)' }}><I.X size={11} /></button>
        </span>
      ))}
      <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={values.length ? '' : placeholder}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }} onBlur={add}
        className="mono" style={{ flex: 1, minWidth: 80, background: 'transparent', border: 0, outline: 'none', color: 'var(--fg)', fontSize: 12 }} />
    </div>
  );
}

/* ordered provider-chain picker */
function ChainPicker({ chain, onChange }) {
  const { PROVIDERS } = window.NM_DATA;
  const avail = PROVIDERS.filter(p => !chain.includes(p.id));
  const name = (id) => (PROVIDERS.find(p => p.id === id) || {}).name || id;
  const move = (i, d) => { const n = [...chain]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; onChange(n); };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {chain.length === 0 && <div className="mono" style={{ fontSize: 11.5, color: 'var(--fg-4)', fontStyle: 'italic', padding: '4px 2px' }}>no providers — add at least one below</div>}
        {chain.map((id, i) => (
          <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderRadius: 6, background: 'var(--bg-2)', border: '1px solid var(--line)' }}>
            <span className="mono" style={{ fontSize: 10.5, color: i === 0 ? 'var(--accent)' : 'var(--fg-4)', width: 50 }}>{i === 0 ? 'primary' : `fb ${i}`}</span>
            <span style={{ flex: 1, fontSize: 12.5, color: 'var(--fg-1)' }}>{name(id)}</span>
            <IconBtn size={22} title="up" onClick={() => move(i, -1)}><I.ArrowUp size={12} /></IconBtn>
            <IconBtn size={22} title="down" onClick={() => move(i, 1)}><I.ArrowDown size={12} /></IconBtn>
            <IconBtn size={22} title="remove" onClick={() => onChange(chain.filter(x => x !== id))}><I.X size={12} /></IconBtn>
          </div>
        ))}
      </div>
      {avail.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {avail.map(p => (
            <button key={p.id} onClick={() => onChange([...chain, p.id])} className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 8px', borderRadius: 5, background: 'var(--bg-input)', border: '1px dashed var(--line-strong)', color: 'var(--fg-2)', fontSize: 11.5 }}>
              <I.Plus size={11} />{p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ===== modal shell ===== */
function ModalShell({ eyebrow, title, icon, onClose, children, footer, width = 480 }) {
  useMEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 150, background: 'oklch(0 0 0 / 0.6)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '9vh', overflowY: 'auto' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width, maxWidth: '94vw', marginBottom: 40, background: 'var(--bg-1)', border: '1px solid var(--line-strong)', borderRadius: 12, boxShadow: 'var(--shadow-lg)', animation: 'fadeUp 150ms ease' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '15px 18px', borderBottom: '1px solid var(--line)' }}>
          <span style={{ color: 'var(--accent)', display: 'flex' }}>{icon}</span>
          <div style={{ flex: 1 }}>
            {eyebrow && <div className="mono" style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--fg-4)' }}>{eyebrow}</div>}
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 600, color: 'var(--fg)' }}>{title}</div>
          </div>
          <IconBtn title="Close (esc)" onClick={onClose}><I.X size={15} /></IconBtn>
        </div>
        <div style={{ padding: '18px' }}>{children}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, padding: '13px 18px', borderTop: '1px solid var(--line)', background: 'var(--bg)' }}>{footer}</div>
      </div>
    </div>
  );
}

const AUTH_BY_TYPE = { ses: ['AWS-SIGV4'], m365: ['XOAUTH2'], gmail: ['XOAUTH2'], smtp: ['PLAIN', 'LOGIN', 'NONE'] };

/* ===== resource forms ===== */
function ProviderForm({ item, onClose }) {
  const create = !item;
  const [f, setF] = useMState(item ? { ...item } : { name: '', type: 'ses', endpoint: '', auth_mode: 'AWS-SIGV4', secret_ref: '', enabled: true });
  const [tried, setTried] = useMState(false);
  const up = (k, v) => setF(s => ({ ...s, [k]: v }));
  const invalid = { name: !f.name.trim(), endpoint: !f.endpoint.trim() };
  const save = async () => {
    setTried(true);
    if (invalid.name || invalid.endpoint) return;
    try { await window.Store.save('providers', f, item); window.nmToast(create ? 'Provider created' : 'Provider updated'); onClose(); }
    catch (e) { window.nmToast(String(e.message || e), 'danger'); }
  };
  return (
    <ModalShell eyebrow="provider" title={create ? 'New provider' : 'Edit provider'} icon={<I.Server size={17} />} onClose={onClose} width={500}
      footer={<><Btn onClick={onClose}>cancel</Btn><Btn kind="primary" icon={<I.Check size={13} />} onClick={save}>{create ? 'create provider' : 'save changes'}</Btn></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <FRow label="name" error={tried && invalid.name ? 'required' : null}><FText value={f.name} onChange={v => up('name', v)} placeholder="SES · us-east-1" mono={false} invalid={tried && invalid.name} /></FRow>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <FRow label="type"><FSelect value={f.type} onChange={v => { up('type', v); up('auth_mode', AUTH_BY_TYPE[v][0]); }} options={Object.keys(AUTH_BY_TYPE).map(t => ({ value: t, label: window.NM_DATA.PROVIDER_TYPE_LABEL[t] }))} /></FRow>
          <FRow label="auth mode"><FSelect value={f.auth_mode} onChange={v => up('auth_mode', v)} options={AUTH_BY_TYPE[f.type]} /></FRow>
        </div>
        <FRow label="endpoint" hint="host:port" error={tried && invalid.endpoint ? 'required' : null}><FText value={f.endpoint} onChange={v => up('endpoint', v)} placeholder="email-smtp.us-east-1.amazonaws.com:587" invalid={tried && invalid.endpoint} /></FRow>
        <FRow label="secret ref" hint="envelope-encrypted credential"><FText value={f.secret_ref} onChange={v => up('secret_ref', v)} placeholder="sec/ses-use1" /></FRow>
        <FToggle value={f.enabled} onChange={v => up('enabled', v)} label="Enabled — eligible for routing" />
      </div>
    </ModalShell>
  );
}

function RuleForm({ item, onClose }) {
  const create = !item;
  const [f, setF] = useMState(item ? { ...item, provider_chain: [...item.provider_chain] } : { recipient_domain: '', sender_domain: '*', provider_chain: [], priority: 100, enabled: true });
  const [tried, setTried] = useMState(false);
  const up = (k, v) => setF(s => ({ ...s, [k]: v }));
  const invalid = { recipient: !f.recipient_domain.trim(), sender: !f.sender_domain.trim(), chain: f.provider_chain.length === 0 };
  const save = async () => {
    setTried(true);
    if (invalid.recipient || invalid.sender || invalid.chain) return;
    try { await window.Store.save('rules', f, item); window.nmToast(create ? 'Routing rule created' : 'Routing rule updated'); onClose(); }
    catch (e) { window.nmToast(String(e.message || e), 'danger'); }
  };
  return (
    <ModalShell eyebrow="routing" title={create ? 'New routing rule' : 'Edit routing rule'} icon={<I.Route size={17} />} onClose={onClose} width={520}
      footer={<><Btn onClick={onClose}>cancel</Btn><Btn kind="primary" icon={<I.Check size={13} />} onClick={save}>{create ? 'create rule' : 'save changes'}</Btn></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <FRow label="recipient domain" hint="* = any" error={tried && invalid.recipient ? 'required' : null}><FText value={f.recipient_domain} onChange={v => up('recipient_domain', v)} placeholder="gmail.com" invalid={tried && invalid.recipient} /></FRow>
          <FRow label="sender domain" hint="* = any" error={tried && invalid.sender ? 'required' : null}><FText value={f.sender_domain} onChange={v => up('sender_domain', v)} placeholder="*" invalid={tried && invalid.sender} /></FRow>
        </div>
        <FRow label="priority" hint="lower runs first"><FNumber value={f.priority} onChange={v => up('priority', v)} /></FRow>
        <FRow label="provider chain" hint="primary, then failover order" error={tried && invalid.chain ? 'add ≥1' : null}><ChainPicker chain={f.provider_chain} onChange={v => up('provider_chain', v)} /></FRow>
        <FToggle value={f.enabled} onChange={v => up('enabled', v)} label="Enabled" />
      </div>
    </ModalShell>
  );
}

function DomainForm({ item, onClose }) {
  const create = !item;
  const [f, setF] = useMState(item ? { ...item } : { domain: '', dkim_selector: 'nova2026', dkim: 'pending', verified: false, messages24h: 0 });
  const [tried, setTried] = useMState(false);
  const up = (k, v) => setF(s => ({ ...s, [k]: v }));
  const invalid = { domain: !f.domain.trim(), sel: !f.dkim_selector.trim() };
  const save = async () => {
    setTried(true);
    if (invalid.domain || invalid.sel) return;
    try { await window.Store.save('domains', f, item); window.nmToast(create ? 'Relay domain added' : 'Relay domain updated'); onClose(); }
    catch (e) { window.nmToast(String(e.message || e), 'danger'); }
  };
  return (
    <ModalShell eyebrow="routing" title={create ? 'Add relay domain' : 'Edit relay domain'} icon={<I.Globe size={17} />} onClose={onClose}
      footer={<><Btn onClick={onClose}>cancel</Btn><Btn kind="primary" icon={<I.Check size={13} />} onClick={save}>{create ? 'add domain' : 'save changes'}</Btn></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <FRow label="domain" error={tried && invalid.domain ? 'required' : null}><FText value={f.domain} onChange={v => up('domain', v)} placeholder="mail.watteel.com" invalid={tried && invalid.domain} /></FRow>
        <FRow label="DKIM selector" hint="<selector>._domainkey" error={tried && invalid.sel ? 'required' : null}><FText value={f.dkim_selector} onChange={v => up('dkim_selector', v)} placeholder="nova2026" invalid={tried && invalid.sel} /></FRow>
        <FRow label="DKIM status"><FSelect value={f.dkim} onChange={v => up('dkim', v)} options={['pending', 'active']} /></FRow>
        <FToggle value={f.verified} onChange={v => up('verified', v)} label="DNS verified" />
      </div>
    </ModalShell>
  );
}

const SCOPES_IN = [{ value: 'account', label: 'account (username key)' }, { value: 'ip', label: 'source IP/CIDR' }, { value: 'global', label: 'global (all inbound)' }];
const SCOPES_OUT = [{ value: 'recipient_domain', label: 'recipient domain' }, { value: 'provider', label: 'provider name' }, { value: 'global', label: 'global (all outbound)' }];
function RateLimitForm({ item, preset, onClose }) {
  const create = !item;
  const base = preset || {};
  const [f, setF] = useMState(item
    ? { ...item, scope_value: item.domain === '*' ? '' : item.domain }
    : { direction: base.direction || 'out', scope: base.scope || 'recipient_domain', domain: '', per_second: 25, burst: 80, enabled: true });
  const [tried, setTried] = useMState(false);
  const up = (k, v) => setF(s => ({ ...s, [k]: v }));
  const isGlobal = f.scope === 'global';
  const invalid = { domain: !isGlobal && !(f.domain || '').trim() };
  const save = async () => {
    setTried(true);
    if (invalid.domain) return;
    const payload = { ...f, domain: isGlobal ? '*' : f.domain };
    try { await window.Store.save('ratelimits', payload, item); window.nmToast(create ? 'Rate limit created' : 'Rate limit updated'); onClose(); }
    catch (e) { window.nmToast(String(e.message || e), 'danger'); }
  };
  const inbound = f.direction === 'in';
  const keyHint = { account: 'account username', ip: 'CIDR e.g. 10.0.0.0/8', recipient_domain: 'gmail.com', provider: 'provider name', global: 'n/a' }[f.scope];
  return (
    <ModalShell eyebrow={inbound ? 'incoming' : 'outgoing'} title={create ? 'New rate limit' : 'Edit rate limit'} icon={<I.Gauge size={17} />} onClose={onClose}
      footer={<><Btn onClick={onClose}>cancel</Btn><Btn kind="primary" icon={<I.Check size={13} />} onClick={save}>{create ? 'create limit' : 'save changes'}</Btn></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <FRow label="direction"><FSelect value={f.direction} onChange={v => { up('direction', v); up('scope', v === 'in' ? 'account' : 'recipient_domain'); }} options={[{ value: 'in', label: 'inbound (submit)' }, { value: 'out', label: 'outbound (deliver)' }]} /></FRow>
          <FRow label="scope"><FSelect value={f.scope} onChange={v => up('scope', v)} options={inbound ? SCOPES_IN : SCOPES_OUT} /></FRow>
        </div>
        {!isGlobal && <FRow label="key" hint={keyHint} error={tried && invalid.domain ? 'required' : null}><FText value={f.domain} onChange={v => up('domain', v)} placeholder={keyHint} invalid={tried && invalid.domain} /></FRow>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <FRow label="per second" hint="sustained rate"><FNumber value={f.per_second} onChange={v => up('per_second', v)} min={0} /></FRow>
          <FRow label="burst" hint="bucket size"><FNumber value={f.burst} onChange={v => up('burst', v)} min={1} /></FRow>
        </div>
        <FToggle value={f.enabled} onChange={v => up('enabled', v)} label="Enabled" />
      </div>
    </ModalShell>
  );
}

/* ---- Relay client (trusted IP/CIDR) ---- */
function RelayClientForm({ item, onClose }) {
  const create = !item;
  const [f, setF] = useMState(item ? { ...item, allowed_sender_domains: [...item.allowed_sender_domains] } : { cidr: '', description: '', allowed_sender_domains: [], enabled: true });
  const [tried, setTried] = useMState(false);
  const up = (k, v) => setF(s => ({ ...s, [k]: v }));
  const invalid = { cidr: !(f.cidr || '').trim() };
  const save = async () => {
    setTried(true);
    if (invalid.cidr) return;
    try { await window.Store.save('relayclients', f, item); window.nmToast(create ? 'Relay client added' : 'Relay client updated'); onClose(); }
    catch (e) { window.nmToast(String(e.message || e), 'danger'); }
  };
  return (
    <ModalShell eyebrow="incoming" title={create ? 'Add relay client' : 'Edit relay client'} icon={<I.Globe size={17} />} onClose={onClose} width={500}
      footer={<><Btn onClick={onClose}>cancel</Btn><Btn kind="primary" icon={<I.Check size={13} />} onClick={save}>{create ? 'add range' : 'save changes'}</Btn></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <FRow label="source range (CIDR)" hint="hosts here relay without AUTH" error={tried && invalid.cidr ? 'required' : null}><FText value={f.cidr} onChange={v => up('cidr', v)} placeholder="10.0.0.0/24 or 203.0.113.5/32" invalid={tried && invalid.cidr} /></FRow>
        <FRow label="description"><FText value={f.description} onChange={v => up('description', v)} placeholder="app servers" mono={false} /></FRow>
        <FRow label="allowed sender domains" hint="empty = any · enter to add"><FChips values={f.allowed_sender_domains} onChange={v => up('allowed_sender_domains', v)} placeholder="watteel.com" /></FRow>
        <FToggle value={f.enabled} onChange={v => up('enabled', v)} label="Enabled" />
      </div>
    </ModalShell>
  );
}

/* ---- Suppression (manual add) ---- */
function SuppressionForm({ onClose }) {
  const [f, setF] = useMState({ address: '', reason: 'manual' });
  const [tried, setTried] = useMState(false);
  const up = (k, v) => setF(s => ({ ...s, [k]: v }));
  const invalid = { address: !/.+@.+/.test(f.address) };
  const save = async () => {
    setTried(true);
    if (invalid.address) return;
    try { await window.Store.save('suppressions', f); window.nmToast('Address suppressed'); onClose(); }
    catch (e) { window.nmToast(String(e.message || e), 'danger'); }
  };
  return (
    <ModalShell eyebrow="observe" title="Suppress address" icon={<I.Ban size={17} />} onClose={onClose} width={440}
      footer={<><Btn onClick={onClose}>cancel</Btn><Btn danger icon={<I.Check size={13} />} onClick={save}>suppress</Btn></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <FRow label="address" error={tried && invalid.address ? 'valid email required' : null}><FText value={f.address} onChange={v => up('address', v)} placeholder="bounced@example.com" invalid={tried && invalid.address} /></FRow>
        <FRow label="reason"><FSelect value={f.reason} onChange={v => up('reason', v)} options={['manual', 'hard_bounce', 'complaint']} /></FRow>
      </div>
    </ModalShell>
  );
}

/* ---- Operator ---- */
function OperatorForm({ onClose }) {
  const [f, setF] = useMState({ username: '', password: '', role: 'admin' });
  const [tried, setTried] = useMState(false);
  const up = (k, v) => setF(s => ({ ...s, [k]: v }));
  const invalid = { username: !/.+@.+/.test(f.username), pass: f.password.length < 8 };
  const save = async () => {
    setTried(true);
    if (invalid.username || invalid.pass) return;
    try { await window.Store.save('operators', f); window.nmToast('Operator created'); onClose(); }
    catch (e) { window.nmToast(String(e.message || e), 'danger'); }
  };
  return (
    <ModalShell eyebrow="observe" title="New operator" icon={<I.Users size={17} />} onClose={onClose} width={440}
      footer={<><Btn onClick={onClose}>cancel</Btn><Btn kind="primary" icon={<I.Check size={13} />} onClick={save}>create operator</Btn></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <FRow label="email" error={tried && invalid.username ? 'valid email required' : null}><FText value={f.username} onChange={v => up('username', v)} placeholder="ops@watteel.com" invalid={tried && invalid.username} /></FRow>
        <FRow label="password" hint="min 8 characters" error={tried && invalid.pass ? 'too short' : null}><FText type="password" value={f.password} onChange={v => up('password', v)} placeholder="••••••••••••" invalid={tried && invalid.pass} /></FRow>
        <FRow label="role" hint="admin = read/write · user = read-only"><FSelect value={f.role} onChange={v => up('role', v)} options={['admin', 'user']} /></FRow>
      </div>
    </ModalShell>
  );
}

/* ---- DKIM key generation ---- */
function DKIMGen({ onClose }) {
  const [f, setF] = useMState({ domain: '', selector: 'nova' + new Date().getFullYear() });
  const [tried, setTried] = useMState(false);
  const [dns, setDns] = useMState(null);
  const [busy, setBusy] = useMState(false);
  const up = (k, v) => setF(s => ({ ...s, [k]: v }));
  const invalid = { domain: !f.domain.trim(), selector: !f.selector.trim() };
  const gen = async () => {
    setTried(true);
    if (invalid.domain || invalid.selector) return;
    setBusy(true);
    try { const res = await window.Store.generateDKIM(f.domain, f.selector); setDns(res.dns); window.nmToast('DKIM key generated'); }
    catch (e) { window.nmToast(String(e.message || e), 'danger'); }
    finally { setBusy(false); }
  };
  return (
    <ModalShell eyebrow="outgoing" title="Generate DKIM key" icon={<I.Shield size={17} />} onClose={onClose} width={560}
      footer={dns ? <Btn kind="primary" onClick={onClose}>done</Btn> : <><Btn onClick={onClose}>cancel</Btn><Btn kind="primary" icon={<I.Shield size={13} />} onClick={gen}>{busy ? 'generating…' : 'generate'}</Btn></>}>
      {!dns ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <FRow label="domain" error={tried && invalid.domain ? 'required' : null}><FText value={f.domain} onChange={v => up('domain', v)} placeholder="watteel.com" invalid={tried && invalid.domain} /></FRow>
          <FRow label="selector" hint="<selector>._domainkey" error={tried && invalid.selector ? 'required' : null}><FText value={f.selector} onChange={v => up('selector', v)} invalid={tried && invalid.selector} /></FRow>
          <div className="mono" style={{ fontSize: 11, color: 'var(--fg-4)', lineHeight: 1.5 }}>An RSA-2048 keypair is minted; the private key is envelope-encrypted and the prior active selector for this domain is retired.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12.5, color: 'var(--fg-1)' }}>Publish this DNS TXT record, then delivery will sign with the new key:</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-4)' }}>{dns.name}　(TXT)</span>
            <textarea readOnly value={dns.value} style={{ ...fieldStyle, minHeight: 96, resize: 'vertical', fontSize: 11 }} onFocus={(e) => e.target.select()} />
          </div>
          <Btn size="sm" icon={<I.Copy size={12} />} onClick={() => { navigator.clipboard?.writeText(dns.value); window.nmToast('Copied'); }}>copy value</Btn>
        </div>
      )}
    </ModalShell>
  );
}

function AccountForm({ item, onClose }) {
  const create = !item;
  const [f, setF] = useMState(item ? { ...item, password: '', allowed_sender_domains: [...item.allowed_sender_domains], ip_allowlist: [...(item.ip_allowlist || [])] } : { username: '', password: '', allowed_sender_domains: [], ip_allowlist: [], enabled: true });
  const [tried, setTried] = useMState(false);
  const up = (k, v) => setF(s => ({ ...s, [k]: v }));
  const invalid = { username: !f.username.trim(), pass: create && !f.password };
  const save = async () => {
    setTried(true);
    if (invalid.username || invalid.pass) return;
    try { await window.Store.save('accounts', f, item); window.nmToast(create ? 'Account created' : 'Account updated'); onClose(); }
    catch (e) { window.nmToast(String(e.message || e), 'danger'); }
  };
  return (
    <ModalShell eyebrow="access" title={create ? 'New account' : 'Edit account'} icon={<I.Key size={17} />} onClose={onClose}
      footer={<><Btn onClick={onClose}>cancel</Btn><Btn kind="primary" icon={<I.Check size={13} />} onClick={save}>{create ? 'create account' : 'save changes'}</Btn></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <FRow label="username" error={tried && invalid.username ? 'required' : null}><FText value={f.username} onChange={v => up('username', v)} placeholder="app@watteel.com" invalid={tried && invalid.username} /></FRow>
        <FRow label="password" hint={create ? 'envelope-encrypted at rest' : 'leave blank to keep current'} error={tried && invalid.pass ? 'required' : null}><FText type="password" value={f.password} onChange={v => up('password', v)} placeholder="••••••••••••" invalid={tried && invalid.pass} /></FRow>
        <FRow label="allowed sender domains" hint="enter to add"><FChips values={f.allowed_sender_domains} onChange={v => up('allowed_sender_domains', v)} placeholder="watteel.com" /></FRow>
        <FRow label="source IP allowlist" hint="empty = any · CIDR, enter to add"><FChips values={f.ip_allowlist} onChange={v => up('ip_allowlist', v)} placeholder="10.0.0.0/8" /></FRow>
        <FToggle value={f.enabled} onChange={v => up('enabled', v)} label="Enabled — may authenticate & submit" />
      </div>
    </ModalShell>
  );
}

function ConfirmDelete({ coll, item, onClose }) {
  const meta = COLL[coll];
  const name = item[meta.pk];
  const del = async () => {
    try { await window.Store.remove(coll, item); window.nmToast(`${meta.label} deleted`, 'danger'); onClose(); }
    catch (e) { window.nmToast(String(e.message || e), 'danger'); }
  };
  return (
    <ModalShell eyebrow="confirm" title={`Delete ${meta.label}`} icon={<I.AlertTriangle size={17} />} onClose={onClose} width={420}
      footer={<><Btn onClick={onClose}>cancel</Btn><Btn danger icon={<I.Trash size={13} />} onClick={del}>delete</Btn></>}>
      <div style={{ fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.6 }}>
        Permanently delete <span className="mono" style={{ color: 'var(--accent)' }}>{name}</span>? This change hot-reloads to the data plane immediately and cannot be undone.
      </div>
    </ModalShell>
  );
}

/* ---- Profile (read-only) ---- */
function ProfileModal({ onClose }) {
  const op = window.NM_DATA.OPERATOR || {};
  const Row = ({ label, value }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 0', borderBottom: '1px solid var(--line)' }}>
      <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>{label}</span>
      <span className="mono" style={{ fontSize: 12.5, color: 'var(--fg-1)' }}>{value || '—'}</span>
    </div>
  );
  return (
    <ModalShell eyebrow="account" title="Profile" icon={<I.Users size={17} />} onClose={onClose} width={420}
      footer={<><Btn onClick={onClose}>close</Btn><Btn kind="primary" icon={<I.Lock size={13} />} onClick={() => { onClose(); window.nmModal({ kind: 'password' }); }}>change password</Btn></>}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <Row label="operator" value={op.username} />
        <Row label="role" value={op.role} />
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--fg-4)', marginTop: 12, lineHeight: 1.5 }}>Management-plane login (distinct from SMTP submission accounts). Every config change you make is recorded in the audit log under this name.</div>
      </div>
    </ModalShell>
  );
}

/* ---- Change password ---- */
function ChangePasswordModal({ onClose }) {
  const [f, setF] = useMState({ current: '', next: '', confirm: '' });
  const [tried, setTried] = useMState(false);
  const [busy, setBusy] = useMState(false);
  const up = (k, v) => setF(s => ({ ...s, [k]: v }));
  const invalid = { current: !f.current, next: f.next.length < 8, confirm: f.confirm !== f.next };
  const save = async () => {
    setTried(true);
    if (invalid.current || invalid.next || invalid.confirm) return;
    setBusy(true);
    try { await window.Store.changePassword(f.current, f.next); window.nmToast('Password changed'); onClose(); }
    catch (e) { window.nmToast(String(e.message || e).replace(/^\d+\s*/, ''), 'danger'); }
    finally { setBusy(false); }
  };
  return (
    <ModalShell eyebrow="account" title="Change password" icon={<I.Lock size={17} />} onClose={onClose} width={420}
      footer={<><Btn onClick={onClose}>cancel</Btn><Btn kind="primary" icon={<I.Check size={13} />} onClick={save}>{busy ? 'saving…' : 'update password'}</Btn></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <FRow label="current password" error={tried && invalid.current ? 'required' : null}><FText type="password" value={f.current} onChange={v => up('current', v)} placeholder="••••••••••••" invalid={tried && invalid.current} /></FRow>
        <FRow label="new password" hint="min 8 characters" error={tried && invalid.next ? 'too short' : null}><FText type="password" value={f.next} onChange={v => up('next', v)} placeholder="••••••••••••" invalid={tried && invalid.next} /></FRow>
        <FRow label="confirm new password" error={tried && invalid.confirm ? 'does not match' : null}><FText type="password" value={f.confirm} onChange={v => up('confirm', v)} placeholder="••••••••••••" invalid={tried && invalid.confirm} /></FRow>
      </div>
    </ModalShell>
  );
}

/* ===== modal host ===== */
const FORMS = { providers: ProviderForm, rules: RuleForm, domains: DomainForm, ratelimits: RateLimitForm, accounts: AccountForm, relayclients: RelayClientForm, suppressions: SuppressionForm, operators: OperatorForm };
function ModalHost() {
  const [modal, setModal] = useMState(null);
  useMEffect(() => {
    window.nmModal = (cfg) => setModal(cfg);
    window.nmCloseModal = () => setModal(null);
  }, []);
  if (!modal) return null;
  const close = () => setModal(null);
  if (modal.kind === 'confirm') return <ConfirmDelete coll={modal.coll} item={modal.item} onClose={close} />;
  if (modal.kind === 'dkimgen') return <DKIMGen onClose={close} />;
  if (modal.kind === 'profile') return <ProfileModal onClose={close} />;
  if (modal.kind === 'password') return <ChangePasswordModal onClose={close} />;
  const Form = FORMS[modal.coll];
  return Form ? <Form item={modal.item} preset={modal.preset} onClose={close} /> : null;
}

Object.assign(window, { ModalHost, ToastHost, useDataVersion, bumpData });
