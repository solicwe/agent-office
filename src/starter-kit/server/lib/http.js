// Tiny web framework (no npm packages): routes, JSON bodies, cookies, static files.
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function compile(pattern) {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/\/:([A-Za-z_]\w*)/g, (_, k) => { keys.push(k); return "/([^/]+)"; }) + "/?$");
  return { re, keys };
}

/**
 * createApp({ publicDir }) -> app with app.get/post/put/patch/delete(path, handler)
 * handler(req, res) may be async. Available helpers:
 *   req.params, req.query, req.cookies, await req.json()
 *   res.json(data, status), res.status(code), res.setCookie(name, value, opts), res.clearCookie(name), res.redirect(url)
 * throw new HttpError(400, "message") to answer { error: message } with that status.
 */
function createApp({ publicDir } = {}) {
  const routes = [];
  const app = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) {
    app[m] = (pattern, handler) => { routes.push({ method: m.toUpperCase(), ...compile(pattern), handler }); return app; };
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    req.query = Object.fromEntries(url.searchParams);
    req.cookies = parseCookies(req.headers.cookie);
    let bodyCache;
    req.json = async () => {
      if (bodyCache !== undefined) return bodyCache;
      let raw = "";
      for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) throw new HttpError(413, "ข้อมูลใหญ่เกินไป"); }
      try { bodyCache = raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, "รูปแบบ JSON ไม่ถูกต้อง"); }
      return bodyCache;
    };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (data, status) => {
      if (status) res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(data));
    };
    const cookies = [];
    res.setCookie = (name, value, opts = {}) => {
      const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
      if (opts.maxAge != null) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
      cookies.push(parts.join("; "));
      res.setHeader("Set-Cookie", cookies);
    };
    res.clearCookie = (name) => res.setCookie(name, "", { maxAge: 0 });
    res.redirect = (to) => { res.statusCode = 302; res.setHeader("Location", to); res.end(); };

    const method = req.method === "HEAD" ? "GET" : req.method;
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      req.params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      await r.handler(req, res);
      if (!res.writableEnded) res.end();
      return;
    }
    if (url.pathname.startsWith("/api/")) return res.json({ error: "ไม่พบ API นี้" }, 404);
    if (publicDir && (method === "GET")) return serveStatic(publicDir, url.pathname, res);
    res.json({ error: "Not found" }, 404);
  }

  app.listen = (port = Number(process.env.PORT) || 3000, cb) => {
    const server = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        const status = err.status || 500;
        if (status >= 500) console.error(err);
        if (!res.headersSent) res.json({ error: status >= 500 ? "เกิดข้อผิดพลาดในเซิร์ฟเวอร์" : err.message }, status);
        else res.end();
      });
    });
    return server.listen(port, () => cb && cb(server.address().port));
  };
  return app;
}

function serveStatic(root, pathname, res) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = "/"; }
  let file = path.normalize(path.join(root, rel));
  if (!file.startsWith(path.normalize(root))) { res.statusCode = 403; return res.end("Forbidden"); }
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  } catch { /* checked below */ }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end("<!doctype html><meta charset=utf-8><title>404</title><p>ไม่พบหน้านี้ <a href=\"/\">กลับหน้าแรก</a></p>");
    }
    res.setHeader("Content-Type", TYPES[path.extname(file).toLowerCase()] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.end(data);
  });
}

module.exports = { createApp, HttpError, parseCookies };
