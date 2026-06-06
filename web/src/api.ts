// Same-origin API client. nginx proxies /api to the admin-api. Operators
// authenticate via /api/auth/login and the returned bearer token is sent on
// every request (persisted to localStorage so a refresh stays logged in).
let token: string | null = null;
try {
  token = localStorage.getItem("nm:token");
} catch {
  /* ignore */
}

export function setToken(t: string | null): void {
  token = t;
  try {
    if (t) localStorage.setItem("nm:token", t);
    else localStorage.removeItem("nm:token");
  } catch {
    /* ignore */
  }
}

export function hasToken(): boolean {
  return !!token;
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).error ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
