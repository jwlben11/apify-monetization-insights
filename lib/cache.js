/*
 * chrome.storage.local cache. Three record kinds, all keyed per month (the
 * console-backend API is month-scoped, so every range view is a union of
 * month loads):
 *
 *   aap.metrics.<month>[:scope]    account-wide day totals (2 requests/month)
 *   aap.breakdown.<month>[:scope]  per-day-per-Actor index (1 + 2/paid Actor)
 *   aap.firstMonth.<org>           earliest month with any activity ("All time")
 *
 * TTLs follow how final the data is. The current month keeps moving, so it's
 * short. The previous month still settles until Apify's payout invoice
 * (around the middle of the following month). Anything older is final and
 * is kept for 30 days — this is the main lever keeping range views (and
 * especially "All time") from re-hammering console-backend: after one cold
 * load, a past month costs zero requests for a month.
 */
(function () {
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const TTL = {
    metrics: { current: MIN, settling: 6 * HOUR, final: 30 * DAY },
    breakdown: { current: 15 * MIN, settling: DAY, final: 30 * DAY },
  };
  const SETTLING_DAYS = 14; // days into a month during which the previous month may still change

  function ttlFor(month, kind) {
    const ym = String(month).slice(0, 7);
    const now = new Date();
    const cur = now.toISOString().slice(0, 7);
    const t = TTL[kind];
    if (ym === cur) return t.current;
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    if (ym === prev && now.getUTCDate() <= SETTLING_DAYS) return t.settling;
    return t.final;
  }

  const PREFIXES = ["aap.breakdown.", "aap.metrics.", "aap.firstMonth."];
  const VERSION_KEY = "aap.cacheVersion";

  // False once the extension has been reloaded/updated under this page: the
  // old content script keeps running but every chrome.* API is gone
  // ("Extension context invalidated"). Reads then return null and writes
  // no-op instead of throwing out of some in-flight promise.
  function alive() {
    try {
      return !!chrome.runtime?.id && !!chrome.storage?.local;
    } catch {
      return false;
    }
  }

  // Wipe every cached record the first time a new extension version runs.
  // A version bump can change what a record means or fix a bug that cached
  // wrong data (e.g. the actorIds[] 400s silently caching an empty breakdown,
  // which then kept the chart flat until the TTL expired or the user found
  // the manual Clear-cache button). get/set await this gate so a page that's
  // already loading can't read or write around the wipe.
  const versionReady = (async () => {
    const version = chrome.runtime.getManifest().version;
    const stored = (await chrome.storage.local.get(VERSION_KEY))[VERSION_KEY];
    if (stored !== version) {
      await clearAll();
      await chrome.storage.local.set({ [VERSION_KEY]: version });
    }
  })().catch(() => {});

  // scope is the org (if any) + the native Actor filter as a sorted
  // comma-joined id list; "" (personal account, all Actors) keeps the
  // historical un-suffixed key.
  function key(prefix, month, scope) {
    return `${prefix}${String(month).slice(0, 7)}-01${scope ? ":" + scope : ""}`;
  }

  async function read(prefix, kind, month, scope) {
    await versionReady;
    if (!alive()) return null;
    const k = key(prefix, month, scope);
    let rec;
    try {
      rec = (await chrome.storage.local.get(k))[k];
    } catch {
      return null;
    }
    if (!rec) return null;
    return { ...rec, stale: Date.now() - rec.updatedAt > ttlFor(month, kind) };
  }

  async function write(prefix, month, scope, data) {
    await versionReady;
    const rec = { ...data, updatedAt: Date.now() };
    if (!alive()) return rec;
    try {
      await chrome.storage.local.set({ [key(prefix, month, scope)]: rec });
    } catch {
      /* orphaned script: nothing to persist to */
    }
    return rec;
  }

  // ---- per-day-per-Actor breakdown ({ daily, actorCount, dayMetrics, breakdown })
  const get = (month, scope) => read("aap.breakdown.", "breakdown", month, scope);
  const set = (month, scope, data) => write("aap.breakdown.", month, scope, data);

  // ---- account-wide day totals ({ dayMetrics })
  const getMetrics = (month, scope) => read("aap.metrics.", "metrics", month, scope);
  const setMetrics = (month, scope, dayMetrics) => write("aap.metrics.", month, scope, { dayMetrics });

  // ---- earliest month with activity, per account. Never expires: activity
  // can't appear before the first month already found. Clear cache resets it.
  async function getFirstMonth(org) {
    await versionReady;
    if (!alive()) return null;
    const k = `aap.firstMonth.${org || "personal"}`;
    try {
      return (await chrome.storage.local.get(k))[k]?.month || null;
    } catch {
      return null;
    }
  }
  async function setFirstMonth(org, month) {
    await versionReady;
    if (!alive()) return;
    const k = `aap.firstMonth.${org || "personal"}`;
    try {
      await chrome.storage.local.set({ [k]: { month, updatedAt: Date.now() } });
    } catch {
      /* orphaned script */
    }
  }

  async function clearAll() {
    if (!alive()) return 0;
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => PREFIXES.some((p) => k.startsWith(p)));
    if (keys.length) await chrome.storage.local.remove(keys);
    return keys.length;
  }

  self.AAP_CACHE = { get, set, getMetrics, setMetrics, getFirstMonth, setFirstMonth, clearAll, PREFIXES };
})();
