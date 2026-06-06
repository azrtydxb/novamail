// Operator authentication via better-auth (email + password, cookie sessions).
// Reuses the shared Postgres pool. The admin plugin adds roles (admin/user) and
// server/HTTP endpoints for managing operators. Cookie security is inferred from
// baseURL (https → Secure cookies).
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { pool } from "./db.js";

const baseURL = process.env.BETTER_AUTH_URL || "http://localhost:3000";
// trustedOrigins = the public GUI origin (baseURL) plus any explicit overrides.
// No hardcoded localhost defaults (those would weaken CSRF in production).
const trustedOrigins = Array.from(new Set([
  baseURL,
  ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
]));

// Fail fast: a real signing secret is mandatory (no insecure default). A weak or
// missing secret means session tokens can be forged → full admin takeover.
const secret = process.env.BETTER_AUTH_SECRET || process.env.NOVAMAIL_ADMIN_JWT_SECRET || process.env.NOVAMAIL_ADMIN_API_KEY;
if (!secret || secret.length < 16) {
  throw new Error("BETTER_AUTH_SECRET (or NOVAMAIL_ADMIN_API_KEY) must be set to a strong value (>=16 chars)");
}

export const auth = betterAuth({
  database: pool,
  baseURL,
  secret,
  basePath: "/api/auth",
  trustedOrigins,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    requireEmailVerification: false,
  },
  // 'user' role = read-only viewer; 'admin' = full read/write + operator mgmt.
  plugins: [admin({ defaultRole: "user", adminRoles: ["admin"] })],
});

export type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;
