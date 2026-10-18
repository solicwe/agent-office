// Anchoring: after each round, the session's latest hash is committed to a separate
// branch (default "audit-log", file anchors.jsonl) and pushed to GitHub. GitHub's
// record of when that commit arrived shows the log existed in that form at that
// time, which a rebuilt chain could not fake afterwards.
// Uses git plumbing only, so the working tree, the index and the current branch are
// never touched while you work.
import { execFile } from "node:child_process";

function git(repo, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["-C", repo, ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error((stderr || err.message).trim()), { code: err.code }));
      else resolve(stdout.trim());
    });
    if (input != null) { child.stdin.end(input); }
  });
}
const tryGit = (repo, args) => git(repo, args).catch(() => null);

export class Anchor {
  constructor({ repo, branch = "audit-log", remote = "origin", push = true } = {}) {
    this.repo = repo;
    this.branch = branch;
    this.remote = remote;
    this.push = push;
    this.queue = Promise.resolve();
  }

  /** Commit {session_id, seq, hash} to the anchor branch; pushes when a remote exists. */
  anchor(record) {
    const run = async () => {
      const ref = `refs/heads/${this.branch}`;
      if (!(await tryGit(this.repo, ["rev-parse", "--git-dir"]))) return { ok: false, error: "ไม่ใช่ git repository" };
      const remoteUrl = this.push ? await tryGit(this.repo, ["remote", "get-url", this.remote]) : null;
      if (remoteUrl) await tryGit(this.repo, ["fetch", "-q", this.remote, `+${ref}:refs/remotes/${this.remote}/${this.branch}`]);
      const local = await tryGit(this.repo, ["rev-parse", "--verify", "-q", ref]);
      const remote = remoteUrl ? await tryGit(this.repo, ["rev-parse", "--verify", "-q", `refs/remotes/${this.remote}/${this.branch}`]) : null;
      // Build on whichever is newer, so two machines anchoring to one repo don't clash.
      let parent = local || remote;
      if (local && remote && local !== remote && (await tryGit(this.repo, ["merge-base", "--is-ancestor", local, remote])) !== null) parent = remote;
      const before = parent ? (await tryGit(this.repo, ["show", `${parent}:anchors.jsonl`])) || "" : "";
      const line = JSON.stringify({ ...record, anchored_at: new Date().toISOString() });
      const content = (before ? before + "\n" : "") + line + "\n";
      const blob = await git(this.repo, ["hash-object", "-w", "--stdin"], content);
      const tree = await git(this.repo, ["mktree"], `100644 blob ${blob}\tanchors.jsonl\n`);
      const commit = await git(this.repo, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `audit: ${record.session_id} #${record.seq}`]);
      await git(this.repo, ["update-ref", ref, commit, ...(local ? [local] : [])]);
      let pushed = false, pushError = null;
      if (remoteUrl) {
        try { await git(this.repo, ["push", "-q", this.remote, `${ref}:${ref}`]); pushed = true; } catch (err) { pushError = err.message.split("\n")[0]; }
      }
      return { ok: true, commit, branch: this.branch, pushed, push_error: pushError, remote: remoteUrl ? this.remote : null };
    };
    const p = this.queue.then(run, run).catch((err) => ({ ok: false, error: err.message }));
    this.queue = p;
    return p;
  }
}
