(function () {
  // ---- Views: main <-> settings ----
  const mainView = document.getElementById("view-main");
  const settingsView = document.getElementById("view-settings");
  document.getElementById("open-settings").addEventListener("click", () => {
    mainView.hidden = true;
    settingsView.hidden = false;
  });
  document.getElementById("back-to-main").addEventListener("click", () => {
    settingsView.hidden = true;
    mainView.hidden = false;
  });

  async function loadCacheSummary() {
    const all = await chrome.storage.local.get(null);
    const entries = Object.entries(all)
      .filter(([k]) => k.startsWith("aap.breakdown."))
      .map(([k, v]) => {
        // key is "aap.breakdown.<month>" or "aap.breakdown.<month>:<actorIds>"
        // when the view was scoped to the native Actor filter
        const [month, scope] = k.replace("aap.breakdown.", "").split(":");
        return { month, filtered: !!scope, ...v };
      })
      .sort((a, b) => b.month.localeCompare(a.month));

    const body = document.getElementById("cache-body");
    body.replaceChildren();
    if (!entries.length) {
      body.className = "muted";
      body.textContent = "No cached months yet — open the Insights page.";
      return;
    }
    body.className = "";
    for (const e of entries) {
      const row = document.createElement("div");
      row.className = "cache-row";
      const label = document.createElement("span");
      label.textContent = e.filtered ? `${e.month} (filtered)` : e.month;
      const meta = document.createElement("span");
      const actors = e.actorCount != null ? `${e.actorCount} actors` : "–";
      const when = e.updatedAt ? new Date(e.updatedAt).toLocaleTimeString() : "";
      meta.textContent = `${actors} · ${when}`;
      row.append(label, meta);
      body.appendChild(row);
    }
  }

  // Mirrors AAP_CACHE.PREFIXES in lib/cache.js (not loaded in the popup).
  const CACHE_PREFIXES = ["aap.breakdown.", "aap.metrics.", "aap.firstMonth."];
  document.getElementById("clear-cache").addEventListener("click", async () => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => CACHE_PREFIXES.some((p) => k.startsWith(p)));
    if (keys.length) await chrome.storage.local.remove(keys);
    loadCacheSummary();
  });

  // ---- Settings: highlights panel ----
  // Absent = on. The panel's own Hide button writes false; this is the way
  // back.
  const HIGHLIGHTS_KEY = "aap.highlightsOn";
  const highlightsBox = document.getElementById("highlights-on");
  chrome.storage.local.get(HIGHLIGHTS_KEY).then((r) => {
    highlightsBox.checked = r[HIGHLIGHTS_KEY] !== false;
  });
  highlightsBox.addEventListener("change", () => {
    if (highlightsBox.checked) chrome.storage.local.remove(HIGHLIGHTS_KEY);
    else chrome.storage.local.set({ [HIGHLIGHTS_KEY]: false });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[HIGHLIGHTS_KEY]) highlightsBox.checked = changes[HIGHLIGHTS_KEY].newValue !== false;
  });

  // ---- Settings: breakdown tooltip actor count ----
  // Kept opt-in — the content script falls back to this same default when
  // nothing is stored, so a user who never opens this panel sees no change.
  const TOOLTIP_ACTOR_COUNT_KEY = "aap.tooltipActorCount";
  const TOOLTIP_ACTOR_COUNT_DEFAULT = 10;

  const countInput = document.getElementById("tooltip-actor-count");
  document.getElementById("tooltip-actor-count-default").textContent = TOOLTIP_ACTOR_COUNT_DEFAULT;

  chrome.storage.local.get(TOOLTIP_ACTOR_COUNT_KEY).then((r) => {
    countInput.value = r[TOOLTIP_ACTOR_COUNT_KEY] > 0 ? r[TOOLTIP_ACTOR_COUNT_KEY] : TOOLTIP_ACTOR_COUNT_DEFAULT;
  });

  countInput.addEventListener("change", () => {
    const n = Math.round(Number(countInput.value));
    if (!(n > 0)) {
      countInput.value = TOOLTIP_ACTOR_COUNT_DEFAULT;
      chrome.storage.local.remove(TOOLTIP_ACTOR_COUNT_KEY);
      return;
    }
    countInput.value = n;
    chrome.storage.local.set({ [TOOLTIP_ACTOR_COUNT_KEY]: n });
  });

  document.getElementById("tooltip-actor-count-reset").addEventListener("click", () => {
    countInput.value = TOOLTIP_ACTOR_COUNT_DEFAULT;
    chrome.storage.local.remove(TOOLTIP_ACTOR_COUNT_KEY);
  });

  loadCacheSummary();
})();
