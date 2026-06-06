/* global React, I */
/* NovaMail Dashboard — sparklines, live queue depth, throughput chart, 3 layout variants */
const { useState: useDashState, useEffect: useDashEffect, useRef: useDashRef } = React;

function useWidth(ref) {
  const [w, setW] = useDashState(640);
  useDashEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => { for (const e of entries) setW(e.contentRect.width); });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return w;
}

function fmtNum(n) { return n.toLocaleString('en-US'); }

/* ---- Big area chart (relayed vs deferred over 24h) ---- */
function ThroughputChart({ height = 220 }) {
  const ref = useDashRef(null);
  const w = useWidth(ref);
  const { SERIES } = window.NM_DATA;
  const pad = { l: 0, r: 0, t: 12, b: 22 };
  const innerH = height - pad.t - pad.b;
  const clean = (a) => (a || []).map((v) => (Number.isFinite(v) ? v : 0));
  const data = clean(SERIES.relayed), data2 = clean(SERIES.deferred);
  const max = Math.max(1, Math.max(...data) * 1.08);
  const x = (i) => (i / (data.length - 1)) * w;
  const y = (v) => pad.t + innerH - (v / max) * innerH;
  const line = (arr) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const area = (arr) => `${line(arr)} L${w} ${pad.t + innerH} L0 ${pad.t + innerH} Z`;
  const gridY = [0, 0.25, 0.5, 0.75, 1].map(f => pad.t + innerH - f * innerH);
  const hours = [0, 6, 12, 18, 23];

  return (
    <div ref={ref} style={{ width: '100%' }}>
      <svg width={w} height={height} style={{ display: 'block' }}>
        <defs>
          <linearGradient id="thru-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.30" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {gridY.map((gy, i) => (
          <line key={i} x1="0" x2={w} y1={gy} y2={gy} stroke="var(--line)" strokeWidth="1" strokeDasharray={i === 4 ? '0' : '2 4'} opacity="0.5" />
        ))}
        {gridY.map((gy, i) => (
          <text key={'l' + i} x="2" y={gy - 3} className="mono" style={{ fontSize: 9.5, fill: 'var(--fg-4)' }}>
            {fmtNum(Math.round(i * 0.25 * max))}
          </text>
        ))}
        <path d={area(data)} fill="url(#thru-fill)" />
        <path d={line(data)} fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinejoin="round" />
        <path d={line(data2)} fill="none" stroke="var(--accent-warn)" strokeWidth="1.4" strokeLinejoin="round" strokeDasharray="3 3" opacity="0.85" />
        {hours.map(h => (
          <text key={h} x={x(h)} y={height - 6} className="mono" style={{ fontSize: 9.5, fill: 'var(--fg-4)' }} textAnchor={h === 0 ? 'start' : h === 23 ? 'end' : 'middle'}>
            {String(h).padStart(2, '0')}:00
          </text>
        ))}
      </svg>
    </div>
  );
}

/* ---- Stat card ---- */
function StatCard({ label, value, unit, delta, deltaTone = 'good', spark, sparkColor = 'var(--accent)', live }) {
  return (
    <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, padding: '13px 15px' }}>
      <div className="mono" style={{ fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-3)' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10, marginTop: 7 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 27, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
          {unit && <span className="mono" style={{ fontSize: 12, color: 'var(--fg-3)' }}>{unit}</span>}
          {live && <span className="pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent-good)', marginLeft: 4, marginBottom: 3 }} />}
        </div>
        {spark && <Sparkline data={spark} w={84} h={30} color={sparkColor} />}
      </div>
      {delta && (
        <div className="mono" style={{ fontSize: 11, marginTop: 6, color: TONE[deltaTone].fg, display: 'flex', alignItems: 'center', gap: 4 }}>
          {deltaTone === 'good' ? <I.ArrowUp size={11} /> : deltaTone === 'danger' ? <I.ArrowDown size={11} /> : <I.Dot size={11} />}
          {delta}
        </div>
      )}
    </div>
  );
}

/* ---- Provider health mini-list ---- */
function ProviderHealth({ onNavigate }) {
  const { PROVIDERS } = window.NM_DATA;
  return (
    <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '11px 15px', borderBottom: '1px solid var(--line)' }}>
        <span className="mono" style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--fg-2)', flex: 1 }}>Provider health</span>
        <button className="mono" onClick={() => onNavigate('providers')} style={{ fontSize: 11, color: 'var(--link)', textDecoration: 'underline', textDecorationStyle: 'dashed', textUnderlineOffset: 3 }}>all providers</button>
      </div>
      {PROVIDERS.filter(p => p.enabled).map((p, i, arr) => (
        <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 15px', borderBottom: i < arr.length - 1 ? '1px solid var(--line)' : 0 }}>
          <StatusDot status={p.status} pulse={p.status === 'healthy'} />
          <span style={{ flex: 1, fontSize: 12.5, color: 'var(--fg-1)' }}>{p.name}</span>
          <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>{fmtNum(p.sent24h)}</span>
          <StatusBadge status={p.status} />
        </div>
      ))}
    </div>
  );
}

