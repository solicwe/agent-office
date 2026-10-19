// Local Codex rollout adapter. The on-disk format is observed, not a stable API.
// Reads only matching workspaces, never modifies Codex files, skips history on first discovery.
import { readdirSync, openSync, readSync, closeSync, statSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const clip = (s, n = 20000) => String(s ?? '').slice(0, n);
const text = (v) => typeof v === 'string' ? v : Array.isArray(v) ? v.map(x => x.text || '').join('\n') : '';
const digest = s => createHash('sha256').update(String(s)).digest('hex');
function files(dir) {
  try { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : e.isFile() && e.name.endsWith('.jsonl') ? [path.join(dir, e.name)] : []); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function firstLine(file) {
  const fd = openSync(file, 'r');
  try { const b = Buffer.alloc(1024 * 1024); const n = readSync(fd, b, 0, b.length, 0); const end = b.indexOf(10, 0); return end >= 0 && end < n ? JSON.parse(b.subarray(0, end).toString()) : null; }
  finally { closeSync(fd); }
}

export class CodexBridge {
  constructor({ dir, workspace, stateFile, audit, emit, onRoundEnd = () => {} }) {
    Object.assign(this, { dir, workspace: path.resolve(workspace), stateFile, audit, emit, onRoundEnd });
    this.startedAt = Date.now();
    this.initialized = false;
    this.status = { enabled: true, mode: 'local-rollout', files: 0, error: null };
    try { this.state = JSON.parse(readFileSync(stateFile, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw new Error(`Cannot read Codex cursor: ${e.message}`); this.state = { files: {}, sessions: {} }; }
  }
  save() {
    mkdirSync(path.dirname(this.stateFile), { recursive: true });
    writeFileSync(this.stateFile + '.tmp', JSON.stringify(this.state));
    renameSync(this.stateFile + '.tmp', this.stateFile);
  }
  handle(record, meta) {
    const id = meta.id || meta.session_id;
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id || '')) return;
    const sid = `codex-${id}`;
    const p = record.payload || {};
    const s = this.state.sessions[sid] ||= { seen: [], active: false };
    const log = (type, data) => this.audit.append(sid, type, { source: 'codex', capture: 'local-rollout', event_timestamp: record.timestamp || null, ...data });
    const vis = (type, data = {}) => this.emit({ type, session_id: sid, source: 'codex', folder: path.basename(meta.cwd), ...data });
    const once = key => { if (s.seen.includes(key)) return false; s.seen.push(key); if(s.seen.length > 1000) s.seen.shift(); return true; };
    const ensure = () => {
      if (!s.logged) {
        if (!this.audit.read(sid).length) { log('session_start', { cwd: meta.cwd, model: 'Codex', partial: true }); vis('SESSION_START'); }
        s.logged = true;
      }
    };
    if (record.type === 'event_msg') {
      const item = p.item || {};
      if (p.type === 'user_message' || (p.type === 'item_completed' && item.type === 'UserMessage')) {
        const prompt = p.message || text(item.content);
        if (!once(`prompt:${p.turn_id || digest(prompt)}`)) return;
        ensure(); s.active = true; s.started = Date.now();
        log('user_prompt', { prompt: clip(prompt), prompt_sha256: digest(prompt), cwd: meta.cwd });
        vis('ORCHESTRATOR_THINKING', { text: clip(prompt, 120) });
      } else if (p.type === 'task_started') {
        if (!once(`start:${p.turn_id || record.timestamp}`)) return;
        ensure(); s.active = true; s.started = Date.now(); vis('AGENT_WORKING', { agent: 'orchestrator', badge: 'Codex เริ่มทำงาน' });
      } else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
        if (!once(`end:${p.turn_id || record.timestamp}`)) return;
        ensure(); s.active = false;
        const output = p.last_agent_message || (p.type === 'turn_aborted' ? 'หยุดงานแล้ว' : '');
        log('final_response', { text: clip(output), text_sha256: digest(output), agents_used: [], agent_count: 0, duration_ms: p.duration_ms ?? (s.started ? Date.now() - s.started : null), interrupted: p.type === 'turn_aborted' });
        vis('TASK_COMPLETE', { summary: clip(output, 160), agents: 0 }); this.onRoundEnd(sid);
      } else if (p.type === 'item_completed' && ['CommandExecution', 'FileChange', 'McpToolCall'].includes(item.type)) {
        if (!once(`item:${item.id || digest(JSON.stringify(item))}`)) return;
        ensure();
        const summary = item.type === 'CommandExecution' ? `รัน ${clip(item.command, 100)}` : item.type === 'FileChange' ? 'แก้ไฟล์' : `ใช้ ${item.tool}`;
        log('tool_call', { actor: 'orchestrator', tool: item.type, summary, tool_use_id: item.id, status: item.status, exit_code: item.exit_code ?? null });
        vis('AGENT_WORKING', { agent: 'orchestrator', badge: summary, tool: item.type });
      }
    } else if (record.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p.type)) {
      if (!once(`call:${p.call_id || p.id || digest(JSON.stringify(p))}`)) return;
      ensure();
      log('tool_call', { actor: 'orchestrator', tool: p.name, summary: `ใช้ ${p.name}`, tool_use_id: p.call_id || p.id, input_sha256: digest(p.arguments || p.input || '') });
      vis('AGENT_WORKING', { agent: 'orchestrator', badge: `ใช้ ${p.name}`, tool: p.name });
    }
  }
  poll() {
    try {
      for (const file of files(this.dir)) {
        let cursor = this.state.files[file];
        const first = firstLine(file);
        if (!first) continue;
        const metadata = first.type === 'session_meta' ? first.payload : null;
        // Approval reviewers and other internal workers are not user chats.
        if (!metadata?.cwd || path.resolve(metadata.cwd) !== this.workspace ||
            (metadata.thread_source && metadata.thread_source !== 'user') ||
            (metadata.source && typeof metadata.source !== 'string')) {
          delete this.state.files[file]; continue;
        }
        const stat = statSync(file);
        if (!cursor) {
          const meta = metadata;
          if (!meta?.cwd || path.resolve(meta.cwd) !== this.workspace) continue;
          // Start from EOF: earlier conversations must not be imported or replayed.
          const cleanMeta = { id: meta.id || meta.session_id, cwd: meta.cwd };
          cursor = this.state.files[file] = { offset: this.initialized ? 0 : stat.size, meta: cleanMeta };
          if (!this.initialized) continue;
        }
        if (stat.size < cursor.offset) { cursor.offset = stat.size; continue; }
        const fd = openSync(file, 'r');
        try {
          const b = Buffer.alloc(Math.min(stat.size - cursor.offset, 4 * 1024 * 1024));
          const n = readSync(fd, b, 0, b.length, cursor.offset);
          const end = b.subarray(0, n).lastIndexOf(10);
          if (end < 0) continue; // leave partial JSON/UTF-8 untouched until the next poll
          for (const line of b.subarray(0, end).toString('utf8').split('\n')) {
            let r; try { r = JSON.parse(line); } catch { continue; }
            if (Date.parse(r.timestamp) >= this.startedAt || this.state.sessions[`codex-${cursor.meta.id}`]) this.handle(r, cursor.meta);
          }
          cursor.offset += end + 1;
        } finally { closeSync(fd); }
      }
      this.initialized = true; this.save(); this.status.files = Object.keys(this.state.files).length; this.status.error = null;
    } catch (e) { this.status.error = e.message; }
    return this.status;
  }
  start() { this.poll(); this.timer = setInterval(() => this.poll(), 1000); this.timer.unref(); return this; }
  stop() { clearInterval(this.timer); }
}
