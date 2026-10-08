// Who is calling: the owner (browsing on this machine) or a friend with an
// invite link. Friends spend the owner's API tokens within a per-invite quota.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const DATA = path.resolve(process.env.DATA_DIR || "data");
const INVITES = path.join(DATA, "invites.json");
const KEYFILE = path.join(DATA, "server-key.json");
export const COOKIE = "ao_guest";

let invites = readJson(INVITES, []);

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

// ---------- API key the owner sets for friends (never sent to browsers) ----------
const saved = readJson(KEYFILE, null);
if (saved?.apiKey && !process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = saved.apiKey;

export function setServerKey(apiKey) {
  const k = String(apiKey || "").trim();
  if (k) process.env.ANTHROPIC_API_KEY = k;
  else delete process.env.ANTHROPIC_API_KEY;
  writeJson(KEYFILE, k ? { apiKey: k } : {});
}

// ---------- owner token ----------
// Apps built by the team run on this machine and could call localhost:3000, so
// "the request came from this computer" is not proof of the owner. The owner
// instead holds a secret cookie; the token lives in data/owner-token.txt, which
// the sandboxed apps cannot read.
export const OWNER_COOKIE = "ao_owner";
const OWNER_FILE = path.join(DATA, "owner-token.txt");
export const ownerToken = (() => {
  try {
    const t = readFileSync(OWNER_FILE, "utf8").trim();
    if (t.length >= 20) return t;
  } catch { /* create below */ }
  const t = randomBytes(24).toString("base64url");
  try {
    mkdirSync(DATA, { recursive: true });
    writeFileSync(OWNER_FILE, t + "\n");
  } catch {
    /* data/ not writable: the startup check reports it and stops the server */
  }
  return t;
})();

export function isOwnerToken(value) {
  const a = Buffer.from(String(value || ""));
  const b = Buffer.from(ownerToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- identity ----------
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export const isLoopback = (req) =>
  LOOPBACK.has(req.socket.remoteAddress) && !(req.headers["x-forwarded-for"] || req.headers["cf-connecting-ip"] || req.headers["forwarded"]);

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Owner = holds the owner cookie. Friends = hold a valid invite cookie. */
export function identify(req) {
  const jar = cookies(req);
  if (isOwnerToken(jar[OWNER_COOKIE])) return { role: "owner", id: "owner", name: "เจ้าของเครื่อง" };
  const code = jar[COOKIE];
  const inv = code && invites.find((x) => x.code === code && !x.revoked);
  if (inv) return { role: "guest", id: `guest:${inv.code}`, name: inv.name, invite: inv };
  return { role: "none" };
}

export const findInvite = (code) => invites.find((x) => x.code === code && !x.revoked) || null;

// ---------- invites ----------
export function listInvites() {
  return invites.filter((x) => !x.revoked).map((x) => ({ ...x, remaining: Math.max(0, x.limit - x.used) }));
}

export function createInvite({ name, limit }) {
  const inv = {
    code: randomBytes(9).toString("base64url"),
    name: String(name || "เพื่อน").slice(0, 40),
    limit: Math.max(1000, Math.round(Number(limit) || 200_000)),
    used: 0,
    createdAt: new Date().toISOString(),
    revoked: false,
  };
  invites.push(inv);
  writeJson(INVITES, invites);
  return inv;
}

/**
 * A friend inviting more friends: each new invite's quota is carved out of the
 * inviter's remaining quota, so friends can never spend more than they were given.
 */
export function createInviteFrom(inviter, { name, limit }) {
  if (inviter.role === "owner") return createInvite({ name, limit });
  const parent = invites.find((x) => x.code === inviter.invite?.code && !x.revoked);
  if (!parent) throw new Error("ลิงก์เชิญของคุณใช้ไม่ได้แล้ว");
  const want = Math.max(1000, Math.round(Number(limit) || 50_000));
  const give = Math.min(want, inviteRemaining(parent));
  if (give < 1000) throw new Error("โควตาโทเค็นของคุณเหลือไม่พอจะแบ่งให้เพื่อน");
  parent.limit -= give;
  const inv = createInvite({ name, limit: give });
  inv.invitedBy = parent.code;
  writeJson(INVITES, invites);
  return inv;
}

export const inviteByCode = (code) => invites.find((x) => x.code === code) || null;

export function revokeInvite(code) {
  const inv = invites.find((x) => x.code === code);
  if (inv) { inv.revoked = true; writeJson(INVITES, invites); }
}

export function chargeInvite(code, tokens) {
  const inv = invites.find((x) => x.code === code);
  if (!inv) return null;
  inv.used += Math.max(0, tokens);
  writeJson(INVITES, invites);
  return Math.max(0, inv.limit - inv.used);
}

export const inviteRemaining = (inv) => Math.max(0, inv.limit - inv.used);
