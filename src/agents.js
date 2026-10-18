// The Agent Pool: every role is one Markdown file in .claude/agents/ — the same files
// Claude Code reads for its subagents. Frontmatter (between --- lines) holds the fields;
// the body is the role's instructions. Extra fields (display_name, role_title, avatar,
// color) are only for the office on screen; Claude Code ignores them.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const LOOKS = ["bob", "hardhat", "headphones", "cap", "goggles", "glasses", "beanie"];

/** The main Claude Code agent: it reads the request and hands work to the roles below. */
export const ORCHESTRATOR = {
  id: "orchestrator", name: "Claude", role_title: "Orchestrator", avatar: "glasses", color: "#d97757",
  description: "The main Claude Code agent. Reads your message, decides which roles to use, and combines their results.",
  builtin: true,
};
/** Claude Code's own subagents (Explore, Plan, general-purpose) share one helper desk. */
export const HELPER = {
  id: "helper", name: "Helper", role_title: "Built-in subagent", avatar: "cap", color: "#6b7a8f",
  description: "Claude Code's built-in subagents such as Explore and Plan.",
  builtin: true,
};

/** A small YAML subset: key: value, quoted strings, [a, b] lists, "- item" lists, | and > blocks. */
export function parseFrontmatter(text) {
  const src = String(text).replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: null, body: src, error: "ไม่มีส่วนหัว --- ... --- ที่บรรทัดแรก" };
  const data = {};
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) return { data: null, body: m[2], error: `อ่านบรรทัด ${i + 2} ของส่วนหัวไม่ได้: "${line.trim()}"` };
    const [, key] = kv;
    const raw = stripComment(kv[2]);
    let value = raw.trim();
    if (value === "|" || value === ">") {
      const block = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].trim());
      value = block.join(raw.trim() === "|" ? "\n" : " ").trim();
    } else if (value === "") {
      const items = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) items.push(unquote(lines[++i].replace(/^\s*-\s+/, "")));
      value = items.length ? items : "";
    } else if (value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1).split(",").map((s) => unquote(s)).filter(Boolean);
    } else {
      value = unquote(value);
    }
    data[key] = value;
  }
  return { data, body: m[2].trim(), error: null };
}

/** Drop a trailing "# comment" that is outside quotes. */
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function unquote(s) {
  const t = String(s).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** One .md file -> an agent, or an error saying exactly what to fix. */
export function parseAgentFile(file, text) {
  const { data, body, error } = parseFrontmatter(text);
  if (error) return { error };
  const id = String(data.name || "").trim();
  if (!id) return { error: "ต้องมี name: (ตัวพิมพ์เล็กและขีด เช่น frontend หรือ data-analyst)" };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return { error: `name "${id}" ใช้ได้แค่ a-z 0-9 และ - (เช่น data-analyst)` };
  if (!String(data.description || "").trim()) return { error: "ต้องมี description: บอกว่าเมื่อไรควรเรียกใช้ role นี้" };
  if (["orchestrator", "helper"].includes(id)) return { error: `name "${id}" สงวนไว้สำหรับระบบ ใช้ชื่ออื่น` };
  const avatar = LOOKS.includes(data.avatar) ? data.avatar : LOOKS[hashInt(id) % LOOKS.length];
  const color = /^#[0-9a-f]{6}$/i.test(data.color || "") ? data.color : `hsl(${hashInt(id) % 360} 45% 45%)`;
  return {
    agent: {
      id,
      name: String(data.display_name || id),
      role_title: String(data.role_title || ""),
      description: String(data.description),
      specialties: Array.isArray(data.specialties) ? data.specialties.map(String) : [],
      order: Number.isFinite(Number(data.order)) && data.order !== "" ? Number(data.order) : 100,
      tools: data.tools || null,
      model: data.model || null,
      avatar,
      color,
      file: path.basename(file),
      sha256: sha256(text),
      instructions: body,
    },
  };
}

function hashInt(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return h;
}

/** Read the whole pool. Broken files are reported, never fatal. */
export function loadAgents(dir) {
  const agents = [];
  const errors = [];
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".md") && !n.startsWith("_")).sort(); } catch { /* no folder yet */ }
  for (const n of names) {
    const file = path.join(dir, n);
    try {
      if (!statSync(file).isFile()) continue;
      const r = parseAgentFile(file, readFileSync(file, "utf8"));
      if (r.error) errors.push({ file: n, message: r.error });
      else if (agents.some((a) => a.id === r.agent.id)) errors.push({ file: n, message: `name "${r.agent.id}" ซ้ำกับไฟล์อื่น` });
      else agents.push(r.agent);
    } catch (err) {
      errors.push({ file: n, message: err.message });
    }
  }
  agents.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return { agents, errors, all: [ORCHESTRATOR, ...agents, HELPER] };
}
