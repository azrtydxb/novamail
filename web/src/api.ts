// Same-origin API client. nginx proxies /api to the admin-api. Operator auth is
// cookie-based (better-auth): the session cookie is set on login and sent
// automatically with every request (credentials: "include").
export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body) headers["content-type"] = "application/json";
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? "GET",
    headers,
    credentials: "include",
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = j.error?.message ?? j.message ?? j.error ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
