import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSend, isPrivateAddr, validWebhookURL } from "./alerts.js";

test("shouldSend: severity filtering (warn+ vs errors-only)", () => {
  // warn-threshold channel gets both warning and error regressions.
  assert.equal(shouldSend({ min_severity: "warning" }, "regression", "warning"), true);
  assert.equal(shouldSend({ min_severity: "warning" }, "regression", "error"), true);
  // error-threshold channel ignores warning regressions.
  assert.equal(shouldSend({ min_severity: "error" }, "regression", "warning"), false);
  assert.equal(shouldSend({ min_severity: "error" }, "regression", "error"), true);
  // recovery always goes through.
  assert.equal(shouldSend({ min_severity: "error" }, "recovery", "ok"), true);
});

test("isPrivateAddr: blocks internal targets (SSRF guard)", () => {
  for (const ip of ["10.0.0.1", "127.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "::1", "fe80::1", "fc00::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateAddr(ip), true, `${ip} should be private`);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "203.0.113.5", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateAddr(ip), false, `${ip} should be public`);
  }
});

test("validWebhookURL: rejects unparseable / non-http(s)", () => {
  assert.equal(validWebhookURL("https://hooks.slack.com/services/abc"), true);
  assert.equal(validWebhookURL("http://example.com/hook"), true);
  assert.equal(validWebhookURL("http://"), false); // no host
  assert.equal(validWebhookURL("ftp://example.com"), false);
  assert.equal(validWebhookURL("not a url"), false);
  assert.equal(validWebhookURL(""), false);
});
