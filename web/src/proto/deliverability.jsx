/* global React, I, StatusDot, Pill, Btn, IconBtn, Card, PageHeader, ScreenBody */
/* NovaMail Deliverability — live DNS health (SPF/DKIM/DMARC) per relay domain.
   Self-fetching (the live-DNS endpoint is seconds-slow, so it doesn't block the
   global Store.loadAll). Phase 1: on-demand only; persistence/alerts come later. */
import { api } from '../api.ts';

const { useState: useDelivState, useEffect: useDelivEffect } = React;

// Map our check statuses onto existing tone/status vocabularies.
const DELIV_DOT = { ok: 'healthy', warning: 'degraded', error: 'failed', info: 'queued' };
const DELIV_TONE = { ok: 'good', warning: 'warn', error: 'danger', info: 'accent' };
const REC_LABEL = { spf: 'SPF', dkim: 'DKIM', dmarc: 'DMARC' };

function DelivRecord({ r }) {
  return (
    <div style={{ display: 'flex', gap: 11, padding: '9px 0', borderTop: '1px solid var(--line)' }}>
      <div style={{ paddingTop: 3 }}><StatusDot status={DELIV_DOT[r.status]} size={7} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--fg-2)' }}>{REC_LABEL[r.record] || r.record}{r.selector ? ` · ${r.selector}` : ''}</span>
          <Pill tone={DELIV_TONE[r.status] || 'muted'}>{r.status}</Pill>
        </div>
        <div style={{ fontSize: 12, color: 'var(--fg-2)', marginTop: 5 }}>{r.detail}</div>
        {r.found && <div className="mono" style={{ fontSize: 11, color: 'var(--fg-4)', marginTop: 4, wordBreak: 'break-all' }}>found: {r.found}</div>}
        {r.fix && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <span className="mono" style={{ fontSize: 11, color: 'var(--accent-good)', wordBreak: 'break-all', flex: 1 }}>fix: {r.fix}</span>
            <Btn size="sm" icon={<I.Copy size={12} />} onClick={() => { navigator.clipboard?.writeText(r.fix); window.nmToast('Copied fix', 'good'); }}>copy</Btn>
          </div>
        )}
      </div>
    </div>
  );
}

function DelivCard({ report, onCheck, checking }) {
  // Default-open anything that isn't healthy, so issues are visible at a glance.
  const [open, setOpen] = useDelivState(report.status !== 'ok');
  const recs = report.records || [];
  return (
    <Card pad={0}>
      <div onClick={() => setOpen((o) => !o)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', cursor: 'pointer' }}>
        <StatusDot status={DELIV_DOT[report.status]} pulse={report.status === 'ok'} />
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{report.domain}</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {recs.map((r, i) => <Pill key={i} tone={DELIV_TONE[r.status] || 'muted'}>{REC_LABEL[r.record] || r.record}</Pill>)}
        </div>
        <span onClick={(e) => e.stopPropagation()} style={{ display: 'flex' }}>
          <IconBtn size={26} title="Check now" active={checking} onClick={() => onCheck(report.domain)}><I.Refresh size={13} /></IconBtn>
        </span>
        <I.ChevronD size={14} style={{ color: 'var(--fg-3)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 140ms' }} />
      </div>
      {open && <div style={{ padding: '0 16px 10px' }}>{recs.map((r, i) => <DelivRecord key={i} r={r} />)}</div>}
    </Card>
  );
}

function Deliverability() {
  const [reports, setReports] = useDelivState(null);
  const [err, setErr] = useDelivState(null);
  const [checking, setChecking] = useDelivState({});

  async function loadAll() {
    setErr(null);
    setReports(null);
    try {
      setReports(await api('/deliverability'));
    } catch (e) {
      setErr(String(e.message || e));
    }
  }
  useDelivEffect(() => { loadAll(); }, []);

  async function checkOne(domain) {
    setChecking((c) => ({ ...c, [domain]: true }));
    try {
      const r = await api('/deliverability/' + encodeURIComponent(domain));
      setReports((rs) => (rs || []).map((x) => (x.domain === domain ? r : x)));
      window.nmToast(`${domain}: ${r.status}`, r.status === 'ok' ? 'good' : r.status === 'error' ? 'danger' : 'warn');
    } catch (e) {
      window.nmToast(String(e.message || e), 'danger');
    } finally {
      setChecking((c) => ({ ...c, [domain]: false }));
    }
  }

  const rs = reports || [];
  const counts = { ok: 0, warning: 0, error: 0 };
  rs.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <PageHeader icon={<I.Shield size={18} />} eyebrow="outgoing" title="Deliverability"
        count={reports ? `${rs.length} domains` : 'checking…'}
        sub="live DNS health for relay domains · SPF · DKIM (key match) · DMARC"
        actions={<Btn kind="primary" icon={<I.Refresh size={13} />} size="sm" onClick={loadAll}>re-check all</Btn>} />
      <ScreenBody>
        {err && <div style={{ color: 'var(--accent-danger)', fontSize: 13 }}>Failed to load: {err}</div>}
        {!reports && !err && <div style={{ color: 'var(--fg-3)', fontSize: 13 }}>Resolving DNS for all relay domains…</div>}
        {reports && rs.length === 0 && <div style={{ color: 'var(--fg-3)', fontSize: 13 }}>No relay domains configured.</div>}
        {reports && rs.length > 0 && (
          <>
            <div style={{ display: 'flex', gap: 16, marginBottom: 16, fontSize: 12.5 }} className="mono">
              <span style={{ color: 'var(--accent-good)' }}>● {counts.ok || 0} healthy</span>
              <span style={{ color: 'var(--accent-warn)' }}>▲ {counts.warning || 0} warnings</span>
              <span style={{ color: 'var(--accent-danger)' }}>✕ {counts.error || 0} errors</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {rs.map((r) => <DelivCard key={r.domain} report={r} onCheck={checkOne} checking={!!checking[r.domain]} />)}
            </div>
          </>
        )}
      </ScreenBody>
    </div>
  );
}

window.Deliverability = Deliverability;
