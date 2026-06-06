/* global React, I */
/* NovaMail Login — centered card on grid backdrop with accent orb */
const { useState: useLoginState } = React;

function Field({ label, type = 'text', value, onChange, placeholder, autoFocus }) {
  return (
    <label style={{ display: 'block' }}>
      <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', display: 'block', marginBottom: 5 }}>{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus}
        className="mono" style={{
          width: '100%', padding: '10px 12px', borderRadius: 7, background: 'var(--bg-input)',
          border: '1px solid var(--line)', color: 'var(--fg)', fontSize: 13, outline: 'none', transition: 'border-color 120ms, box-shadow 120ms',
        }}
        onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; e.target.style.boxShadow = '0 0 0 3px var(--accent-soft)'; }}
        onBlur={(e) => { e.target.style.borderColor = 'var(--line)'; e.target.style.boxShadow = 'none'; }} />
    </label>
  );
}

function Login({ onSignIn }) {
  const [user, setUser] = useLoginState('admin@novamail.local');
  const [pass, setPass] = useLoginState('');
  const [err, setErr] = useLoginState('');
  const [busy, setBusy] = useLoginState(false);

  const doLogin = async () => {
    setErr(''); setBusy(true);
    try { await window.Store.login(user, pass); onSignIn(); }
    catch (e) { setErr(String(e.message || e).replace(/^\d+\s*/, '') || 'login failed'); }
    finally { setBusy(false); }
  };

  return (
    <div className="bg-grid" style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', position: 'relative', overflow: 'hidden' }}>
      {/* accent orb */}
      <div style={{ position: 'absolute', top: '22%', left: '50%', transform: 'translateX(-50%)', width: 520, height: 320, background: 'radial-gradient(ellipse at center, var(--accent-soft), transparent 70%)', filter: 'blur(20px)', pointerEvents: 'none' }} />

      <div style={{ position: 'relative', width: 384 }}>
        {/* brand */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, marginBottom: 20 }}>
          <I.Logo size={28} />
          <span className="mono" style={{ fontSize: 19, fontWeight: 600, letterSpacing: 0.3, color: 'var(--fg)' }}>nova<span style={{ color: 'var(--accent)' }}>mail</span></span>
        </div>

        <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 12, padding: 26, boxShadow: 'var(--shadow-md)' }}>
          <div className="mono" style={{ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--accent)', marginBottom: 8 }}>// authenticate</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--fg)', marginBottom: 18 }}>
            Welcome back
          </div>


          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            <Field label="email" value={user} onChange={setUser} placeholder="you@domain.com" autoFocus />
            <div onKeyDown={(e) => { if (e.key === 'Enter') doLogin(); }}>
              <Field label="password" type="password" value={pass} onChange={setPass} placeholder="••••••••••••" />
            </div>
            {err && <div className="mono" style={{ fontSize: 11, color: 'var(--accent-danger)', display: 'flex', alignItems: 'center', gap: 6 }}><I.AlertTriangle size={13} />{err}</div>}
            <button onClick={doLogin} disabled={busy} className="mono" style={{
              marginTop: 4, padding: '11px', borderRadius: 7, background: 'var(--accent)', color: 'var(--accent-fg)',
              fontSize: 12.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: busy ? 0.6 : 1,
            }}
              onMouseEnter={(e) => e.currentTarget.style.filter = 'brightness(1.08)'}
              onMouseLeave={(e) => e.currentTarget.style.filter = 'none'}
            >{busy ? 'signing in…' : 'sign in'}<I.ArrowRight size={14} /></button>
          </div>

          <div style={{ borderTop: '1px dashed var(--line)', marginTop: 18, paddingTop: 13 }}>
            <div className="mono" style={{ fontSize: 10.5, color: 'var(--fg-4)', textAlign: 'center' }}>self-hosted · relay-only · your mail, your infra</div>
          </div>
        </div>

        {/* status row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 16 }}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent-good)' }} />relay online
          </span>
          <span className="mono" style={{ fontSize: 11, color: 'var(--fg-4)' }}>{window.NM_DATA.SERVER.version}</span>
        </div>
      </div>
    </div>
  );
}

window.Login = Login;
