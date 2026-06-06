/* global React, I */
/* NovaMail shared UI primitives */
const { useState: useUiState, useRef: useUiRef, useEffect: useUiEffect } = React;

/* ---- tone mapping for statuses ---- */
const TONE = {
  good:   { fg: 'var(--accent-good)',   soft: 'oklch(0.78 0.16 155 / 0.15)' },
  accent: { fg: 'var(--accent)',        soft: 'var(--accent-soft)' },
  warn:   { fg: 'var(--accent-warn)',   soft: 'oklch(0.82 0.16 75 / 0.15)' },
  danger: { fg: 'var(--accent-danger)', soft: 'oklch(0.7 0.2 25 / 0.15)' },
  muted:  { fg: 'var(--fg-3)',          soft: 'var(--bg-2)' },
  cyan:   { fg: 'var(--accent-2)',      soft: 'oklch(0.78 0.14 200 / 0.15)' },
};

const STATUS_TONE = {
  relayed: 'good', delivered: 'good', healthy: 'good', active: 'good', verified: 'good', running: 'good', enabled: 'good',
  queued: 'accent', signing: 'accent', accepted: 'accent', 'relay-attempt': 'accent',
  deferred: 'warn', throttled: 'warn', pending: 'warn', degraded: 'warn', ttl: 'warn', draining: 'warn',
  bounced: 'danger', failed: 'danger', down: 'danger', dsn: 'danger', rejected: 'danger',
  idle: 'muted', disabled: 'muted',
};
function toneFor(status) { return TONE[STATUS_TONE[status] || 'muted']; }

function StatusBadge({ status, dot }) {
  const t = toneFor(status);
  return (
    <span className="mono" style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '2px 8px', borderRadius: 999, fontSize: 11,
      letterSpacing: '0.04em', textTransform: 'uppercase',
      background: t.soft, color: t.fg, whiteSpace: 'nowrap',
    }}>
      {dot && <span style={{ width: 5, height: 5, borderRadius: '50%', background: t.fg }} />}
      {status}
    </span>
  );
}

function Pill({ tone = 'muted', children, mono = true, style }) {
  const t = TONE[tone] || TONE.muted;
  return (
    <span className={mono ? 'mono' : ''} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '2px 7px', borderRadius: 4, fontSize: 11,
      background: t.soft, color: t.fg, ...style,
    }}>{children}</span>
  );
}

function StatusDot({ status, size = 6, pulse }) {
  const t = toneFor(status);
  return <span className={pulse ? 'pulse' : ''} style={{
    display: 'inline-block', width: size, height: size, borderRadius: '50%',
    background: t.fg, boxShadow: `0 0 0 3px ${t.soft}`,
  }} />;
}

/* ---- Sparkline ---- */
function Sparkline({ data: rawData, w = 120, h = 32, color = 'var(--accent)', fill = true, strokeWidth = 1.5 }) {
  // Sanitize: drop non-finite values so a stray undefined can't NaN the path.
  const data = (rawData || []).map((v) => (Number.isFinite(v) ? v : 0));
  while (data.length < 2) data.push(0);
  const max = Math.max(...data), min = Math.min(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return [x, y];
  });
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${w} ${h} L0 ${h} Z`;
  const gid = 'spk' + Math.round(w * 1000 + data[0]);
  return (
    <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#${gid})`} />}
      <path d={line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.2" fill={color} />
    </svg>
  );
}

/* ---- Toggle ---- */
function Toggle({ on, onChange, size = 'md' }) {
  const w = size === 'sm' ? 30 : 36, h = size === 'sm' ? 17 : 20, k = h - 6;
  return (
    <button onClick={() => onChange && onChange(!on)} style={{
      width: w, height: h, borderRadius: 999, position: 'relative', flexShrink: 0,
      background: on ? 'var(--accent)' : 'var(--bg-3)',
      border: '1px solid', borderColor: on ? 'var(--accent)' : 'var(--line)',
      transition: 'background 140ms, border-color 140ms',
    }}>
      <span style={{
        position: 'absolute', top: 2, left: on ? w - k - 3 : 2, width: k, height: k,
        borderRadius: '50%', background: on ? 'var(--accent-fg)' : 'var(--fg-3)',
        transition: 'left 140ms',
      }} />
    </button>
  );
}

/* ---- Icon button ---- */
function IconBtn({ children, title, onClick, active, size = 28 }) {
  return (
    <button onClick={onClick} title={title}
      style={{
        width: size, height: size, borderRadius: 6, display: 'flex',
        alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        color: active ? 'var(--accent)' : 'var(--fg-3)',
        background: active ? 'var(--accent-soft)' : 'transparent',
        transition: 'background 120ms, color 120ms',
      }}
      onMouseEnter={(e) => { if (!active) { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--fg)'; } }}
      onMouseLeave={(e) => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--fg-3)'; } }}
    >{children}</button>
  );
}

/* ---- Segmented control ---- */
function Segmented({ options, value, onChange, size = 'md' }) {
  return (
    <div style={{
      display: 'inline-flex', gap: 2, padding: 2, borderRadius: 7,
      background: 'var(--bg-2)', border: '1px solid var(--line)',
    }}>
      {options.map((o) => {
        const v = o.value ?? o, label = o.label ?? o;
        const on = v === value;
        return (
          <button key={v} onClick={() => onChange(v)} className="mono" style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: size === 'sm' ? '3px 8px' : '4px 11px', borderRadius: 5,
            fontSize: size === 'sm' ? 11 : 12, letterSpacing: '0.02em',
            background: on ? 'var(--accent-soft)' : 'transparent',
            color: on ? 'var(--accent)' : 'var(--fg-2)',
            transition: 'background 120ms, color 120ms',
          }}>{o.icon}{label}</button>
        );
      })}
    </div>
  );
}

