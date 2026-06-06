/* global React, I */
/* NovaMail Queue monitor — RabbitMQ work / wait / DLQ, live depths */
const { useState: useQState, useEffect: useQEffect, useRef: useQRef } = React;

const KIND_META = {
  work: { label: 'work', tone: 'accent', icon: <I.Layers size={13} /> },
  wait: { label: 'retry tier', tone: 'warn', icon: <I.Clock size={13} /> },
  dlq:  { label: 'dead-letter', tone: 'danger', icon: <I.AlertTriangle size={13} /> },
};

function QueueMonitor({ live }) {
  const { QUEUES } = window.NM_DATA;
  const [paused, setPaused] = useQState(false);
  const [depths, setDepths] = useQState(() => Object.fromEntries(QUEUES.map(q => [q.name, q.depth])));
  const maxDepth = Math.max(...QUEUES.map(q => q.depth)) * 1.2;

  useQEffect(() => {
    if (paused) return;
    const t = setInterval(() => {
      setDepths(prev => {
        const next = { ...prev };
        for (const q of QUEUES) {
          const drift = Math.round((Math.random() - 0.48) * (q.kind === 'work' ? 18 : 4));
          next[q.name] = Math.max(0, Math.min(Math.round(q.depth * 1.8), prev[q.name] + drift));
        }
        return next;
      });
    }, 1400);
    return () => clearInterval(t);
  }, [paused]);

  const total = Object.values(depths).reduce((a, b) => a + b, 0);
  const consumers = QUEUES.reduce((a, q) => a + q.consumers, 0);

  const Summary = ({ label, value, tone, unit, pulse }) => (
    <div style={{ flex: 1, padding: '12px 16px', borderRight: '1px solid var(--line)' }}>
      <div className="mono" style={{ fontSize: 10.5, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--fg-4)' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, marginTop: 5 }}>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 23, fontWeight: 600, color: tone || 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        {unit && <span className="mono" style={{ fontSize: 11, color: 'var(--fg-4)' }}>{unit}</span>}
        {pulse && <span className="pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent-good)', marginLeft: 2 }} />}
      </div>
    </div>
  );

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <PageHeader icon={<I.Layers size={18} />} eyebrow="data plane" title="Queue monitor" sub="RabbitMQ 4.x · quorum queues · 3-node cluster"
        actions={<>
          <Btn icon={paused ? <I.Play size={12} /> : <I.Pause size={12} />} size="sm" onClick={() => setPaused(p => !p)}>{paused ? 'resume' : 'pause'} stream</Btn>
          <Btn icon={<I.Refresh size={13} />} size="sm" onClick={() => window.nmToast && window.nmToast('Dead-letter queue purged', 'danger')}>purge dlq</Btn>
        </>} />
      <ScreenBody>
        {/* summary strip */}
        <div style={{ display: 'flex', background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden', marginBottom: 16 }}>
          <Summary label="Total queued · live" value={total.toLocaleString()} pulse={!paused} />
          <Summary label="Ingress rate" value={live.inRate} unit="msg/s" tone="var(--accent-2)" />
          <Summary label="Delivery rate" value={live.outRate} unit="msg/s" tone="var(--accent-good)" />
          <div style={{ flex: 1, padding: '12px 16px' }}>
            <div className="mono" style={{ fontSize: 10.5, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--fg-4)' }}>Consumers</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, marginTop: 5 }}>
              <span style={{ fontFamily: 'var(--font-display)', fontSize: 23, fontWeight: 600, color: 'var(--fg)' }}>{consumers}</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--fg-4)' }}>delivery workers</span>
            </div>
          </div>
        </div>

        {/* flow legend */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '11px 15px', background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, marginBottom: 16 }}>
          <span className="mono" style={{ fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-4)' }}>flow</span>
          <Chip tone="accent">relay.work</Chip>
          <I.ArrowRight size={13} style={{ color: 'var(--fg-4)' }} />
          <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>4xx defer</span>
          <Chip tone="warn">wait.30s → 5m → 30m</Chip>
          <I.ArrowRight size={13} style={{ color: 'var(--fg-4)' }} />
          <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>TTL+DLX requeue</span>
          <span style={{ flex: 1 }} />
          <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>5xx / max attempts</span>
          <Chip tone="danger">relay.dlq</Chip>
          <I.ArrowRight size={13} style={{ color: 'var(--fg-4)' }} />
          <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>DSN bounce</span>
        </div>

        {/* queue list */}
        <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
          {QUEUES.map((q, i) => {
            const meta = KIND_META[q.kind];
            const d = depths[q.name];
            return (
              <div key={q.name} style={{ display: 'grid', gridTemplateColumns: '1.6fr 1.4fr 90px 90px 110px', gap: 16, alignItems: 'center', padding: '13px 16px', borderBottom: i < QUEUES.length - 1 ? '1px solid var(--line)' : 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <span style={{ color: TONE[meta.tone].fg, display: 'flex' }}>{meta.icon}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="mono" style={{ fontSize: 12.5, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.name}</div>
                    <div className="mono" style={{ fontSize: 10, color: 'var(--fg-4)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 1 }}>{meta.label}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--bg-3)', overflow: 'hidden' }}>
                    <div style={{ width: `${Math.min(100, (d / maxDepth) * 100)}%`, height: '100%', background: TONE[meta.tone].fg, borderRadius: 3, transition: 'width 600ms ease' }} />
                  </div>
                  <span className="mono" style={{ fontSize: 13, color: 'var(--fg)', width: 46, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{d}</span>
                </div>
                <div className="mono" style={{ fontSize: 11.5, color: 'var(--accent-2)', textAlign: 'right' }}>↑ {q.in}/s</div>
                <div className="mono" style={{ fontSize: 11.5, color: 'var(--accent-good)', textAlign: 'right' }}>↓ {q.out}/s</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--fg-4)' }}>{q.consumers}c</span>
                  <StatusBadge status={q.state} />
                </div>
              </div>
            );
          })}
        </div>
      </ScreenBody>
    </div>
  );
}

window.QueueMonitor = QueueMonitor;
