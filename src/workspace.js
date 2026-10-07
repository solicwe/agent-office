// A project is a flat map of relative path -> file content, kept in memory.
import { crc32 } from "node:zlib";

const MAX_FILE_BYTES = 200_000;

export function safePath(p) {
  const clean = String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\.?\/+/, "")
    .split("/")
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .join("/");
  return /^[\w\-./ ]+$/.test(clean) ? clean : "";
}

/** Parse <file path="...">content</file> blocks from an agent reply. */
export function parseFiles(text) {
  const out = [];
  const re = /<file\s+path=["']([^"']+)["']\s*>([\s\S]*?)(?:<\/file>|$(?![\s\S]))/gi;
  let m;
  while ((m = re.exec(text))) {
    const path = safePath(m[1]);
    if (!path) continue;
    out.push({ path, content: stripFence(m[2]).slice(0, MAX_FILE_BYTES) });
  }
  return out;
}

function stripFence(s) {
  const t = s.replace(/^\s*\n/, "").replace(/\s+$/, "");
  const m = t.match(/^```[\w-]*\s*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : t) + "\n";
}

export function tree(files) {
  return Object.keys(files).sort().map((p) => `- ${p} (${files[p].length} chars)`).join("\n") || "(empty project)";
}

/**
 * Render files for a prompt. `focus` paths are always included in full; other
 * files are included until the budget runs out, then listed by name only.
 */
export function digest(files, focus = [], budget = 120_000) {
  const paths = Object.keys(files).sort();
  const ordered = [...focus.filter((p) => files[p] != null), ...paths.filter((p) => !focus.includes(p))];
  const parts = [];
  const skipped = [];
  let used = 0;
  for (const p of ordered) {
    const body = files[p];
    if (used + body.length > budget && !focus.includes(p)) {
      skipped.push(p);
      continue;
    }
    used += body.length;
    parts.push(`<file path="${p}">\n${body}</file>`);
  }
  if (skipped.length) parts.push(`(Not shown to save space: ${skipped.join(", ")})`);
  return parts.join("\n\n") || "(no files yet)";
}

/** Minimal ZIP writer (stored, no compression) so downloads need no dependency. */
export function zip(files, root = "project") {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const name = enc.encode(`${root}/${path}`);
    const data = Buffer.from(content, "utf8");
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const count = Object.keys(files).length;
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
