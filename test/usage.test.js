import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "agent-office-usage-"));
process.env.USAGE_FILE = path.join(dir, "usage.json");
process.env.TOKEN_BUDGET = "100000";
const usage = await import("../src/usage.js");
test.after(() => rm(dir, { recursive: true, force: true }));

test("tokens reported by the API are subtracted from the budget", () => {
  usage.addUsage(1200, 300);
  assert.equal(usage.snapshot().used, 1500);
  assert.equal(usage.snapshot().remaining, 98_500);
});

test("setting the real remaining balance makes the counter match it", () => {
  usage.configure({ remaining: 50_000 });
  assert.equal(usage.snapshot().remaining, 50_000);
  usage.addUsage(1000, 0);
  assert.equal(usage.snapshot().remaining, 49_000);
  assert.ok(usage.snapshot().syncedAt);
});
