// Stand-in for cloudflared in tests: prints a quick-tunnel URL like the real one, then waits.
const port = (process.argv.find((a) => a.startsWith("http://localhost:")) || "").split(":").pop();
setTimeout(() => {
  process.stderr.write("INF Requesting new quick Tunnel on trycloudflare.com...\n");
  process.stderr.write(`INF |  https://fake-${port}.trycloudflare.com  |\n`);
}, 150);
setInterval(() => {}, 1 << 30);
