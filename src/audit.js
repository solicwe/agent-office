// Audit log: one JSON Lines file per Claude Code session (logs/<session_id>.jsonl).
// Each entry carries the hash of the entry before it (a hash chain), so changing,
// removing or reordering any line breaks every hash after it. Tamper-evident, not
// tamper-proof: whoever owns the machine could rebuild the whole chain, which is
// why session heads are also anchored in git (src/anchor.js).
import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const GENESIS = "0".repeat(64);
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Stable JSON: keys sorted, so the same entry always hashes the same. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
// Normalised through JSON first, so what is hashed is exactly what is written to the file.
export const hashEntry = (entry) => createHash("sha256").update(canonical(JSON.parse(JSON.stringify({ ...entry, hash: undefined })))).digest("hex");

export class AuditLog {
  constructor(dir) {
    this.dir = dir;
    this.heads = new Map(); // session -> { seq, hash }
    mkdirSync(dir, { recursive: true });
  }

  file(sessionId) {
    if (!SAFE_ID.test(sessionId)) throw new Error("bad session id");
    return path.join(this.dir, `${sessionId}.jsonl`);
  }

  head(sessionId) {
    if (this.heads.has(sessionId)) return this.heads.get(sessionId);
    const entries = this.read(sessionId);
    const last = entries.at(-1);
    const h = last ? { seq: last.seq, hash: last.hash } : { seq: -1, hash: GENESIS };
    this.heads.set(sessionId, h);
    return h;
  }

  /** Add one entry to the session's chain and return it (with seq, ts, prev, hash). */
  append(sessionId, type, data = {}) {
    const h = this.head(sessionId);
    // The chain fields come last so data can never overwrite them.
    const entry = { ...data, session_id: sessionId, seq: h.seq + 1, ts: new Date().toISOString(), type, prev: h.hash };
    entry.hash = hashEntry(entry);
    appendFileSync(this.file(sessionId), JSON.stringify(entry) + "\n");
    this.heads.set(sessionId, { seq: entry.seq, hash: entry.hash });
    return entry;
  }

  read(sessionId) {
    const f = this.file(sessionId);
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l, i) => {
      try { return JSON.parse(l); } catch { return { seq: i, type: "unreadable", raw: l }; }
    });
  }

  sessions() {
    return readdirSync(this.dir).filter((n) => n.endsWith(".jsonl") && SAFE_ID.test(n.slice(0, -6))).map((n) => {
      const id = n.slice(0, -6);
      const e = this.read(id);
      return {
        session_id: id,
        started: e[0]?.ts || null,
        updated: e.at(-1)?.ts || null,
        prompts: e.filter((x) => x.type === "user_prompt").length,
        agents: [...new Set(e.filter((x) => x.type === "agent_assigned").map((x) => x.agent))],
        first_prompt: e.find((x) => x.type === "user_prompt")?.prompt?.slice(0, 120) || "",
        entries: e.length,
        imported: Boolean(e[0]?.imported),
        source: e[0]?.imported ? e[0].source : e[0]?.source === "codex" ? "codex" : "claude-code",
        friend: e[0]?.friend || "",
        head: e.at(-1)?.hash || null,
      };
    }).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  }
}

/** Recompute the chain. ok, or the first entry that does not match. */
export function verify(entries) {
  let prev = GENESIS;
  if (!entries.length) return { ok: false, at: 0, reason: "log ว่าง ไม่มีอะไรให้ตรวจ" };
  const sid = entries[0].session_id;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.session_id !== sid) return { ok: false, at: i, reason: `entry ${i} เป็นของ session อื่น (${e.session_id})` };
    if (e.seq !== i) return { ok: false, at: i, reason: `ลำดับ seq ผิดที่ ${i} (เจอ ${e.seq}) มีบรรทัดหายหรือสลับ` };
    if (e.prev !== prev) return { ok: false, at: i, reason: `prev ของ entry ${i} ไม่ตรงกับ hash ของ entry ก่อนหน้า` };
    if (hashEntry(e) !== e.hash) return { ok: false, at: i, reason: `เนื้อหาของ entry ${i} ถูกแก้ (hash ไม่ตรง)` };
    prev = e.hash;
  }
  return { ok: true, count: entries.length, head: prev };
}
