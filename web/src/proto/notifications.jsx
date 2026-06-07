/* global React, I, PageHeader, ScreenBody, Card, Btn, IconBtn, Pill, Toggle, Segmented */
/* NovaMail Notifications — deliverability alert channels (webhooks). */
import { api } from '../api.ts';

const { useState: useNotifState, useEffect: useNotifEffect } = React;

function Notifications() {
  const [channels, setChannels] = useNotifState(null);
  const [form, setForm] = useNotifState({ name: '', url: '', min_severity: 'warning' });
  const [busy, setBusy] = useNotifState(false);

  async function load() {
    try { setChannels(await api('/alert-channels')); } catch (e) { setChannels([]); window.nmToast(String(e.message || e), 'danger'); }
  }
  useNotifEffect(() => { load(); }, []);

  async function add() {
    if (!form.name || !form.url) { window.nmToast('name and webhook URL required', 'danger'); return; }
    setBusy(true);
    try {
      await api('/alert-channels', { method: 'POST', body: form });
      window.nmToast('Channel added', 'good');
      setForm({ name: '', url: '', min_severity: 'warning' });
      load();
    } catch (e) { window.nmToast(String(e.message || e), 'danger'); } finally { setBusy(false); }
  }
  async function test(id, name) {
    window.nmToast(`testing ${name}…`, 'info');
    try { const r = await api(`/alert-channels/${id}/test`, { method: 'POST' }); window.nmToast(r.ok ? `${name}: delivered (${r.detail})` : `${name}: ${r.detail}`, r.ok ? 'good' : 'danger'); }
    catch (e) { window.nmToast(String(e.message || e), 'danger'); }
  }
  async function toggle(ch) {
    try { await api(`/alert-channels/${ch.id}`, { method: 'PUT', body: { enabled: !ch.enabled } }); load(); } catch (e) { window.nmToast(String(e.message || e), 'danger'); }
  }
  async function remove(ch) {
    try { await api(`/alert-channels/${ch.id}`, { method: 'DELETE' }); window.nmToast('Channel removed', 'good'); load(); } catch (e) { window.nmToast(String(e.message || e), 'danger'); }
  }

  const list = channels || [];
  const lbl = { display: 'block', fontSize: 11, color: 'var(--fg-3)', marginBottom: 4 };
  const inp = { width: '100%', height: 32, padding: '0 10px', borderRadius: 7, background: 'var(--bg-input)', border: '1px solid var(--line)', color: 'var(--fg)', fontSize: 12.5 };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <PageHeader icon={<I.AlertTriangle size={18} />} eyebrow="observe" title="Notifications" count={`${list.length} channel${list.length === 1 ? '' : 's'}`}
        sub="webhook alerts on deliverability regressions (Slack / Teams / PagerDuty / custom) · edge-triggered + debounced" />
      <ScreenBody>
        <Card style={{ marginBottom: 16 }}>
          <div className="mono" style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--fg-2)', marginBottom: 12 }}>Add webhook channel</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr auto', gap: 12, alignItems: 'end' }}>
            <div><label style={lbl}>name</label><input style={inp} value={form.name} placeholder="ops-slack" onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><label style={lbl}>webhook URL (stored encrypted)</label><input style={inp} value={form.url} placeholder="https://hooks.slack.com/services/…" onChange={(e) => setForm({ ...form, url: e.target.value })} /></div>
            <div>
              <label style={lbl}>fire on</label>
              <Segmented size="sm" value={form.min_severity} onChange={(v) => setForm({ ...form, min_severity: v })}
                options={[{ value: 'warning', label: 'warn+' }, { value: 'error', label: 'errors' }]} />
            </div>
          </div>
          <div style={{ marginTop: 12 }}><Btn kind="primary" size="sm" icon={<I.Plus size={13} />} onClick={add}>{busy ? 'adding…' : 'add channel'}</Btn></div>
        </Card>

        {channels && list.length === 0 && <div style={{ color: 'var(--fg-3)', fontSize: 13 }}>No alert channels. Add a webhook above to get notified when a domain's DNS regresses.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {list.map((ch) => (
            <Card key={ch.id} pad={14} style={{ opacity: ch.enabled ? 1 : 0.6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <I.AlertTriangle size={15} style={{ color: 'var(--accent)' }} />
                <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg)', flex: 1 }}>{ch.name}</span>
                <Pill tone="cyan">{ch.type}</Pill>
                <Pill tone={ch.min_severity === 'error' ? 'danger' : 'warn'}>{ch.min_severity === 'error' ? 'errors' : 'warn+'}</Pill>
                {!ch.configured && <Pill tone="muted">no URL</Pill>}
                <Btn size="sm" icon={<I.Activity size={12} />} onClick={() => test(ch.id, ch.name)}>test</Btn>
                <IconBtn size={26} title="Delete" onClick={() => remove(ch)}><I.Trash size={13} /></IconBtn>
                <Toggle size="sm" on={ch.enabled} onChange={() => toggle(ch)} />
              </div>
            </Card>
          ))}
        </div>
      </ScreenBody>
    </div>
  );
}

window.Notifications = Notifications;
