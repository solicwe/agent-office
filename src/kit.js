// The starter kit copied into every "app" project: a tiny web framework, a JSON
// database and real accounts, so the team builds features instead of plumbing.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "starter-kit");

function load() {
  const files = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else files[path.relative(ROOT, abs).split(path.sep).join("/")] = readFileSync(abs, "utf8");
    }
  };
  walk(ROOT);
  return files;
}

export const KIT_FILES = load();

/** Kit files the team must not rewrite (server.js and the sample test may be extended). */
export const isLockedKitFile = (p) => p.startsWith("server/lib/");