/* ---- Recent activity feed ---- */
const ACT_ICON = { relayed: <I.CheckCircle size={13} />, deferred: <I.Clock size={13} />, bounced: <I.AlertTriangle size={13} />, failed: <I.X size={13} />, queued: <I.Inbox size={13} /> };
function RecentActivity({ onOpen, dense }) {
  const { MESSAGES } = window.NM_DATA;
  return (
    <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '11px 15px', borderBottom: '1px solid var(--line)' }}>
        <span className="mono" style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--fg-2)', flex: 1 }}>Recent messages</span>
        <button className="mono" onClick={() => onOpen()} style={{ fontSize: 11, color: 'var(--link)', textDecoration: 'underline', textDecorationStyle: 'dashed', textUnderlineOffset: 3 }}>trace all</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {MESSAGES.slice(0, dense ? 8 : 6).map((m, i, arr) => (
          <button key={m.id} onClick={() => onOpen(m.id)} style={{
            display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'left',
            padding: '9px 15px', borderBottom: i < arr.length - 1 ? '1px solid var(--line)' : 0,
            transition: 'background 120ms',
          }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-hover)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            <span style={{ color: toneFor(m.status).fg, display: 'flex' }}>{ACT_ICON[m.status] || <I.Dot size={13} />}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, color: 'var(--fg-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.subject}</div>
              <div className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.mail_from} → {m.rcpt_to[0]}{m.rcpt_to.length > 1 ? ` +${m.rcpt_to.length - 1}` : ''}</div>
            </div>
            <StatusBadge status={m.status} />
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---- main Dashboard ---- */
function Dashboard({ live, onNavigate, onOpenMessage, layout = 'overview' }) {
  const { METRICS, SERIES } = window.NM_DATA;
  const openMsg = (id) => { onOpenMessage(id); };

  const stats = (
    <>
      <StatCard label="Relayed · 24h" value={fmtNum(METRICS.relayed24h)} delta="+8.4% vs yesterday" deltaTone="good" spark={SERIES.relayed} />
      <StatCard label="Accept rate" value={METRICS.acceptRate} unit="%" delta="within SLA" deltaTone="good" spark={SERIES.relayed.map(v => v * 0.99)} sparkColor="var(--accent-good)" />
      <StatCard label="Deferred · 24h" value={fmtNum(METRICS.deferred24h)} delta="+12 last hour" deltaTone="warn" spark={SERIES.deferred} sparkColor="var(--accent-warn)" />
      <StatCard label="Bounced · 24h" value={fmtNum(METRICS.bounced24h)} delta="0.36% of volume" deltaTone="danger" spark={SERIES.bounced} sparkColor="var(--accent-danger)" />
    </>
  );

  const queueCard = (
    <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, padding: '13px 15px' }}>
      <div className="mono" style={{ fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-3)' }}>Queue depth · live</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10, marginTop: 7 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 27, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>{fmtNum(live.queueDepth)}</span>
          <span className="pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', marginLeft: 2, marginBottom: 4 }} />
        </div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', textAlign: 'right', lineHeight: 1.5 }}>
          <div><span style={{ color: 'var(--accent-good)' }}>↓ {live.outRate}</span>/s out</div>
          <div><span style={{ color: 'var(--accent-2)' }}>↑ {live.inRate}</span>/s in</div>
        </div>
      </div>
    </div>
  );

  const chartCard = (
    <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, padding: '14px 16px 8px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 6, flexWrap: 'wrap' }}>
        <span className="mono" style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--fg-2)', flex: 1 }}>Throughput · last 24h</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 14, height: 2, background: 'var(--accent)' }} />relayed</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 14, height: 0, borderTop: '2px dashed var(--accent-warn)' }} />deferred</span>
      </div>
      <ThroughputChart height={layout === 'focus' ? 280 : 210} />
    </div>
  );

  // layout variants
  if (layout === 'focus') {
    return (
      <ScreenBody>
        {chartCard}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, margin: '14px 0' }}>
          {stats}{queueCard}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
          <ProviderHealth onNavigate={onNavigate} />
          <RecentActivity onOpen={(id) => id ? openMsg(id) : onNavigate('messages')} />
        </div>
      </ScreenBody>
    );
  }

  if (layout === 'stream') {
    return (
      <ScreenBody>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14, alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>{stats}</div>
            {chartCard}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
            {queueCard}
            <div style={{ height: 360, display: 'flex' }}><RecentActivity onOpen={(id) => id ? openMsg(id) : onNavigate('messages')} dense /></div>
            <ProviderHealth onNavigate={onNavigate} />
          </div>
        </div>
      </ScreenBody>
    );
  }

  // overview (default)
  return (
    <ScreenBody>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        {stats}{queueCard}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)', gap: 14, marginTop: 14, alignItems: 'start' }}>
        {chartCard}
        <ProviderHealth onNavigate={onNavigate} />
      </div>
      <div style={{ marginTop: 14 }}>
        <RecentActivity onOpen={(id) => id ? openMsg(id) : onNavigate('messages')} />
      </div>
    </ScreenBody>
  );
}

window.Dashboard = Dashboard;
