// A friend's team: use the owner's tokens first, then the friend's own API key.
// When the owner's quota (or the friend's share of it) runs out mid-job, the same
// call is sent again with the friend's key and the job carries on. Once switched,
// the job stays on the friend's key so it does not bounce back and forth.

const QUOTA_RE = /quota|credit|insufficient|out of (tokens|credits)|usage limit|เครดิต|โควตา/i;

export class FallbackLLM {
  /**
   * @param {object} o
   * @param {object|null} o.primary   the owner's LLM (already wrapped to flag quota errors), or null
   * @param {object|null} o.fallback  the friend's own LLM, or null
   * @param {() => boolean} [o.primaryOut]  true when the friend's share of the owner's tokens is used up
   * @param {(why: string) => void} [o.onSwitch]
   * @param {(err: Error) => boolean} [o.isQuota]
   */
  constructor({ primary = null, fallback = null, primaryOut = () => false, onSwitch = () => {}, isQuota } = {}) {
    if (!primary && !fallback) throw new Error("no LLM");
    this.primary = primary;
    this.fallback = fallback;
    this.primaryOut = primaryOut;
    this.onSwitch = onSwitch;
    this.isQuota = isQuota || ((err) => Boolean(err?.quota) || err?.status === 402 || QUOTA_RE.test(String(err?.message || "")));
    this.switched = !primary;
  }

  get hasFallback() { return Boolean(this.fallback); }
  get onOwnKey() { return this.switched; }
  get current() { return this.switched ? this.fallback : this.primary; }
  get model() { return this.current.model; }
  get effort() { return this.current.effort; }

  switchToOwn(why) {
    if (this.switched || !this.fallback) return false;
    this.switched = true;
    this.onSwitch(why);
    return true;
  }

  async #run(method, opts) {
    if (!this.switched && this.primaryOut() && this.switchToOwn("share")) { /* switched before calling */ }
    if (!this.switched) {
      try {
        return await this.primary[method](opts);
      } catch (err) {
        if (opts?.signal?.aborted || !this.fallback || !this.isQuota(err)) throw err;
        this.switchToOwn("owner");
      }
    }
    try {
      const r = await this.fallback[method](opts);
      return { ...r, usage: { ...(r.usage || {}), own: true } };
    } catch (err) {
      // The friend's own key ran out: stop, but never mark the owner's counter as empty.
      if (this.isQuota(err)) Object.assign(err, { quota: true, ownKey: true, transient: false });
      throw err;
    }
  }

  call(opts) { return this.#run("call", opts); }
  json(opts) { return this.#run("json", opts); }
}