/* ---- Primary / ghost button ---- */
function Btn({ children, onClick, kind = 'ghost', icon, size = 'md', danger, type }) {
  const base = {
    display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'center',
    padding: size === 'sm' ? '5px 10px' : '7px 13px', borderRadius: 6,
    fontFamily: 'var(--font-mono)', fontSize: size === 'sm' ? 11.5 : 12.5,
    letterSpacing: '0.02em', transition: 'background 120ms, border-color 120ms, color 120ms',
    border: '1px solid transparent', whiteSpace: 'nowrap',
  };
  const styles = kind === 'primary'
    ? { ...base, background: 'var(--accent)', color: 'var(--accent-fg)', fontWeight: 600 }
    : danger
    ? { ...base, background: 'transparent', border: '1px solid var(--line)', color: 'var(--accent-danger)' }
    : { ...base, background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--fg-1)' };
  return (
    <button type={type} onClick={onClick} style={styles}
      onMouseEnter={(e) => { if (kind === 'primary') e.currentTarget.style.filter = 'brightness(1.08)'; else { e.currentTarget.style.background = danger ? 'oklch(0.7 0.2 25 / 0.12)' : 'var(--bg-3)'; e.currentTarget.style.borderColor = 'var(--line-strong)'; } }}
      onMouseLeave={(e) => { if (kind === 'primary') e.currentTarget.style.filter = 'none'; else { e.currentTarget.style.background = danger ? 'transparent' : 'var(--bg-2)'; e.currentTarget.style.borderColor = 'var(--line)'; } }}
    >{icon}{children}</button>
  );
}

/* ---- Search field ---- */
function SearchField({ value, onChange, placeholder = 'search…', onSubmit, width }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 7, height: 30, width,
      padding: '0 10px', borderRadius: 7, background: 'var(--bg-input)',
      border: '1px solid var(--line)',
    }}
      onFocusCapture={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 3px var(--accent-soft)'; }}
      onBlurCapture={(e) => { e.currentTarget.style.borderColor = 'var(--line)'; e.currentTarget.style.boxShadow = 'none'; }}
    >
      <I.Search size={13} style={{ color: 'var(--fg-3)' }} />
      <input value={value} onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && onSubmit) onSubmit(); }}
        placeholder={placeholder} className="mono"
        style={{ flex: 1, minWidth: 0, background: 'transparent', border: 0, outline: 'none', color: 'var(--fg)', fontSize: 12.5 }} />
    </div>
  );
}

/* ---- Page header (consistent across screens) ---- */
function PageHeader({ icon, eyebrow, title, count, sub, actions }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '14px 22px',
      borderBottom: '1px solid var(--line)', minHeight: 56, flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
        <span style={{ color: 'var(--accent)', display: 'flex' }}>{icon}</span>
        <div style={{ minWidth: 0 }}>
          {eyebrow && <div className="mono" style={{ fontSize: 10.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--fg-4)' }}>{eyebrow}</div>}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
            <h1 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 19, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--fg)', whiteSpace: 'nowrap' }}>{title}</h1>
            {count != null && <span className="mono" style={{ fontSize: 12, color: 'var(--fg-3)', whiteSpace: 'nowrap' }}>{count}</span>}
          </div>
          {sub && <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{actions}</div>
    </div>
  );
}

/* ---- Card ---- */
function Card({ children, style, hover, onClick, pad = 16 }) {
  const [h, setH] = useUiState(false);
  return (
    <div onClick={onClick}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{
        background: 'var(--bg-1)', border: '1px solid', padding: pad, borderRadius: 10,
        borderColor: hover && h ? 'var(--accent)' : 'var(--line)',
        transition: 'border-color 140ms', cursor: onClick ? 'pointer' : 'default', ...style,
      }}>{children}</div>
  );
}

/* ---- Scroll body wrapper for screens ---- */
function ScreenBody({ children, pad = 22, grid }) {
  return (
    <div className={grid ? 'bg-grid' : ''} style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
      <div style={{ padding: pad, maxWidth: 1180, margin: '0 auto' }}>{children}</div>
    </div>
  );
}

/* ---- Provider type glyph ---- */
function ProviderType({ type }) {
  const label = window.NM_DATA.PROVIDER_TYPE_LABEL[type] || type;
  const color = { ses: 'var(--accent-warn)', m365: 'var(--accent-2)', gmail: 'var(--accent-danger)', smtp: 'var(--fg-2)' }[type] || 'var(--fg-2)';
  return (
    <span className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--fg-2)' }}>
      <span style={{ width: 6, height: 6, borderRadius: 2, background: color }} />{label}
    </span>
  );
}

Object.assign(window, {
  StatusBadge, Pill, StatusDot, Sparkline, Toggle, IconBtn,
  Segmented, Btn, SearchField, PageHeader, Card, ScreenBody, ProviderType, toneFor, TONE,
});
