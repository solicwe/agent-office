// Anchoring against a stand-in for GitHub: a bare repository on disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { Anchor } from "../src/anchor.js";

const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();

function repos() {
  const root = mkdtempSync(path.join(tmpdir(), "anchor-"));
  const remote = path.join(root, "remote.git");
  const work = path.join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["init", "-q", work]);
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "Test");
  writeFileSync(path.join(work, "a.txt"), "hello\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-q", "-m", "init");
  git(work, "remote", "add", "origin", remote);
  return { work, remote };
}

test("each round's head goes to branch audit-log and is pushed; the working tree is untouched", async () => {
  const { work, remote } = repos();
  const head = git(work, "rev-parse", "HEAD");
  writeFileSync(path.join(work, "a.txt"), "edited but not committed\n");
  const anchor = new Anchor({ repo: work });
  const r1 = await anchor.anchor({ session_id: "s1", seq: 5, hash: "a".repeat(64) });
  const r2 = await anchor.anchor({ session_id: "s1", seq: 9, hash: "b".repeat(64) });
  assert.equal(r1.ok && r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.pushed, true);
  const lines = git(remote, "show", "audit-log:anchors.jsonl").split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.seq), [5, 9], "anchors accumulate");
  assert.equal(git(work, "rev-parse", "HEAD"), head, "current branch did not move");
  assert.equal(readFileSync(path.join(work, "a.txt"), "utf8"), "edited but not committed\n", "uncommitted work kept");
  assert.equal(git(work, "rev-parse", "--abbrev-ref", "HEAD"), git(work, "branch", "--show-current") || "master");
  assert.doesNotMatch(git(remote, "log", "-1", "--format=%B", "audit-log"), /claude|co-authored/i);
});

test("local mode commits but does not push", async () => {
  const { work, remote } = repos();
  const r = await new Anchor({ repo: work, push: false }).anchor({ session_id: "s2", seq: 0, hash: "c".repeat(64) });
  assert.equal(r.ok, true);
  assert.equal(r.pushed, false);
  assert.throws(() => git(remote, "rev-parse", "audit-log"));
});

test("outside a git repository it reports instead of failing", async () => {
  const r = await new Anchor({ repo: mkdtempSync(path.join(tmpdir(), "nogit-")) }).anchor({ session_id: "s", seq: 0, hash: "d".repeat(64) });
  assert.equal(r.ok, false);
});
