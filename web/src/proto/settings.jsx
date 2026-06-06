/* global React, I */
/* NovaMail Settings — preferences + server identity + security */

const ACCENT_SWATCH = { violet: '#9b6cf3', cyan: '#5cc7d6', green: '#5fce99', amber: '#e0a557', rose: '#e36d7e' };
const FONT_PAIRS_S = [
  { value: 'jetbrains-inter', label: 'JetBrains Mono + Inter' },
  { value: 'ibm-inter', label: 'IBM Plex Mono + Inter' },
  { value: 'mono-only', label: 'Mono everywhere' },
];

function SettingRow({ label, desc, children, last }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '13px 16px', borderBottom: last ? 0 : '1px solid var(--line)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: 'var(--fg-1)' }}>{label}</div>
        {desc && <div style={{ fontSize: 11.5, color: 'var(--fg-3)', marginTop: 2 }}>{desc}</div>}
      </div>
      {children}
    </div>
  );
}

function SettingsCard({ title, children }) {
  return (
    <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden', marginBottom: 16 }}>
      <div className="mono" style={{ padding: '11px 16px', fontSize: 11, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--fg-2)', borderBottom: '1px solid var(--line)' }}>{title}</div>
      {children}
    </div>
  );
}

function SettingNumber({ value, suffix, onSave }) {
  const [v, setV] = React.useState(value);
  React.useEffect(() => { setV(value); }, [value]);
  const dirty = String(v) !== String(value);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <input type="number" value={v} min={1} onChange={(e) => setV(Number(e.target.value))}
        className="mono" style={{ width: 90, padding: '7px 9px', borderRadius: 6, background: 'var(--bg-input)', border: '1px solid var(--line)', color: 'var(--fg)', fontSize: 12.5, outline: 'none', textAlign: 'right' }} />
      {suffix && <span className="mono" style={{ fontSize: 11, color: 'var(--fg-4)', width: 28 }}>{suffix}</span>}
      <Btn size="sm" kind={dirty ? 'primary' : undefined} disabled={!dirty} onClick={() => onSave(v)}>save</Btn>
    </div>
  );
}

function Settings({ t, setTweak }) {
  useDataVersion();
  const { SERVER, METRICS, SETTINGS } = window.NM_DATA;
  const maxMiB = Math.round((Number(SETTINGS.max_message_bytes) || 52428800) / 1048576);
  const retention = Number(SETTINGS.retention_days) || 30;
  const saveSetting = (k, v) => window.Store.saveSetting(k, v).then(() => window.nmToast('Setting saved')).catch((e) => window.nmToast(String(e.message || e), 'danger'));
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <PageHeader icon={<I.Settings size={18} />} eyebrow="system" title="Settings" sub="appearance · server identity · security" />
      <ScreenBody pad={22}>
        <div style={{ maxWidth: 760 }}>
          <SettingsCard title="Appearance">
            <SettingRow label="Theme" desc="Interface color scheme">
              <Segmented size="sm" options={[{ value: 'dark', label: 'Dark', icon: <I.Moon size={12} /> }, { value: 'light', label: 'Light', icon: <I.Sun size={12} /> }]} value={t.theme} onChange={(v) => setTweak({ theme: v })} />
            </SettingRow>
            <SettingRow label="Accent" desc="Used for active states, links and highlights">
              <div style={{ display: 'flex', gap: 7 }}>
                {Object.entries(ACCENT_SWATCH).map(([name, c]) => (
                  <button key={name} onClick={() => setTweak({ accent: name })} title={name} style={{
                    width: 22, height: 22, borderRadius: 6, background: c,
                    border: '2px solid', borderColor: t.accent === name ? 'var(--fg)' : 'transparent',
                    boxShadow: t.accent === name ? '0 0 0 2px var(--bg-1)' : 'none', transition: 'border-color 120ms',
                  }} />
                ))}
              </div>
            </SettingRow>
            <SettingRow label="Typography" desc="Mono + sans pairing">
              <select value={t.fontPair} onChange={(e) => setTweak({ fontPair: e.target.value })} className="mono" style={{
                background: 'var(--bg-input)', border: '1px solid var(--line)', color: 'var(--fg-1)',
                borderRadius: 6, padding: '6px 10px', fontSize: 12, outline: 'none', cursor: 'pointer',
              }}>
                {FONT_PAIRS_S.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </SettingRow>
            <SettingRow label="Density" desc="Row height across tables and lists" last>
              <Segmented size="sm" options={[{ value: 'compact', label: 'Compact' }, { value: 'cozy', label: 'Cozy' }, { value: 'comfy', label: 'Comfy' }]} value={t.density} onChange={(v) => setTweak({ density: v })} />
            </SettingRow>
          </SettingsCard>

          <SettingsCard title="Server identity">
            <SettingRow label="Relay name"><span className="mono" style={{ fontSize: 12.5, color: 'var(--fg-1)' }}>{SERVER.name}</span></SettingRow>
            <SettingRow label="Version"><Chip tone="accent">{SERVER.version}</Chip></SettingRow>
            <SettingRow label="Cluster nodes" desc="RabbitMQ quorum · nova-bus" last>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                {SERVER.nodes.map(n => (
                  <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <StatusDot status={n.state} pulse={n.role === 'leader'} />
                    <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-1)' }}>{n.id}</span>
                    <Chip tone={n.role === 'leader' ? 'accent' : undefined}>{n.role}</Chip>
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-4)', width: 56, textAlign: 'right' }}>up {n.up}</span>
                  </div>
                ))}
              </div>
            </SettingRow>
          </SettingsCard>

          <SettingsCard title="Security">
            <SettingRow label="DKIM signing" desc="All outbound mail signed at delivery">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: 'var(--accent-good)' }}><I.Shield size={14} /><span className="mono" style={{ fontSize: 12 }}>{METRICS.dkimSigned}%</span></span>
            </SettingRow>
            <SettingRow label="Credential storage" desc="Provider creds & DKIM keys envelope-encrypted at rest">
              <Pill tone="good"><I.Lock size={11} />encrypted</Pill>
            </SettingRow>
            <SettingRow label="Submission TLS" desc="STARTTLS required on the submission port" last>
              <Pill tone="good"><I.CheckCircle size={12} />enforced</Pill>
            </SettingRow>
          </SettingsCard>

          <SettingsCard title="Operational limits">
            <SettingRow label="Max message size" desc="Submissions over this are rejected 552 (hot-reloaded)">
              <SettingNumber value={maxMiB} suffix="MiB" onSave={(v) => saveSetting('max_message_bytes', v * 1048576)} />
            </SettingRow>
            <SettingRow label="Retention" desc="Daily sweep prunes delivered/bounced messages older than this" last>
              <SettingNumber value={retention} suffix="days" onSave={(v) => saveSetting('retention_days', v)} />
            </SettingRow>
          </SettingsCard>
        </div>
      </ScreenBody>
    </div>
  );
}

window.Settings = Settings;
