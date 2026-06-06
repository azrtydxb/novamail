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
  const [tab, setTab] = useLoginState('signin');
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
          <div className="mono" style={{ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--accent)', marginBottom: 8 }}>// {tab === 'signin' ? 'authenticate' : 'register'}</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--fg)', marginBottom: 18 }}>
            {tab === 'signin' ? 'Welcome back' : 'Create operator account'}
          </div>

          {/* tab strip */}
          <div style={{ display: 'flex', gap: 18, borderBottom: '1px solid var(--line)', marginBottom: 18 }}>
            {['signin', 'register'].map(tb => (
              <button key={tb} onClick={() => setTab(tb)} className="mono" style={{
                fontSize: 12, letterSpacing: '0.04em', textTransform: 'uppercase', padding: '0 0 9px', whiteSpace: 'nowrap',
                color: tab === tb ? 'var(--fg)' : 'var(--fg-3)',
                borderBottom: '2px solid', borderColor: tab === tb ? 'var(--accent)' : 'transparent', marginBottom: -1,
              }}>{tb === 'signin' ? 'sign in' : 'register'}</button>
            ))}
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
            >{busy ? 'signing in…' : (tab === 'signin' ? 'sign in' : 'create account')}<I.ArrowRight size={14} /></button>

            {/* divider */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0' }}>
              <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-4)' }}>OR</span>
              <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
            </div>
            <button onClick={() => window.nmToast('SSO is not configured', 'danger')} className="mono" style={{
              padding: '10px', borderRadius: 7, background: 'var(--bg-2)', border: '1px solid var(--line)',
              color: 'var(--fg-1)', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, whiteSpace: 'nowrap',
            }}
              onMouseEnter={(e) => e.currentTarget.style.borderColor = 'var(--line-strong)'}
              onMouseLeave={(e) => e.currentTarget.style.borderColor = 'var(--line)'}
            ><I.Shield size={14} />continue with SSO</button>
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
