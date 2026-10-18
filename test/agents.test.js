import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadAgents, parseAgentFile, parseFrontmatter } from "../src/agents.js";

test("the 7 starting roles load, in team order, with the orchestrator first", () => {
  const p = loadAgents(".claude/agents");
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.agents.map((a) => a.id), ["pm", "architect", "frontend", "backend", "qa", "debugger", "reviewer"]);
  assert.equal(p.all[0].id, "orchestrator");
  assert.equal(p.all.at(-1).id, "helper");
  const mia = p.agents.find((a) => a.id === "frontend");
  assert.equal(mia.name, "Mia");
  assert.equal(mia.avatar, "headphones");
  assert.match(mia.sha256, /^[0-9a-f]{64}$/);
  assert.match(mia.instructions, /Frontend Engineer/);
});

test("the template in docs is a valid role once copied", () => {
  const r = parseAgentFile("data-analyst.md", readFileSync("docs/agent-template.md", "utf8"));
  assert.equal(r.error, undefined);
  assert.equal(r.agent.id, "data-analyst");
  assert.equal(r.agent.color, "#2f7d9c", "inline # comments are not part of the value");
  assert.deepEqual(r.agent.specialties, ["data", "statistics", "charts"]);
});

test("broken files are reported with what to fix, and never stop the others", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "roles-"));
  writeFileSync(path.join(dir, "good.md"), "---\nname: writer\ndescription: Writes things\n---\nYou write.");
  writeFileSync(path.join(dir, "noname.md"), "---\ndescription: x\n---\n");
  writeFileSync(path.join(dir, "nohead.md"), "just text");
  writeFileSync(path.join(dir, "Bad Name.md"), "---\nname: Bad Name\ndescription: x\n---\n");
  writeFileSync(path.join(dir, "dup.md"), "---\nname: writer\ndescription: again\n---\n");
  const p = loadAgents(dir);
  assert.deepEqual(p.agents.map((a) => a.id), ["writer"]);
  assert.equal(p.errors.length, 4);
  assert.ok(p.errors.every((e) => e.file && e.message));
  assert.ok(p.agents[0].avatar && p.agents[0].color, "looks are filled in when not given");
});

test("frontmatter: lists, quoted values, block text, Windows line endings", () => {
  const { data } = parseFrontmatter("---\r\nname: a\r\ntags:\r\n  - x\r\n  - y\r\ncolor: \"#123456\"\r\nnote: |\r\n  line one\r\n  line two\r\n---\r\nbody");
  assert.deepEqual(data.tags, ["x", "y"]);
  assert.equal(data.color, "#123456");
  assert.equal(data.note, "line one\nline two");
});
