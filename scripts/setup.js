// Configure this installation for its owner's AI; no credentials are requested.
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { attach } from './attach.js';
import { readConfig } from '../src/config.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function configure({ provider, workspace, destination = root }) {
  if (!['codex', 'claude', 'chat'].includes(provider)) throw new Error('เลือก codex, claude หรือ chat');
  workspace = path.resolve(workspace || destination);
  if (!statSync(workspace).isDirectory()) throw new Error('กรุณาเลือกโฟลเดอร์โปรเจกต์ที่มีอยู่จริง');
  const config = { ...readConfig(destination), provider, workspace, auditAnchor: 'off', codexAnchor: 'off' };
  // Claude requires real hooks in the selected project. Codex reads its own local sessions.
  let attached = null;
  if (provider === 'claude' && workspace !== root) attached = attach(workspace);
  mkdirSync(destination, { recursive: true });
  writeFileSync(path.join(destination, 'office.local.json'), JSON.stringify(config, null, 2) + '\n');
  return { config, attached };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    console.log('\nตั้งค่า Agent Office สำหรับ AI บนเครื่องของคุณ\n1. Codex (แสดงสด)\n2. Claude Code (แสดงสด + ติดตั้ง roles/hooks ให้โปรเจกต์ที่เลือก)\n3. ChatGPT / Gemini บนเว็บ (นำเข้า team-log ภายหลัง)\nไม่ต้องกรอกบัญชีหรือ API key ที่นี่\n');
    const choice = (await rl.question('เลือก 1 / 2 / 3 [1]: ')).trim() || '1';
    const provider = { 1: 'codex', 2: 'claude', 3: 'chat' }[choice];
    if (!provider) throw new Error('กรุณาเลือก 1, 2 หรือ 3');
    const answer = provider === 'chat' ? '' : (await rl.question(`โฟลเดอร์โปรเจกต์แบบเต็ม (Enter = ${root}): `)).trim();
    const workspace = answer.replace(/^['"]|['"]$/g, '');
    const result = configure({ provider, workspace: workspace || root });
    console.log(`\nบันทึกแล้ว: ${result.config.provider}\nโปรเจกต์: ${result.config.workspace}\nเก็บ log ในเครื่อง ไม่ push GitHub โดยค่าเริ่มต้น\n`);
    if (provider === 'chat') console.log('ใช้ share/TEAM_PROMPT.md แล้วนำเข้า team-log ในแท็บ Audit log');
    else console.log('เปิด AI ของคุณในโฟลเดอร์ข้างบน แล้วเริ่มคำสั่งรอบใหม่หลังเปิด Office');
    console.log('ต่อไป: npm start หรือดับเบิลคลิก start.command / start.bat\nเปลี่ยน AI หรือโปรเจกต์: npm run setup\n');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
  finally { rl.close(); }
}
