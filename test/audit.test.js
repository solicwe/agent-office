import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditLog, verify, GENESIS } from "../src/audit.js";

const fresh = () => new AuditLog(mkdtempSync(path.join(tmpdir(), "audit-")));

test("entries chain: each one carries the hash of the one before", () => {
  const log = fresh();
  const a = log.append("s1", "user_prompt", { prompt: "สวัสดี" });
  const b = log.append("s1", "final_response", { text: "ok" });
  assert.equal(a.prev, GENESIS);
  assert.equal(b.prev, a.hash);
  assert.equal(b.seq, 1);
  assert.deepEqual(verify(log.read("s1")), { ok: true, count: 2, head: b.hash });
});

test("the chain survives a restart (a new logger continues it)", () => {
  const log = fresh();
  log.append("s1", "a");
  const again = new AuditLog(log.dir);
  const c = again.append("s1", "b");
  assert.equal(c.seq, 1);
  assert.equal(verify(again.read("s1")).ok, true);
});

test("any edit, removal or reordering is detected", () => {
  const log = fresh();
  for (let i = 0; i < 4; i++) log.append("s1", "step", { n: i });
  const file = log.file("s1");
  const lines = readFileSync(file, "utf8").trim().split("\n");

  const edited = lines.map((l, i) => (i === 1 ? l.replace('"n":1', '"n":9') : l));
  writeFileSync(file, edited.join("\n") + "\n");
  assert.match(verify(log.read("s1")).reason, /ถูกแก้/);

  writeFileSync(file, [lines[0], lines[2], lines[3]].join("\n") + "\n");
  assert.equal(verify(log.read("s1")).ok, false, "a removed line");

  writeFileSync(file, [lines[0], lines[2], lines[1], lines[3]].join("\n") + "\n");
  assert.equal(verify(log.read("s1")).ok, false, "swapped lines");
});

test("an empty log, a line from another session, or data posing as chain fields never pass", () => {
  assert.equal(verify([]).ok, false);
  const log = fresh();
  const e = log.append("s1", "x", { seq: 99, session_id: "other", prev: "fake", type: "forged" });
  assert.deepEqual([e.seq, e.session_id, e.type, e.prev], [0, "s1", "x", GENESIS], "chain fields win over data");
  const other = new AuditLog(log.dir).append("s2", "y");
  assert.match(verify([e, { ...other, seq: 1, prev: e.hash }]).reason, /session อื่น/);
});

test("session ids cannot be used to write outside the log folder", () => {
  assert.throws(() => fresh().append("../evil", "x"), /bad session id/);
});
