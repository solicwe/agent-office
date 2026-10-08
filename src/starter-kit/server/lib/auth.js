// Real accounts: scrypt password hashes, server-side sessions in an HttpOnly cookie.
"use strict";
const crypto = require("node:crypto");
const { collection } = require("./db");
const { HttpError } = require("./http");

const users = collection("users");
const sessions = collection("sessions");
const COOKIE = "sid";
const SESSION_DAYS = 7;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(password), salt, 64);
  const known = Buffer.from(hash, "hex");
  return known.length === test.length && crypto.timingSafeEqual(known, test);
}

/** User object safe to send to the browser (never the password hash). */
const publicUser = (u) => (u ? Object.fromEntries(Object.entries(u).filter(([k]) => k !== "passwordHash")) : null);

/** register({ email, password, name, role? }) -> user. Throws HttpError on bad input or taken email. */
function register({ email, password, name, role = "user", ...extra }) {
  email = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "อีเมลไม่ถูกต้อง");
  if (String(password || "").length < 8) throw new HttpError(400, "รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร");
  if (users.findOne((u) => u.email === email)) throw new HttpError(409, "อีเมลนี้ถูกใช้แล้ว");
  return publicUser(users.insert({ ...extra, email, name: String(name || "").trim() || email.split("@")[0], role, passwordHash: hashPassword(password) }));
}

/** login(res, email, password) -> user, and sets the session cookie. */
function login(res, email, password) {
  const u = users.findOne((x) => x.email === String(email || "").trim().toLowerCase());
  if (!u || !verifyPassword(password, u.passwordHash)) throw new HttpError(401, "อีเมลหรือรหัสผ่านไม่ถูกต้อง");
  const token = crypto.randomBytes(32).toString("hex");
  sessions.insert({ token, userId: u.id, expiresAt: Date.now() + SESSION_DAYS * 864e5 });
  res.setCookie(COOKIE, token, { maxAge: SESSION_DAYS * 86400 });
  return publicUser(u);
}

function logout(req, res) {
  const s = sessions.findOne((x) => x.token === req.cookies[COOKIE]);
  if (s) sessions.remove(s.id);
  res.clearCookie(COOKIE);
}

/** The logged-in user for this request, or null. */
function currentUser(req) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) return null;
  const s = sessions.findOne((x) => x.token === token);
  if (!s || s.expiresAt < Date.now()) return null;
  return publicUser(users.get(s.userId));
}

/** Use inside a handler: const user = requireUser(req) (401 if not logged in), requireUser(req, "admin") for a role. */
function requireUser(req, role) {
  const u = currentUser(req);
  if (!u) throw new HttpError(401, "กรุณาเข้าสู่ระบบ");
  if (role && u.role !== role) throw new HttpError(403, "ไม่มีสิทธิ์ใช้งานส่วนนี้");
  return u;
}

module.exports = { register, login, logout, currentUser, requireUser, hashPassword, verifyPassword, publicUser, users };
