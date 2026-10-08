// JSON-file database (no npm packages). Each collection is data/<name>.json,
// written atomically so a crash never leaves a half-written file.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const cache = new Map();

function load(name) {
  if (!/^[a-z][a-z0-9_-]*$/i.test(name)) throw new Error("bad collection name");
  if (!cache.has(name)) {
    let rows = [];
    try { rows = JSON.parse(fs.readFileSync(path.join(DATA_DIR, name + ".json"), "utf8")); } catch { rows = []; }
    cache.set(name, Array.isArray(rows) ? rows : []);
  }
  return cache.get(name);
}

function save(name) {
  const file = path.join(DATA_DIR, name + ".json");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cache.get(name), null, 2));
  fs.renameSync(tmp, file);
}

const copy = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

/**
 * collection("users") -> { all(), find(fn), findOne(fn), get(id), insert(obj), update(id, patch), remove(id), count(fn) }
 * Every row gets a string id and createdAt/updatedAt (ISO). Returned rows are copies.
 */
function collection(name) {
  return {
    all: () => copy(load(name)),
    find: (fn) => copy(load(name).filter(fn)),
    findOne: (fn) => copy(load(name).find(fn) || null),
    get: (id) => copy(load(name).find((r) => r.id === String(id)) || null),
    count: (fn) => (fn ? load(name).filter(fn).length : load(name).length),
    insert(obj) {
      const now = new Date().toISOString();
      const row = { ...copy(obj), id: obj.id ? String(obj.id) : crypto.randomUUID(), createdAt: now, updatedAt: now };
      load(name).push(row);
      save(name);
      return copy(row);
    },
    update(id, patch) {
      const rows = load(name);
      const i = rows.findIndex((r) => r.id === String(id));
      if (i === -1) return null;
      rows[i] = { ...rows[i], ...copy(patch), id: rows[i].id, createdAt: rows[i].createdAt, updatedAt: new Date().toISOString() };
      save(name);
      return copy(rows[i]);
    },
    remove(id) {
      const rows = load(name);
      const i = rows.findIndex((r) => r.id === String(id));
      if (i === -1) return false;
      rows.splice(i, 1);
      save(name);
      return true;
    },
  };
}

module.exports = { collection, DATA_DIR };
