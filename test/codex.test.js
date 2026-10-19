import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexBridge } from '../src/codex.js';
import { AuditLog, verify } from '../src/audit.js';

test('Codex tail: workspace isolation, partial UTF8, duplicate sidecar, restart, new sessions and completion', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-bridge-'));
  try {
    const sessions = path.join(dir, 'sessions'); mkdirSync(sessions);
    const audit = new AuditLog(path.join(dir, 'logs')); const events = [];
    const workspace = path.join(dir, 'project');
    const row = (type, payload) => JSON.stringify({ timestamp: new Date(Date.now() + 1000).toISOString(), type, payload }) + '\n';
    const meta = id => row('session_meta', { id, cwd: workspace });
    const file = path.join(sessions, 'main.jsonl'); writeFileSync(file, meta('one') + row('event_msg', { type:'user_message', message:'old' }));
    writeFileSync(path.join(sessions, 'guardian.jsonl'), row('session_meta', { id: 'guardian', cwd: workspace, thread_source: 'guardian_review', source: {subagent:{other:'guardian'}} }));
    const other = path.join(sessions, 'other.jsonl'); writeFileSync(other,row('session_meta',{id:'private',cwd:'/another-project'}));
    const opts = { dir: sessions, workspace, stateFile:path.join(dir,'cursor.json'), audit, emit:e=>events.push(e) };
    let bridge = new CodexBridge(opts); assert.equal(bridge.poll().error,null); assert.equal(audit.sessions().length,0);
    const prompt = row('event_msg', { type:'item_completed',turn_id:'t1',item:{type:'UserMessage',content:[{text:'ทักทาย'}]} });
    const bytes = Buffer.from(prompt); const cut=bytes.indexOf(Buffer.from('ทัก'))+1;
    appendFileSync(file,bytes.subarray(0,cut)); bridge.poll(); assert.equal(audit.sessions().length,0);
    appendFileSync(file,bytes.subarray(cut)); bridge.poll(); assert.equal(audit.read('codex-one').filter(e=>e.type==='user_prompt').length,1);
    appendFileSync(other,row('event_msg',{type:'user_message',message:'secret'}));
    appendFileSync(file,row('response_item',{type:'function_call',name:'exec_command',call_id:'call1',arguments:'{}'}));
    appendFileSync(file,row('event_msg',{type:'item_completed',item:{id:'cmd1',type:'CommandExecution',command:'node -v',status:'completed',exit_code:0}}));
    appendFileSync(file,row('event_msg',{type:'task_complete',turn_id:'t1',last_agent_message:'เสร็จ'}));
    appendFileSync(path.join(sessions,'guardian.jsonl'),row('event_msg',{type:'user_message',message:'internal approval'}));
    bridge.poll(); assert.equal(audit.sessions().length,1); assert.equal(verify(audit.read('codex-one')).ok,true);
    assert.ok(events.some(e=>e.type==='AGENT_WORKING'&&e.source==='codex'));
    assert.ok(events.some(e=>e.type==='TASK_COMPLETE'));
    const count=audit.read('codex-one').length;
    bridge=new CodexBridge(opts); bridge.poll(); assert.equal(audit.read('codex-one').length,count);
    const sidecar=path.join(sessions,'sidecar.jsonl'); writeFileSync(sidecar,meta('one')+prompt+row('event_msg',{type:'task_complete',turn_id:'t1',last_agent_message:'เสร็จ'}));
    bridge.poll(); assert.equal(audit.read('codex-one').length,count);
    writeFileSync(path.join(sessions,'new.jsonl'),meta('two')+row('event_msg',{type:'user_message',message:'new'}));
    bridge.poll(); assert.equal(audit.read('codex-two').find(e=>e.type==='user_prompt').prompt,'new');
    assert.equal(events.some(e=>e.type==='AGENT_ASSIGNED'),false,'never invent role delegation');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
