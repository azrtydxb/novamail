// Minimal HS256 JWT for operator sessions (no extra dependency). The signing
// secret is NOVAMAIL_ADMIN_JWT_SECRET, falling back to the admin API key so the
// feature works without additional config in small deployments.
import crypto from "crypto";

const SECRET = process.env.NOVAMAIL_ADMIN_JWT_SECRET || process.env.NOVAMAIL_ADMIN_API_KEY || "dev-secret";

const b64url = (s: Buffer | string) => Buffer.from(s).toString("base64url");

export interface OperatorClaims {
  sub: string;
  username: string;
  role: string;
  exp?: number;
}

export function signToken(claims: Omit<OperatorClaims, "exp">, ttlSeconds = 86400): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const data = `${header}.${body}`;
  const sig = crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifyToken(token: string): OperatorClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const expect = crypto.createHmac("sha256", SECRET).update(`${parts[0]}.${parts[1]}`).digest("base64url");
  const got = Buffer.from(parts[2]);
  const exp = Buffer.from(expect);
  if (got.length !== exp.length || !crypto.timingSafeEqual(got, exp)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as OperatorClaims;
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// bearerOperator extracts and verifies the operator from an Authorization header.
export function bearerOperator(authHeader?: string): OperatorClaims | null {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return verifyToken(authHeader.slice(7));
}
