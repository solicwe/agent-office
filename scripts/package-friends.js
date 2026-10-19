// Build a portable ZIP from an explicit source allowlist, never from the whole checkout.
import { readdirSync, readFileSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const top = ['README.md', 'FRIENDS.md', 'TEAM_GUIDE.md', 'package.json', 'package-lock.json', 'server.js', 'start.command', 'start.sh', 'start.bat', '.gitignore', '.gitattributes', '.claude/settings.json'];
const dirs = ['src', 'public', 'scripts', 'docs', 'share', 'test', '.claude/agents'];
export function distributionFiles(base = root) {
  const out = [...top];
  const walk = rel => {
    for (const e of readdirSync(path.join(base, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const name = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(name);
      else if (e.isFile() && /\.(js|css|html|md|svg|png|jpg|webp|json)$/.test(name)) out.push(name);
    }
  };
  dirs.forEach(walk);
  return out.filter(n => lstatSync(path.join(base, n)).isFile()).sort();
}
// ZIP's uncompressed format is readable on macOS/Windows/Linux without extra dependencies.
function crc32(b) {
  let crc = 0xffffffff;
  for (const byte of b) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function buildPackage(base = root) {
  const chunks = [], central = []; let offset = 0;
  const entries = distributionFiles(base);
  for (const rel of entries) {
    const data = readFileSync(path.join(base, rel));
    const name = Buffer.from(`agent-office/${rel}`);
    const crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4); header.writeUInt16LE(0x800,6); header.writeUInt16LE(33,12); header.writeUInt32LE(crc,14); header.writeUInt32LE(data.length,18); header.writeUInt32LE(data.length,22); header.writeUInt16LE(name.length,26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(0x314,4); c.writeUInt16LE(20,6); c.writeUInt16LE(0x800,8); c.writeUInt16LE(33,14); c.writeUInt32LE(crc,16); c.writeUInt32LE(data.length,20); c.writeUInt32LE(data.length,24); c.writeUInt16LE(name.length,28); c.writeUInt32LE(((rel === 'start.command' || rel === 'start.sh' ? 0o100755 : 0o100644) * 65536) >>> 0,38); c.writeUInt32LE(offset,42);
    chunks.push(header,name,data); central.push(c,name); offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  const output = path.join(base,'dist','agent-office-for-friends.zip'); mkdirSync(path.dirname(output),{recursive:true});
  writeFileSync(output,Buffer.concat([...chunks,directory,end])); return { output, files: entries.length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(buildPackage());
