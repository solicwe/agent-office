import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { configure } from '../scripts/setup.js';
import { readConfig } from '../src/config.js';
import { distributionFiles } from '../scripts/package-friends.js';

test('friend setup saves local Codex preferences, rejects invalid input, switches providers without credentials', () => {
 const dir=mkdtempSync(path.join(tmpdir(),'office-setup-'));
 try {
  const workspace=path.join(dir,'My project');mkdirSync(workspace);
  const result=configure({provider:'codex',workspace,destination:dir});
  assert.equal(result.config.workspace,workspace);
  assert.equal(readConfig(dir).auditAnchor,'off'); assert.equal(readConfig(dir).codexAnchor,'off');
  assert.equal(existsSync(path.join(workspace,'.claude')),false);
  assert.throws(()=>configure({provider:'unknown',workspace,destination:dir}));
  assert.throws(()=>configure({provider:'codex',workspace:path.join(dir,'missing'),destination:dir}));
  configure({provider:'chat',workspace,destination:dir});assert.equal(readConfig(dir).provider,'chat');
  writeFileSync(path.join(dir,'office.local.json'),'{bad');assert.throws(()=>readConfig(dir),/office.local.json/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('friend ZIP includes application, setup and roles but never machine/runtime folders', () => {
 const entries=distributionFiles();
 for(const required of ['server.js','FRIENDS.md','scripts/setup.js','src/codex.js','.claude/agents/frontend.md','start.command','start.bat']) assert.ok(entries.includes(required),required);
 assert.equal(entries.some(n=>/^(logs|node_modules|\.git|dist)\//.test(n)||['office.local.json','.env'].includes(n)),false);
});


test('Claude setup installs hooks in the friend project and keeps its existing role', () => {
 const dir=mkdtempSync(path.join(tmpdir(),'office-claude-'));
 try {
  const workspace=path.join(dir,'project');mkdirSync(path.join(workspace,'.claude','agents'),{recursive:true});
  const role=path.join(workspace,'.claude','agents','frontend.md');writeFileSync(role,'my existing role');
  configure({provider:'claude',workspace,destination:dir});
  assert.equal(readFileSync(role,'utf8'),'my existing role');
  const settings=JSON.parse(readFileSync(path.join(workspace,'.claude','settings.local.json'),'utf8'));
  assert.equal(settings.hooks.Stop[0].hooks[0].url,'http://127.0.0.1:3000/hooks');
  assert.equal(readConfig(dir).provider,'claude');
  assert.equal(readConfig(dir).auditAnchor,'off');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
