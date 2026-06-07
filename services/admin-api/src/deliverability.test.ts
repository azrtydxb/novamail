import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeDkim, gradeSpf, gradeDmarc, providerMechanism, rollup } from "./deliverability.js";

const KEY = "MIIBIjANBgkqExamplePublicKeyBase64==";

test("providerMechanism maps known types, null for generic smtp", () => {
  assert.equal(providerMechanism("ses"), "include:amazonses.com");
  assert.equal(providerMechanism("gmail"), "include:_spf.google.com");
  assert.equal(providerMechanism("m365"), "include:spf.protection.outlook.com");
  assert.equal(providerMechanism("smtp"), null);
  assert.equal(providerMechanism("nonsense"), null);
});

test("gradeDkim: published key matches → ok", () => {
  const r = gradeDkim(`v=DKIM1; k=rsa; p=${KEY}`, KEY, "active", "nm1", "example.com");
  assert.equal(r.status, "ok");
});

test("gradeDkim: published but key differs (active) → error with expected record", () => {
  const r = gradeDkim("v=DKIM1; k=rsa; p=WRONGKEY", KEY, "active", "nm1", "example.com");
  assert.equal(r.status, "error");
  assert.equal(r.fix, `v=DKIM1; k=rsa; p=${KEY}`);
});

test("gradeDkim: matches even when DNS chunked the key with whitespace", () => {
  const chunked = `v=DKIM1; k=rsa; p=${KEY.slice(0, 10)} ${KEY.slice(10)}`;
  assert.equal(gradeDkim(chunked, KEY, "active", "nm1", "example.com").status, "ok");
});

test("gradeDkim: missing active → error; missing retiring → warning", () => {
  assert.equal(gradeDkim(null, KEY, "active", "nm1", "example.com").status, "error");
  assert.equal(gradeDkim(null, KEY, "retiring", "nm0", "example.com").status, "warning");
});

test("gradeDkim: revoked still published → warning; revoked absent → ok", () => {
  assert.equal(gradeDkim("v=DKIM1; k=rsa; p=old", KEY, "revoked", "old", "example.com").status, "warning");
  assert.equal(gradeDkim(null, KEY, "revoked", "old", "example.com").status, "ok");
});

test("gradeSpf: missing → error with a built record", () => {
  const r = gradeSpf([], ["include:amazonses.com"]);
  assert.equal(r.status, "error");
  assert.equal(r.fix, "v=spf1 include:amazonses.com -all");
});

test("gradeSpf: present + has required include → ok", () => {
  assert.equal(gradeSpf(["v=spf1 include:amazonses.com -all"], ["include:amazonses.com"]).status, "ok");
});

test("gradeSpf: present but missing include → warning, fix inserts before all", () => {
  const r = gradeSpf(["v=spf1 include:_spf.google.com ~all"], ["include:amazonses.com"]);
  assert.equal(r.status, "warning");
  assert.equal(r.fix, "v=spf1 include:_spf.google.com include:amazonses.com ~all");
});

test("gradeSpf: more than one SPF record → error", () => {
  assert.equal(gradeSpf(["v=spf1 -all", "v=spf1 include:amazonses.com -all"], []).status, "error");
});

test("gradeSpf: generic route (no required includes) but valid → info", () => {
  assert.equal(gradeSpf(["v=spf1 ip4:10.0.0.1 -all"], []).status, "info");
});

test("gradeDmarc: missing → error; p=none → warning; p=reject+rua → ok", () => {
  assert.equal(gradeDmarc([]).status, "error");
  assert.equal(gradeDmarc(["v=DMARC1; p=none"]).status, "warning");
  assert.equal(gradeDmarc(["v=DMARC1; p=reject; rua=mailto:d@example.com"]).status, "ok");
});

test("gradeDmarc: enforcing but no rua → warning", () => {
  assert.equal(gradeDmarc(["v=DMARC1; p=quarantine"]).status, "warning");
});

test("rollup picks the worst status", () => {
  assert.equal(rollup([{ record: "spf", status: "ok", found: null, detail: "" }, { record: "dmarc", status: "warning", found: null, detail: "" }]), "warning");
  assert.equal(rollup([{ record: "spf", status: "warning", found: null, detail: "" }, { record: "dkim", status: "error", found: null, detail: "" }]), "error");
});
