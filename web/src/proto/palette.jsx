/* global React, I */
/* NovaMail command palette — ⌘K navigate + actions + message search */
const { useState: usePalState, useEffect: usePalEffect, useRef: usePalRef } = React;

function CommandPalette({ open, onClose, onNavigate, onOpenMessage }) {
  const { MESSAGES } = window.NM_DATA;
  const [q, setQ] = usePalState('');
  const [sel, setSel] = usePalState(0);
  const inputRef = usePalRef(null);

  const NAV = [
    { id: 'dashboard', label: 'Go to Dashboard', icon: <I.Activity size={15} />, kbd: 'G D' },
    { id: 'messages', label: 'Go to Messages', icon: <I.Mail size={15} />, kbd: 'G M' },
    { id: 'queue', label: 'Go to Queue monitor', icon: <I.Layers size={15} />, kbd: 'G Q' },
    { id: 'providers', label: 'Go to Providers', icon: <I.Server size={15} /> },
    { id: 'rules', label: 'Go to Routing rules', icon: <I.Route size={15} /> },
    { id: 'domains', label: 'Go to Relay domains', icon: <I.Globe size={15} /> },
    { id: 'ratelimits', label: 'Go to Rate limits', icon: <I.Gauge size={15} /> },
    { id: 'accounts', label: 'Go to Accounts', icon: <I.Key size={15} /> },
    { id: 'settings', label: 'Go to Settings', icon: <I.Settings size={15} /> },
  ];
  const ACTIONS = [
    { id: 'a_provider', label: 'New provider', icon: <I.Plus size={15} />, nav: 'providers', coll: 'providers' },
    { id: 'a_rule', label: 'New routing rule', icon: <I.Plus size={15} />, nav: 'rules', coll: 'rules' },
    { id: 'a_domain', label: 'Add relay domain', icon: <I.Plus size={15} />, nav: 'domains', coll: 'domains' },
    { id: 'a_account', label: 'New account', icon: <I.Plus size={15} />, nav: 'accounts', coll: 'accounts' },
    { id: 'a_purge', label: 'Purge dead-letter queue', icon: <I.Trash size={15} />, nav: 'queue' },
  ];

  usePalEffect(() => { if (open) { setQ(''); setSel(0); setTimeout(() => inputRef.current && inputRef.current.focus(), 30); } }, [open]);

  const s = q.toLowerCase().trim();
  const nav = NAV.filter(n => !s || n.label.toLowerCase().includes(s));
  const actions = ACTIONS.filter(a => !s || a.label.toLowerCase().includes(s));
  const msgs = s ? MESSAGES.filter(m => m.subject.toLowerCase().includes(s) || m.mail_from.toLowerCase().includes(s) || m.rcpt_to.join(' ').toLowerCase().includes(s) || m.id.toLowerCase().includes(s)).slice(0, 5) : [];

  const flat = [
    ...nav.map(n => ({ type: 'nav', item: n })),
    ...actions.map(a => ({ type: 'action', item: a })),
    ...msgs.map(m => ({ type: 'msg', item: m })),
  ];

  usePalEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel(x => Math.min(flat.length - 1, x + 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel(x => Math.max(0, x - 1)); }
      if (e.key === 'Enter') { e.preventDefault(); run(flat[sel]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, flat, sel]);

  function run(entry) {
    if (!entry) return;
    if (entry.type === 'msg') { onOpenMessage(entry.item.id); }
    else if (entry.type === 'action') {
      onNavigate(entry.item.nav);
      if (entry.item.coll) setTimeout(() => window.nmModal({ coll: entry.item.coll, mode: 'create' }), 60);
      else if (entry.item.id === 'a_purge') setTimeout(() => window.nmToast && window.nmToast('Dead-letter queue purged', 'danger'), 60);
    }
    else { onNavigate(entry.item.id); }
    onClose();
  }

  if (!open) return null;

  const Section = ({ label, children }) => (
    <div style={{ padding: '4px 0' }}>
      <div className="mono" style={{ padding: '6px 16px 4px', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--fg-4)' }}>{label}</div>
      {children}
    </div>
  );

  let idx = -1;
  const Item = ({ entry, icon, label, hint, sub }) => {
    idx++;
    const i = idx;
    const on = i === sel;
    return (
      <button onMouseMove={() => setSel(i)} onClick={() => run(entry)} style={{
        display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'left',
        padding: '8px 16px', background: on ? 'var(--accent-soft)' : 'transparent',
      }}>
        <span style={{ color: on ? 'var(--accent)' : 'var(--fg-3)', display: 'flex' }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, color: on ? 'var(--fg)' : 'var(--fg-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
          {sub && <div className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>}
        </div>
        {hint && <span className="kbd">{hint}</span>}
      </button>
    );
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'oklch(0 0 0 / 0.55)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '13vh' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: '92vw', background: 'var(--bg-1)', border: '1px solid var(--line-strong)', borderRadius: 12, boxShadow: 'var(--shadow-lg)', overflow: 'hidden', animation: 'fadeUp 140ms ease' }}>
        {/* input */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
          <span className="mono" style={{ color: 'var(--accent)', fontSize: 16 }}>{'>'}</span>
          <input ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }} placeholder="search or type a command…"
            className="mono" style={{ flex: 1, background: 'transparent', border: 0, outline: 'none', color: 'var(--fg)', fontSize: 16 }} />
          <span className="kbd">esc</span>
        </div>
        {/* AI hint */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 16px', borderBottom: '1px solid var(--line)', background: 'var(--bg)' }}>
          <I.Sparkle size={12} style={{ color: 'var(--accent)' }} />
          <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>AI search ready · press <span className="kbd">↵</span> to ask about delivery</span>
        </div>
        {/* results */}
        <div style={{ maxHeight: '52vh', overflowY: 'auto', padding: '4px 0' }}>
          {nav.length > 0 && <Section label="Navigate">{nav.map(n => <Item key={n.id} entry={{ type: 'nav', item: n }} icon={n.icon} label={n.label} hint={n.kbd} />)}</Section>}
          {actions.length > 0 && <Section label="Actions">{actions.map(a => <Item key={a.id} entry={{ type: 'action', item: a }} icon={a.icon} label={a.label} />)}</Section>}
          {msgs.length > 0 && <Section label="Messages">{msgs.map(m => <Item key={m.id} entry={{ type: 'msg', item: m }} icon={<I.Mail size={15} />} label={m.subject} sub={`${m.mail_from} → ${m.rcpt_to[0]}`} />)}</Section>}
          {flat.length === 0 && <div className="mono" style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--fg-4)', fontSize: 12 }}>no results for "{q}"</div>}
        </div>
      </div>
    </div>
  );
}

window.CommandPalette = CommandPalette;
