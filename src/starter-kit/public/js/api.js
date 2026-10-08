// Browser helper for calling the app's API. Exposes window.api.
(function () {
  async function request(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error) || "เกิดข้อผิดพลาด (" + res.status + ")");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  window.api = {
    get: (url) => request("GET", url),
    post: (url, body) => request("POST", url, body || {}),
    put: (url, body) => request("PUT", url, body || {}),
    patch: (url, body) => request("PATCH", url, body || {}),
    del: (url) => request("DELETE", url),
    /** The logged-in user or null. */
    me: () => request("GET", "/api/auth/me").then((d) => d.user),
    login: (email, password) => request("POST", "/api/auth/login", { email, password }).then((d) => d.user),
    register: (name, email, password) => request("POST", "/api/auth/register", { name, email, password }).then((d) => d.user),
    logout: () => request("POST", "/api/auth/logout", {}),
    /** Send visitors who are not logged in to login.html, then back here afterwards. */
    requireLogin: async () => {
      const user = await window.api.me();
      if (!user) location.href = "/login.html?next=" + encodeURIComponent(location.pathname + location.search);
      return user;
    },
  };
})();
