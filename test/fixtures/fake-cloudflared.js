// Stand-in for cloudflared in tests: prints a quick-tunnel URL like the real one,
// connects a moment later (FAKE_CF_CONNECT_MS), then waits until it is stopped.
const port = (process.argv.find((a) => a.startsWith("http://localhost:")) || "").split(":").pop();
const connectAfter = Number(process.env.FAKE_CF_CONNECT_MS || 100);
setTimeout(() => {
  process.stderr.write("INF Requesting new quick Tunnel on trycloudflare.com...\n");
  process.stderr.write(`INF |  https://fake-${port}.trycloudflare.com  |\n`);
  setTimeout(() => process.stderr.write("INF Registered tunnel connection connIndex=0 location=test protocol=quic\n"), connectAfter);
}, 100);
setInterval(() => {}, 1 << 30);
