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
    const child = !!meta.parent_thread_id;
    const sid = `codex-${child ? meta.root_id : id}`;
    const actor = child ? meta.desk : 'orchestrator';
    const identity = { source_session_id: id, parent_session_id: meta.parent_thread_id || null, agent_path: meta.agent_path || null };
    const root = this.state.sessions[sid] ||= { seen: [], active: false };

    const p = record.payload || {};
    const s = child ? (this.state.sessions[`codex-${id}`] ||= { seen: [], active: false }) : root;
    const log = (type, data) => this.audit.append(sid, type, { source: 'codex', capture: 'local-rollout', event_timestamp: record.timestamp || null, source_event_id: p.call_id || p.item?.id || p.id || `${record.type}:${p.type}:${p.turn_id || record.timestamp || digest(JSON.stringify(p))}`, ...identity, ...data });
    const vis = (type, data = {}) => this.emit({ type, session_id: sid, source: 'codex', folder: path.basename(meta.cwd), ...identity, ...data });
    const once = key => { if (s.seen.includes(key)) return false; s.seen.push(key); return true; };
    const ensure = () => {
      if (child && (!s.assigned || !root.children?.includes(id))) {
        if (!root.logged) { if (!this.audit.read(sid).length) { log('session_start', { cwd: meta.cwd, model: 'Codex', partial: true }); vis('SESSION_START'); } root.logged = true; }
        s.assigned = true;
        root.children ||= [];
        root.child_roles ||= {}; root.child_roles[id] = actor;
        if (!root.children.includes(id)) root.children.push(id);
        log('agent_assigned', { actor, agent: actor, agent_type: meta.agent_path, subtask: meta.agent_path, input: meta.agent_path, execution: root.children.length > 1 ? 'parallel' : 'sequential', tool_use_id: `${id}:${p.turn_id || record.timestamp}`, parent_thread_id: meta.parent_thread_id });
        vis('AGENT_ASSIGNED', { from: 'orchestrator', to: actor, agent: meta.agent_path, subtask: meta.agent_path, parallel: root.children.length > 1 });
      }
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
        if (child) { log('agent_prompt', { actor, prompt: clip(prompt) }); return; }
        log('user_prompt', { prompt: clip(prompt), prompt_sha256: digest(prompt), cwd: meta.cwd });
        vis('ORCHESTRATOR_THINKING', { text: clip(prompt, 120) });
      } else if (p.type === 'task_started') {
        if (!once(`start:${p.turn_id || record.timestamp}`)) return;
        if (!child) { root.children = []; root.child_roles = {}; }
        ensure(); s.active = true; s.started = Date.now(); vis('AGENT_WORKING', { agent: actor, badge: 'Codex เริ่มทำงาน' });
      } else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
        if (!once(`end:${p.turn_id || record.timestamp}`)) return;
        ensure(); s.active = false;
        const output = p.last_agent_message || (p.type === 'turn_aborted' ? 'หยุดงานแล้ว' : '');
        log(child ? 'agent_result' : 'final_response', { ...(child ? { agent: actor, actor, output: clip(output), output_sha256: digest(output), tool_use_id: `${id}:${p.turn_id || record.timestamp}` } : {}), text: clip(output), text_sha256: digest(output), agents_used: (root.children || []).map(id => root.child_roles?.[id] || 'helper'), child_sessions: root.children || [], agent_count: root.children?.length || 0, duration_ms: p.duration_ms ?? (s.started ? Date.now() - s.started : null), interrupted: p.type === 'turn_aborted' });
        if (child) {
          s.assigned = false;
          log('agent_finished', { actor, agent: actor, interrupted: p.type === 'turn_aborted' });
          vis('AGENT_HANDOFF', { from: actor, to: 'orchestrator', summary: clip(output, 160) });
          vis('AGENT_DONE', { agent: actor });
        } else { vis('TASK_COMPLETE', { summary: clip(output, 160), agents: root.children?.length || 0 }); this.onRoundEnd(sid); }
      } else if (p.type === 'item_completed' && ['CommandExecution', 'FileChange', 'McpToolCall'].includes(item.type)) {
        if (!once(`item:${item.id || digest(JSON.stringify(item))}`)) return;
        ensure();
        const summary = item.type === 'CommandExecution' ? `รัน ${clip(item.command, 100)}` : item.type === 'FileChange' ? 'แก้ไฟล์' : `ใช้ ${item.tool}`;
        log('tool_call', { actor, tool: item.type, summary, tool_use_id: item.id, status: item.status, exit_code: item.exit_code ?? null });
        vis('AGENT_WORKING', { agent: actor, badge: summary, tool: item.type });
      }
    } else if (record.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p.type)) {
      if (!once(`call:${p.call_id || p.id || digest(JSON.stringify(p))}`)) return;
      ensure();
      log('tool_call', { actor, tool: p.name, summary: `ใช้ ${p.name}`, tool_use_id: p.call_id || p.id, input_sha256: digest(p.arguments || p.input || '') });
      vis('AGENT_WORKING', { agent: actor, badge: `ใช้ ${p.name}`, tool: p.name });
    }
  }
  poll() {
    try {
      for (const file of files(this.dir)) {
        let cursor = this.state.files[file];
        const first = firstLine(file);
        if (!first) continue;
        const metadata = first.type === 'session_meta' ? first.payload : null;
        const spawn = metadata?.source?.subagent?.thread_spawn;
        const child = metadata?.thread_source === 'subagent' && spawn?.parent_thread_id;
        // Only explicit thread_spawn workers are supported. Guardian/internal workers stay private.
        if (!metadata?.cwd || path.resolve(metadata.cwd) !== this.workspace ||
            (!child && ((metadata.thread_source && metadata.thread_source !== 'user') ||
            (metadata.source && typeof metadata.source !== 'string')))) {
          delete this.state.files[file]; continue;
        }
        const stat = statSync(file);
        const meta = metadata;
        const agentPath = meta.agent_path || spawn?.agent_path || '';
        const role = spawn?.agent_role || agentPath.split('/').pop();
        const cleanMeta = { id: meta.id || meta.session_id, cwd: meta.cwd,
          ...(child ? { parent_thread_id: spawn.parent_thread_id, root_id: meta.session_id || spawn.parent_thread_id,
            agent_path: agentPath, created_at: meta.timestamp,
            desk: ['pm', 'architect', 'backend', 'frontend', 'qa', 'debugger', 'reviewer'].includes(role) ? role : 'helper' } : {}) };
        if (!cursor) {
          if (!meta?.cwd || path.resolve(meta.cwd) !== this.workspace) continue;
          // Start from EOF: earlier conversations must not be imported or replayed.
          cursor = this.state.files[file] = { offset: this.initialized ? 0 : stat.size, meta: cleanMeta };
          if (!this.initialized) continue;
        }
        cursor.meta = cleanMeta; // Revalidate even cursors saved by older adapter versions.
        if (stat.size < cursor.offset) { cursor.offset = stat.size; continue; }
        const fd = openSync(file, 'r');
        try {
          const b = Buffer.alloc(Math.min(stat.size - cursor.offset, 4 * 1024 * 1024));
          const n = readSync(fd, b, 0, b.length, cursor.offset);
          const end = b.subarray(0, n).lastIndexOf(10);
          if (end < 0) continue; // leave partial JSON/UTF-8 untouched until the next poll
          for (const line of b.subarray(0, end).toString('utf8').split('\n')) {
            let r; try { r = JSON.parse(line); } catch { continue; }
            // Forks contain their parent's transcript. Never attribute inherited rows to a child.
            if (cursor.meta.created_at && Date.parse(r.timestamp) < Date.parse(cursor.meta.created_at)) continue;
            if (Date.parse(r.timestamp) >= this.startedAt || this.state.sessions[`codex-${cursor.meta.id}`]) this.handle(r, cursor.meta);
          }
          cursor.offset += end + 1;
        } finally { closeSync(fd); }
      }
      this.initialized = true; this.save(); this.status.files = Object.keys(this.state.files).length; this.status.activeChildren = Object.values(this.state.files).filter(c => c.meta.parent_thread_id && this.state.sessions[`codex-${c.meta.id}`]?.active).map(c => c.meta.id).filter((id, i, ids) => ids.indexOf(id) === i).length; this.status.error = null;
    } catch (e) { this.status.error = e.message; }
    return this.status;
  }
  start() { this.poll(); this.timer = setInterval(() => this.poll(), 1000); this.timer.unref(); return this; }
  stop() { clearInterval(this.timer); }
}
