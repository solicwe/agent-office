// share/ is what friends download to use the roles without Agent Office.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildShare } from "../scripts/export-team.js";
import { loadAgents } from "../src/agents.js";

const norm = (s) => s.replace(/\r\n/g, "\n"); // git may check files out with CRLF on Windows

function onDisk(dir, base = dir, out = {}) {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) onDisk(p, base, out);
    else out[path.relative(base, p).replace(/\\/g, "/")] = norm(readFileSync(p, "utf8"));
  }
  return out;
}

test("share/ matches the roles (run npm run export-team after editing a role)", () => {
  const want = buildShare();
  const have = onDisk("share");
  assert.deepEqual(Object.keys(have).sort(), Object.keys(want).sort());
  for (const [rel, content] of Object.entries(want)) assert.equal(have[rel], norm(content), `share/${rel} is out of date`);
});

test("the team prompt names every role and the way of working", () => {
  const t = buildShare()["TEAM_PROMPT.md"];
  for (const id of ["pm", "architect", "frontend", "backend", "qa", "debugger", "reviewer"]) assert.match(t, new RegExp(`\\(${id}\\)`));
  assert.match(t, /Plan the team/);
  assert.match(t, /Final answer/);
  assert.doesNotMatch(t, /^---$\nname:/m, "no Claude Code frontmatter in a chat prompt");
});

test("the Claude Code copies load as valid roles", () => {
  const p = loadAgents("share/claude-code");
  assert.deepEqual(p.errors, []);
  assert.equal(p.agents.length, 7);
});

test("a broken role stops the export with a clear message", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "share-"));
  writeFileSync(path.join(dir, "x.md"), "---\ndescription: no name\n---\n");
  assert.throws(() => buildShare(dir), /fix these role files first: x\.md/);
});
