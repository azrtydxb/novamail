// Operator authentication via better-auth (email + password, cookie sessions).
// Reuses the shared Postgres pool. The admin plugin adds roles (admin/user) and
// server/HTTP endpoints for managing operators. Cookie security is inferred from
// baseURL (https → Secure cookies).
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { pool } from "./db.js";

const baseURL = process.env.BETTER_AUTH_URL || "http://localhost:3000";
const trustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ||
  "https://novamail.kw.local,http://localhost:5173,http://localhost:5181,http://localhost:5182")
  .split(",").map((s) => s.trim()).filter(Boolean);

export const auth = betterAuth({
  database: pool,
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET || process.env.NOVAMAIL_ADMIN_JWT_SECRET || process.env.NOVAMAIL_ADMIN_API_KEY || "dev-secret-change-me",
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
