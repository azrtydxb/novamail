import crypto from "node:crypto";

// Envelope encryption matching internal/secrets (Go). A random per-secret data
// key (DEK) encrypts the plaintext; the master KEK wraps the DEK. Wire format:
//   {"v":1,"dek":b64(nonce||ct||tag with KEK),"data":b64(nonce||ct||tag with DEK)}
// AES-256-GCM, 12-byte nonce prepended, 16-byte tag appended.

function kek(): Buffer {
  const b64 = process.env.NOVAMAIL_SECRET_KEY;
  if (!b64) throw new Error("NOVAMAIL_SECRET_KEY not set");
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) throw new Error("master key must be 32 bytes");
  return k;
}

function sealGCM(key: Buffer, plaintext: Buffer): string {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([nonce, ct, tag]).toString("base64");
}

export function encrypt(plaintext: string): string {
  const dek = crypto.randomBytes(32);
  const data = sealGCM(dek, Buffer.from(plaintext, "utf8"));
  const wrapped = sealGCM(kek(), dek);
  return JSON.stringify({ v: 1, dek: wrapped, data });
}

function openGCM(key: Buffer, b64: string): Buffer {
  const buf = Buffer.from(b64, "base64");
  const nonce = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

// decrypt reverses encrypt(): unwrap the DEK with the KEK, then open the data.
export function decrypt(envelope: string): string {
  const { dek, data } = JSON.parse(envelope) as { dek: string; data: string };
  const rawDek = openGCM(kek(), dek);
  return openGCM(rawDek, data).toString("utf8");
}
