import { useEffect, useState } from "react";
import { api } from "./api.ts";

type Row = Record<string, unknown>;

interface Field {
  name: string;
  label: string;
  type?: "text" | "number" | "checkbox" | "list";
}

interface ResourceDef {
  key: string; // API path segment
  title: string;
  pk: string;
  fields: Field[]; // creatable fields
  columns: string[]; // displayed columns
}

const RESOURCES: ResourceDef[] = [
  {
    key: "providers", title: "Providers", pk: "id",
    fields: [
      { name: "name", label: "Name" },
      { name: "type", label: "Type (smtp|ses|m365|gmail)" },
      { name: "endpoint", label: "Endpoint host:port" },
      { name: "auth_mode", label: "Auth mode" },
      { name: "secret_ref", label: "Secret ref" },
      { name: "enabled", label: "Enabled", type: "checkbox" },
    ],
    columns: ["name", "type", "endpoint", "auth_mode", "enabled"],
  },
  {
    key: "routing-rules", title: "Routing rules", pk: "id",
    fields: [
      { name: "recipient_domain", label: "Recipient domain" },
      { name: "sender_domain", label: "Sender domain" },
      { name: "provider_chain", label: "Provider IDs (comma-sep)", type: "list" },
      { name: "priority", label: "Priority", type: "number" },
      { name: "enabled", label: "Enabled", type: "checkbox" },
    ],
    columns: ["recipient_domain", "sender_domain", "provider_chain", "priority", "enabled"],
  },
  {
    key: "relay-domains", title: "Relay domains", pk: "domain",
    fields: [{ name: "domain", label: "Domain" }],
    columns: ["domain"],
  },
  {
    key: "rate-limits", title: "Rate limits", pk: "domain",
    fields: [
      { name: "domain", label: "Domain (* = default)" },
      { name: "per_second", label: "Per second", type: "number" },
      { name: "burst", label: "Burst", type: "number" },
      { name: "enabled", label: "Enabled", type: "checkbox" },
    ],
    columns: ["domain", "per_second", "burst", "enabled"],
  },
  {
    key: "accounts", title: "Accounts", pk: "id",
    fields: [
      { name: "username", label: "Username" },
      { name: "password", label: "Password" },
      { name: "allowed_sender_domains", label: "Allowed sender domains (comma-sep)", type: "list" },
    ],
    columns: ["username", "allowed_sender_domains"],
  },
];

function fmt(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if (v === null || v === undefined) return "";
  return String(v);
}

function ResourcePanel({ def }: { def: ResourceDef }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setRows(await api<Row[]>(`/${def.key}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def.key]);

  async function create() {
    try {
      const body: Record<string, unknown> = {};
      for (const f of def.fields) {
        const v = draft[f.name];
        if (v === undefined || v === "") continue;
        if (f.type === "list") body[f.name] = String(v).split(",").map((s) => s.trim()).filter(Boolean);
        else if (f.type === "number") body[f.name] = Number(v);
        else body[f.name] = v;
      }
      await api(`/${def.key}`, { method: "POST", body });
      setDraft({});
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(id: string) {
    try {
      await api(`/${def.key}/${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section>
      <h2>{def.title}</h2>
      {error && <div className="error">{error}</div>}
      <table>
        <thead>
          <tr>
            {def.columns.map((c) => <th key={c}>{c}</th>)}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r[def.pk])}>
              {def.columns.map((c) => <td key={c}>{fmt(r[c])}</td>)}
              <td><button className="del" onClick={() => remove(String(r[def.pk]))}>delete</button></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={def.columns.length + 1} className="muted">none</td></tr>}
        </tbody>
      </table>

      <div className="add">
        {def.fields.map((f) => (
          f.type === "checkbox" ? (
            <label key={f.name} className="cb">
              <input
                type="checkbox"
                checked={Boolean(draft[f.name])}
                onChange={(e) => setDraft({ ...draft, [f.name]: e.target.checked })}
              /> {f.label}
            </label>
          ) : (
            <input
              key={f.name}
              placeholder={f.label}
              type={f.type === "number" ? "number" : f.name === "password" ? "password" : "text"}
              value={String(draft[f.name] ?? "")}
              onChange={(e) => setDraft({ ...draft, [f.name]: e.target.value })}
            />
          )
        ))}
        <button className="primary" onClick={create}>Add</button>
      </div>
    </section>
  );
}

interface Message extends Row { id: string; mail_from: string; rcpt_to: string[]; status: string; }
interface Event extends Row { kind: string; provider: string | null; detail: string | null; at: string; }

function MessagesPanel() {
  const [rows, setRows] = useState<Message[]>([]);
  const [q, setQ] = useState("");
  const [events, setEvents] = useState<Record<string, Event[]>>({});

  async function load() {
    const path = q ? `/messages?q=${encodeURIComponent(q)}` : "/messages";
    setRows(await api<Message[]>(path));
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, []);

  async function toggle(id: string) {
    if (events[id]) { const e = { ...events }; delete e[id]; setEvents(e); return; }
    setEvents({ ...events, [id]: await api<Event[]>(`/messages/${id}/events`) });
  }

  const badge = (s: string) => <span className={`badge ${s}`}>{s}</span>;

  return (
    <section>
      <h2>Message tracing</h2>
      <div className="add">
        <input placeholder="search sender/recipient" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="primary" onClick={() => void load()}>Search</button>
      </div>
      <table>
        <thead><tr><th>from</th><th>to</th><th>status</th><th>attempts</th><th>created</th><th /></tr></thead>
        <tbody>
          {rows.map((m) => (
            <>
              <tr key={m.id}>
                <td>{m.mail_from || "<>"}</td>
                <td>{fmt(m.rcpt_to)}</td>
                <td>{badge(m.status)}</td>
                <td>{fmt(m.attempts)}</td>
                <td>{fmt(m.created_at)}</td>
                <td><button onClick={() => void toggle(m.id)}>{events[m.id] ? "hide" : "trace"}</button></td>
              </tr>
              {events[m.id] && (
                <tr key={m.id + "-ev"}>
                  <td colSpan={6}>
                    <ol className="timeline">
                      {events[m.id].map((e, i) => (
                        <li key={i}>{badge(e.kind)} {e.provider && <em>{e.provider}</em>} {e.detail} <span className="muted">{fmt(e.at)}</span></li>
                      ))}
                    </ol>
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function App() {
  const tabs = [...RESOURCES.map((r) => r.title), "Messages"];
  const [tab, setTab] = useState(tabs[0]);
  return (
    <div className="app">
      <header>
        <h1>novamail</h1>
        <nav>
          {tabs.map((t) => (
            <button key={t} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>{t}</button>
          ))}
        </nav>
      </header>
      <main>
        {tab === "Messages"
          ? <MessagesPanel />
          : <ResourcePanel def={RESOURCES.find((r) => r.title === tab)!} />}
      </main>
    </div>
  );
}
