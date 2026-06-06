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
  providers:  { arr: 'PROVIDERS',     pk: 'id',     label: 'provider' },
  rules:      { arr: 'ROUTING_RULES', pk: 'id',     label: 'routing rule' },
  domains:    { arr: 'RELAY_DOMAINS', pk: 'domain', label: 'relay domain' },
  ratelimits: { arr: 'RATE_LIMITS',   pk: 'domain', label: 'rate limit' },
  accounts:   { arr: 'ACCOUNTS',      pk: 'id',     label: 'account' },
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

function RateLimitForm({ item, onClose }) {
  const create = !item;
  const [f, setF] = useMState(item ? { ...item } : { domain: '', per_second: 25, burst: 80, enabled: true, usage: 0 });
  const [tried, setTried] = useMState(false);
  const up = (k, v) => setF(s => ({ ...s, [k]: v }));
  const invalid = { domain: !f.domain.trim() };
  const save = async () => {
    setTried(true);
    if (invalid.domain) return;
    try { await window.Store.save('ratelimits', f, item); window.nmToast(create ? 'Rate limit created' : 'Rate limit updated'); onClose(); }
    catch (e) { window.nmToast(String(e.message || e), 'danger'); }
  };
  return (
    <ModalShell eyebrow="routing" title={create ? 'New rate limit' : 'Edit rate limit'} icon={<I.Gauge size={17} />} onClose={onClose}
      footer={<><Btn onClick={onClose}>cancel</Btn><Btn kind="primary" icon={<I.Check size={13} />} onClick={save}>{create ? 'create limit' : 'save changes'}</Btn></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <FRow label="recipient domain" hint="* = default bucket" error={tried && invalid.domain ? 'required' : null}><FText value={f.domain} onChange={v => up('domain', v)} placeholder="gmail.com" invalid={tried && invalid.domain} /></FRow>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <FRow label="per second" hint="sustained rate"><FNumber value={f.per_second} onChange={v => up('per_second', v)} min={1} /></FRow>
          <FRow label="burst" hint="bucket size"><FNumber value={f.burst} onChange={v => up('burst', v)} min={1} /></FRow>
        </div>
        <FToggle value={f.enabled} onChange={v => up('enabled', v)} label="Enabled" />
      </div>
    </ModalShell>
  );
}

function AccountForm({ item, onClose }) {
  const create = !item;
  const [f, setF] = useMState(item ? { ...item, password: '', allowed_sender_domains: [...item.allowed_sender_domains] } : { username: '', password: '', allowed_sender_domains: [], enabled: true });
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

/* ===== modal host ===== */
const FORMS = { providers: ProviderForm, rules: RuleForm, domains: DomainForm, ratelimits: RateLimitForm, accounts: AccountForm };
function ModalHost() {
  const [modal, setModal] = useMState(null);
  useMEffect(() => {
    window.nmModal = (cfg) => setModal(cfg);
    window.nmCloseModal = () => setModal(null);
  }, []);
  if (!modal) return null;
  const close = () => setModal(null);
  if (modal.kind === 'confirm') return <ConfirmDelete coll={modal.coll} item={modal.item} onClose={close} />;
  const Form = FORMS[modal.coll];
  return Form ? <Form item={modal.item} onClose={close} /> : null;
}

Object.assign(window, { ModalHost, ToastHost, useDataVersion, bumpData });
