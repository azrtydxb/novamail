import { test } from "node:test";
import assert from "node:assert/strict";
import { pick } from "./routes.js";

// pick() is the mass-assignment / SQL-identifier guard for the generic CRUD:
// only whitelisted columns reach the (string-interpolated) column list, and
// values are always parameterized. These invariants must hold.
test("pick keeps only whitelisted columns", () => {
  const [keys, vals] = pick({ name: "x", evil: "DROP", priority: 5 }, ["name", "priority"]);
  assert.deepEqual(keys, ["name", "priority"]);
  assert.deepEqual(vals, ["x", 5]);
});

test("pick drops undefined but keeps falsy values (false/0/''/null)", () => {
  const [keys, vals] = pick(
    { enabled: false, burst: 0, note: "", parent: null, skip: undefined },
    ["enabled", "burst", "note", "parent", "skip"],
  );
  assert.deepEqual(keys, ["enabled", "burst", "note", "parent"]);
  assert.deepEqual(vals, [false, 0, "", null]);
});

test("pick ignores keys not in the whitelist even if present", () => {
  const [keys] = pick({ id: "spoof", role: "admin" }, ["name"]);
  assert.deepEqual(keys, []); // nothing writable → caller returns 400
});
