// A link is only handed out once cloudflared has connected, so friends never get
// "site not found" from opening it too early.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.CLOUDFLARED_BIN = path.join(here, "fixtures", "fake-cloudflared.js");
process.env.TUNNEL_DNS_CHECK = "0";
process.env.FAKE_CF_CONNECT_MS = "1200";
const tunnel = await import("../src/tunnel.js");
after(() => tunnel.stopAllTunnels());

test("the link is held back until the tunnel is connected", async () => {
  const t0 = Date.now();
  const starting = tunnel.startTunnel("demo-app", 4999);
  await new Promise((r) => setTimeout(r, 600)); // the name is printed, not connected yet
  assert.equal(tunnel.tunnelStatus("demo-app").url, null, "not handed out before it works");
  const again = await tunnel.startTunnel("demo-app", 4999); // a second visitor waits for the same tunnel
  const first = await starting;
  assert.equal(first.url, "https://fake-4999.trycloudflare.com");
  assert.equal(again.url, first.url);
  assert.ok(Date.now() - t0 >= 1200, "waited for the connection");
});
