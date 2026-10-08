// App server. Start: node server.js  (PORT env var, default 3000)
"use strict";
const path = require("node:path");
const { createApp } = require("./server/lib/http");
const auth = require("./server/lib/auth");

const app = createApp({ publicDir: path.join(__dirname, "public") });

// ---- accounts (the first account becomes admin) ----
app.post("/api/auth/register", async (req, res) => {
  const body = await req.json();
  const role = auth.users.count() === 0 ? "admin" : "user";
  auth.register({ email: body.email, password: body.password, name: body.name, role });
  const user = auth.login(res, body.email, body.password);
  res.json({ user }, 201);
});

app.post("/api/auth/login", async (req, res) => {
  const body = await req.json();
  res.json({ user: auth.login(res, body.email, body.password) });
});

app.post("/api/auth/logout", (req, res) => {
  auth.logout(req, res);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => res.json({ user: auth.currentUser(req) }));

// ---- app routes ----
// Add routes here or in server/routes/*.js, e.g. require("./server/routes/products")(app);

app.listen(undefined, (port) => console.log(`App running on http://localhost:${port}`));
