// Portable, machine-local preferences. Environment variables take precedence.
import { readFileSync } from 'node:fs';
import path from 'node:path';
export function readConfig(root) {
  try {
    const config = JSON.parse(readFileSync(path.join(root, 'office.local.json'), 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('expected an object');
    return config;
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`อ่าน office.local.json ไม่สำเร็จ: ${e.message}`);
  }
}
