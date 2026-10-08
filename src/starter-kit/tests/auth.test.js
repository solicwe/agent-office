// API tests run against the real server started by the QA lab (BASE_URL).
// Each call() keeps its own cookie jar, like one browser.
function client() {
  let cookie = "";
  return async function call(method, url, body) {
    const res = await fetch(BASE_URL + url, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  };
}

const email = `user${Date.now()}@example.com`;

test("สมัครสมาชิกแล้วเข้าสู่ระบบอัตโนมัติ", async () => {
  const call = client();
  const r = await call("POST", "/api/auth/register", { name: "Test", email, password: "secret123" });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.email, email);
  assert.equal(r.data.user.passwordHash, undefined, "never send the password hash");
  const me = await call("GET", "/api/auth/me");
  assert.equal(me.data.user.email, email);
});

test("login ด้วยรหัสผ่านผิดไม่ได้", async () => {
  const r = await client()("POST", "/api/auth/login", { email, password: "wrong-password" });
  assert.equal(r.status, 401);
});

test("login แล้ว logout แล้ว session หมด", async () => {
  const call = client();
  assert.equal((await call("POST", "/api/auth/login", { email, password: "secret123" })).status, 200);
  assert.equal((await call("POST", "/api/auth/logout")).status, 200);
  assert.equal((await call("GET", "/api/auth/me")).data.user, null);
});

test("สมัครด้วยอีเมลซ้ำไม่ได้", async () => {
  const r = await client()("POST", "/api/auth/register", { name: "X", email, password: "secret123" });
  assert.equal(r.status, 409);
});
