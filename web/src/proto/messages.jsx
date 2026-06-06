/* global React, I */
/* NovaMail Messages — master/detail tracing, 2 timeline treatments */
const { useState: useMsgState, useEffect: useMsgEffect } = React;

const STATUS_FILTERS = ['all', 'relayed', 'queued', 'deferred', 'bounced', 'failed'];

/* ---- trace: vertical timeline ---- */
function TraceTimeline({ events }) {
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: '4px 0 0' }}>
      {events.map((e, i) => {
        const tone = toneFor(e.kind);
        const last = i === events.length - 1;
        return (
          <li key={i} style={{ display: 'grid', gridTemplateColumns: '16px 1fr', gap: 11, position: 'relative' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: tone.fg, boxShadow: `0 0 0 3px ${tone.soft}`, marginTop: 4, flexShrink: 0 }} />
              {!last && <span style={{ flex: 1, width: 1.5, background: 'var(--line)', marginTop: 2 }} />}
            </div>
            <div style={{ paddingBottom: last ? 0 : 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <StatusBadge status={e.kind} />
                {e.provider && <span className="mono" style={{ fontSize: 11, color: 'var(--accent-2)' }}>{e.provider}</span>}
                <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-4)', marginLeft: 'auto' }}>{e.at}</span>
              </div>
              <div className="mono" style={{ fontSize: 11.5, color: 'var(--fg-2)', marginTop: 4, lineHeight: 1.5 }}>{e.detail}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ---- trace: terminal log ---- */
function TraceLog({ events }) {
  return (
    <div className="mono" style={{
      background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 8,
      padding: '12px 14px', fontSize: 11.5, lineHeight: 1.85, overflowX: 'auto',
    }}>
      {events.map((e, i) => {
        const tone = toneFor(e.kind);
        return (
          <div key={i} style={{ display: 'flex', gap: 10, whiteSpace: 'nowrap' }}>
            <span style={{ color: 'var(--fg-4)' }}>{e.at}</span>
            <span style={{ color: tone.fg, width: 110, flexShrink: 0, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{e.kind}</span>
            <span style={{ color: 'var(--fg-2)', whiteSpace: 'pre' }}>
              {e.provider ? <span style={{ color: 'var(--accent-2)' }}>{e.provider} · </span> : null}{e.detail}
            </span>
          </div>
        );
      })}
      <div style={{ display: 'flex', gap: 10, color: 'var(--fg-4)' }}>
        <span>{events[events.length - 1].at.slice(0, 8)}</span>
        <span style={{ color: 'var(--accent)' }}>{'> '}<span style={{ animation: 'blink 1.1s step-end infinite' }}>_</span></span>
      </div>
    </div>
  );
}

function MetaItem({ label, children }) {
  return (
    <div>
      <div className="mono" style={{ fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--fg-4)' }}>{label}</div>
      <div style={{ fontSize: 12.5, color: 'var(--fg-1)', marginTop: 2, wordBreak: 'break-word' }}>{children}</div>
    </div>
  );
}

function MessageDetail({ msg, traceStyle }) {
  if (!msg) {
    return (
      <div className="bg-grid" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', borderLeft: '1px solid var(--line)' }}>
        <div style={{ textAlign: 'center', color: 'var(--fg-3)' }}>
          <I.Mail size={26} style={{ color: 'var(--fg-4)' }} />
          <div className="mono" style={{ fontSize: 12, marginTop: 10 }}>select a message to trace</div>
        </div>
      </div>
    );
  }
  return (
    <div style={{ width: 440, flexShrink: 0, borderLeft: '1px solid var(--line)', background: 'var(--bg-1)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>{msg.id}</span>
          <span style={{ marginLeft: 'auto' }}><StatusBadge status={msg.status} dot /></span>
        </div>
        <div style={{ fontSize: 15, color: 'var(--fg)', marginTop: 8, fontWeight: 500, lineHeight: 1.35 }}>{msg.subject}</div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '13px 16px', marginBottom: 18 }}>
          <MetaItem label="From">{msg.mail_from}</MetaItem>
          <MetaItem label="To">{msg.rcpt_to.join(', ')}</MetaItem>
          <MetaItem label="Provider">{msg.provider}</MetaItem>
          <MetaItem label="Attempts">{msg.attempts}</MetaItem>
          <MetaItem label="Size">{msg.size}</MetaItem>
          <MetaItem label="Created">{msg.created_at}</MetaItem>
        </div>
        <div className="mono" style={{ fontSize: 10.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--fg-4)', marginBottom: 12 }}>// delivery trace</div>
        {traceStyle === 'log' ? <TraceLog events={msg.events} /> : <TraceTimeline events={msg.events} />}
      </div>
      <div style={{ height: 28, borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 14, padding: '0 18px', flexShrink: 0 }}>
        <button className="mono" onClick={() => window.nmToast && window.nmToast('Message requeued to relay.work')} style={{ fontSize: 11, color: 'var(--link)', display: 'flex', alignItems: 'center', gap: 5 }}><I.Refresh size={11} />requeue</button>
        <button className="mono" onClick={() => window.nmToast && window.nmToast('Message ID copied')} style={{ fontSize: 11, color: 'var(--fg-3)', display: 'flex', alignItems: 'center', gap: 5 }}><I.Copy size={11} />copy id</button>
        <button className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', display: 'flex', alignItems: 'center', gap: 5, marginLeft: 'auto' }}><I.ExternalLink size={11} />raw</button>
      </div>
    </div>
  );
}

function Messages({ traceStyle, initialId }) {
  const { MESSAGES } = window.NM_DATA;
  const [q, setQ] = useMsgState('');
  const [filter, setFilter] = useMsgState('all');
  const [selId, setSelId] = useMsgState(initialId || MESSAGES[0].id);

  useMsgEffect(() => { if (initialId) setSelId(initialId); }, [initialId]);

  const rows = MESSAGES.filter(m => {
    if (filter !== 'all' && m.status !== filter) return false;
    if (q) { const s = q.toLowerCase(); return m.mail_from.toLowerCase().includes(s) || m.rcpt_to.join(' ').toLowerCase().includes(s) || m.subject.toLowerCase().includes(s) || m.id.toLowerCase().includes(s); }
    return true;
  });
  const sel = MESSAGES.find(m => m.id === selId);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <PageHeader icon={<I.Mail size={18} />} eyebrow="observability" title="Message tracing" count={`${rows.length} shown`}
        actions={<>
          <SearchField value={q} onChange={setQ} placeholder="sender / recipient / subject / id" width={280} />
          <Btn icon={<I.Refresh size={13} />} size="sm">refresh</Btn>
        </>} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 22px', borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
        <Segmented size="sm" options={STATUS_FILTERS} value={filter} onChange={setFilter} />
        <span className="mono" style={{ fontSize: 11, color: 'var(--fg-4)', marginLeft: 'auto' }}>live tail · {MESSAGES.length} in window</span>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* list */}
        <div style={{ flex: 1, overflowY: 'auto', minWidth: 0 }}>
          {rows.map((m) => {
            const on = m.id === selId;
            return (
              <button key={m.id} onClick={() => setSelId(m.id)} style={{
                display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
                padding: '0 22px', height: 'calc(var(--row) + 22px)', minHeight: 50,
                borderBottom: '1px solid var(--line)',
                background: on ? 'var(--accent-soft)' : 'transparent', transition: 'background 120ms',
              }}
                onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = 'transparent'; }}
              >
                <StatusDot status={m.status} pulse={m.status === 'queued'} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.subject}</div>
                  <div className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                    {m.mail_from} <span style={{ color: 'var(--fg-4)' }}>→</span> {m.rcpt_to[0]}{m.rcpt_to.length > 1 ? ` +${m.rcpt_to.length - 1}` : ''}
                  </div>
                </div>
                <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                  <StatusBadge status={m.status} />
                  <span className="mono" style={{ fontSize: 10, color: 'var(--fg-4)' }}>{m.created_at.slice(11)}</span>
                </div>
              </button>
            );
          })}
          {rows.length === 0 && <div className="mono" style={{ padding: 40, textAlign: 'center', color: 'var(--fg-4)', fontSize: 12 }}>no messages match</div>}
        </div>
        <MessageDetail msg={sel} traceStyle={traceStyle} />
      </div>
    </div>
  );
}

window.Messages = Messages;
