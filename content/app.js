/*
 * Overlays the native Monetization chart on
 * https://console.apify.com/actors/insights/monetization with our own
 * canvas, plus a small toolbar inserted just above it: independent
 * Revenue / Runs / Results checkboxes (Revenue draws bars against the left
 * axis; Runs/Results draw line series against a secondary right axis) and a
 * "Breakdown by actor" checkbox that stacks the Revenue bars by Actor.
 * Hovering any day shows a tooltip with that day's full stats plus the top
 * Actors (10 by default, configurable from the toolbar popup) by whichever
 * metric is active. We draw our own chart (rather
 * than reaching into Apify's) because it's a black-box Chart.js canvas with
 * no exposed instance to restyle or hook into.
 *
 * The Insights page is a client-routed SPA and never changes the URL when
 * you flip months, so we can't read "which month is shown" from
 * location.href. Instead token-sniffer.js (MAIN world) watches the page's
 * own XHR/fetch calls and tells us the `month` query param of each one.
 *
 * The account-wide Revenue/Costs/Runs/Results headline numbers were only
 * ever fetched once per month load, so they'd drift from Apify's own chart
 * (which keeps recomputing) the longer a tab stayed open on a still-settling
 * day. We now re-poll those same two endpoints on a timer (see
 * DAY_METRICS_REFRESH_MS) so they stay live. A "Show original Apify chart"
 * toolbar toggle un-hides the native canvas for a direct side-by-side check
 * against our numbers.
 */
(function () {
  // Personal accounts see /actors/insights/monetization; organization
  // accounts get an /organization/<orgId> path prefix for the same page.
  // Match both — the org's analytics requests carry the org context in the
  // token the sniffer picks up, so nothing else needs to change.
  const ROUTE_RE = /^(?:\/organization\/[^/]+)?\/actors\/insights\/monetization\/?$/;
  const onInsightsRoute = () => ROUTE_RE.test(location.pathname);
  const OVERLAY_CLASS = "aap-overlay";
  const TOOLBAR_CLASS = "aap-toolbar";
  const PALETTE = ["#2dd4bf", "#60a5fa", "#f472b6", "#facc15", "#a78bfa", "#fb923c", "#34d399", "#f87171"];
  const OTHER_COLOR = "#6b7280";
  const RUN_STATUS_COLORS = {
    succeeded: "#65a30d",
    failed: "#e5484d",
    aborted: "#eab308",
    timedOut: "#14b8a6",
  };
  const TOP_N = PALETTE.length;
  // How many Actors the click-to-pin tooltip table lists, ranked by the
  // active headline metric. Configurable from the extension's toolbar popup
  // (Settings section) — this is just the fallback until that pref loads.
  const DEFAULT_TOOLTIP_ACTOR_COUNT = 10;
  const METRICS = [
    { key: "revenue", label: "Revenue", color: "#12966f", kind: "bar", axis: "left" }, // matches Apify's own chart bar color
    { key: "runs", label: "Runs", color: "#22d3ee", kind: "line", axis: "right" },
    { key: "results", label: "Results", color: "#fb7185", kind: "line", axis: "right" },
  ];
  const AXIS_LABEL_COLOR = "#666666"; // matches Apify's own chart axis labels

  // The Console's Costs / Revenue / Profit / Margin KPI tabs above the chart
  // pick what its own chart plots. We follow them: Costs, Revenue and Profit
  // become our bar metric (with the per-Actor breakdown), while Margin is a
  // ratio that can't be stacked by Actor, so it hands the chart back to
  // Apify's own line. Detected from the tab nav's `_active` class on every
  // poll tick — the tabs are React links that don't change the URL.
  const BAR_METRICS = {
    revenue: { label: "Revenue", color: "#12966f" },
    cost: { label: "Costs", color: "#e5484d" },
    profit: { label: "Profit", color: "#6b9fff" },
  };
  let headline = "revenue"; // "revenue" | "cost" | "profit" | "margin"

  function nativeHeadline() {
    const active = document.querySelector('[class*="StyledLargeTabNav"] a[role="tab"]._active');
    const txt = (active?.textContent || "").trim().toLowerCase();
    if (txt.startsWith("cost")) return "cost";
    if (txt.startsWith("profit")) return "profit";
    if (txt.startsWith("margin")) return "margin";
    return "revenue";
  }

  // The bar metric currently plotted on the left axis (never "margin" — in
  // Margin mode the native chart shows instead and this is unused).
  function barMetric() {
    const key = headline === "margin" ? "revenue" : headline;
    return { key, kind: "bar", axis: "left", ...BAR_METRICS[key] };
  }

  // Metric definition by key, covering the dynamic bar metric as well as the
  // fixed line metrics in METRICS.
  function metricDef(key) {
    if (BAR_METRICS[key]) return { key, kind: "bar", axis: "left", ...BAR_METRICS[key] };
    return METRICS.find((m) => m.key === key);
  }

  // While Margin is selected the native chart is the one on screen, whatever
  // the user's own "Show original Apify chart" preference says.
  function nativeChartWanted() {
    return showNativeOn || headline === "margin";
  }

  const PREF_KEYS = {
    composition: "aap.compositionOn",
    metricsOn: "aap.metricsOn",
    showNative: "aap.showNativeOn",
    tooltipActorCount: "aap.tooltipActorCount",
    rangeMode: "aap.rangeMode",
    customRange: "aap.customRange",
    highlights: "aap.highlightsOn", // false hides the highlights panel; absent = shown
  };

  // How often to re-fetch the cheap account-wide day totals while a month
  // stays loaded, so a long-open tab doesn't show numbers from whenever it
  // was first opened (recent days keep settling on Apify's side too).
  const DAY_METRICS_REFRESH_MS = 60_000;

  // How often a still-open tab re-runs the full per-Actor index. Without
  // this, the breakdown was indexed exactly once per page load, so a tab
  // opened before today's first run showed no per-Actor activity for today
  // forever (while the account-wide totals, refreshed every minute, plainly
  // showed runs or revenue). Matches the cache TTL — re-running
  // sooner would just be served the same fresh cache and no-op.
  const BREAKDOWN_REFRESH_MS = 15 * 60 * 1000;
  // After a failed index (network blip, token not ready yet) retry much
  // sooner than the regular 15-minute cadence.
  const ERROR_RETRY_MS = 30_000;

  // Only the current month keeps moving on Apify's side (today's runs, and
  // refunds/unpaid invoices until the payout). Past months are final, so
  // they're fetched once per (long) cache TTL and never refreshed while the
  // tab sits open. month is "YYYY-MM-01" (the page's param) or "YYYY-MM".
  function isCurrentMonth(month) {
    return !!month && String(month).slice(0, 7) === new Date().toISOString().slice(0, 7);
  }

  // ---- date range ------------------------------------------------------------
  // Apify's day buckets are UTC dates ("2026-09-19"), so every range here is
  // computed in UTC too — "today" is the UTC day, matching isCurrentMonth.
  const todayUtc = () => new Date().toISOString().slice(0, 10);
  const monthOf = (day) => String(day).slice(0, 7) + "-01";
  function addDays(day, n) {
    const d = new Date(day + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function addMonths(month, n) {
    const d = new Date(monthOf(month) + "T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + n);
    return d.toISOString().slice(0, 10);
  }
  const monthEnd = (month) => addDays(addMonths(month, 1), -1);
  // Every "YYYY-MM-01" touched by [from, to], newest first — the order the
  // loader works in, so the most recent (most interesting) days fill first.
  function monthsBetween(from, to) {
    const out = [];
    for (let m = monthOf(to); m >= monthOf(from); m = addMonths(m, -1)) out.push(m);
    return out;
  }

  // The range presets on the toolbar. "native" follows the Console's own
  // month picker (the historical behaviour, and the default); the rest are
  // computed from today. "all" starts at the account's first month with
  // activity, found once by resolveFirstMonth and cached.
  const RANGE_MODES = ["native", "thisMonth", "last30", "last90", "all", "custom"];
  const RANGE_LABELS = {
    thisMonth: "This month",
    last30: "Last 30 days",
    last90: "Last 90 days",
    all: "All time",
    custom: "Custom range",
  };
  const EARLIEST_CUSTOM = "2020-01-01";
  // "All time" discovery: walk back from the current month until this many
  // consecutive months show no activity at all (a long quiet gap is still
  // bridged), or this many months total. Probed months are cached for 30
  // days and the result itself forever, so this costs requests once.
  const ALL_TIME_EMPTY_STREAK = 6;
  const ALL_TIME_MAX_MONTHS = 72;
  const ALL_TIME_PROBE_BATCH = 6;
  // How many not-yet-cached months a single range load will index the
  // per-Actor breakdown for on its own (one list request, then one run call
  // per active Actor plus a margin call for earning Actors). Beyond that the
  // status offers a button to index the rest — so "All time" on an account
  // with years of history can't fire hundreds of requests unasked.
  const AUTO_INDEX_MONTHS = 6;

  const state = {
    month: null, // "2026-07-01", from the page's own requests
    actorIds: [], // native "Actor" filter, sniffed from those same requests ([] = all)
    rangeMode: "native",
    customRange: null, // { from: "YYYY-MM-DD", to: "YYYY-MM-DD" }
    firstMonth: {}, // { [org]: "YYYY-MM-01" } resolved for "All time"
  };

  // Which organization's console we're looking at ("" = personal account).
  // Part of every scope/cache key so switching personal <-> org in the same
  // tab can't serve one account's cached breakdown to the other.
  function currentOrg() {
    return (location.pathname.match(/^\/organization\/([^/]+)/) || [])[1] || "";
  }

  // The [from, to] day range the chart should show, or null when it can't be
  // known yet (native mode before the page's first request has been sniffed).
  // "All time" has from === null until resolveFirstMonth has run; the loader
  // fills it in.
  function currentRange() {
    const today = todayUtc();
    switch (state.rangeMode) {
      case "native":
        return state.month ? { from: monthOf(state.month), to: monthEnd(state.month) } : null;
      case "thisMonth":
        return { from: monthOf(today), to: today };
      case "last30":
        return { from: addDays(today, -29), to: today };
      case "last90":
        return { from: addDays(today, -89), to: today };
      case "all":
        return { from: state.firstMonth[currentOrg()] || null, to: today };
      case "custom": {
        const c = state.customRange;
        if (!c) return null;
        return { from: c.from, to: c.to < today ? c.to : today };
      }
      default:
        return null;
    }
  }

  // Does the range reach into the current month? Only then do numbers still
  // move, and only then does the poll run its periodic refreshes.
  function rangeIsLive(range) {
    return !!range && monthOf(range.to) === monthOf(todayUtc());
  }

  // One string identifying what should currently be rendered: mode + range +
  // account + filter. Everything that loads or lands async compares against
  // this, so a month switch, a preset switch, an account switch and a filter
  // switch are all handled identically. "All time" deliberately leaves its
  // (async-resolved) start out so discovering it doesn't look like a switch.
  function scopeKey() {
    const r = currentRange();
    if (!r) return null;
    const from = state.rangeMode === "all" ? "" : r.from;
    return `${state.rangeMode}|${from}|${r.to}|${currentOrg()}|${state.actorIds.join(",")}`;
  }

  // Cache scope for the per-month records: org + native Actor filter. "" for
  // the personal account with no filter keeps the historical un-suffixed key.
  function cacheScope(actorIds) {
    return (currentOrg() ? currentOrg() + "|" : "") + actorIds.join(",");
  }

  function setRangeMode(mode) {
    if (!RANGE_MODES.includes(mode)) return;
    state.rangeMode = mode;
    savePref({ [PREF_KEYS.rangeMode]: mode });
    hideTooltip();
    syncToolbar();
    // The poll would pick the new key up within 400 ms; kick it now so the
    // switch feels instant.
    maybeLoad();
  }

  chrome.storage.local.get(Object.values(PREF_KEYS)).then((r) => {
    compositionOn = !!r[PREF_KEYS.composition];
    if (r[PREF_KEYS.metricsOn]) metricsOn = { ...metricsOn, ...r[PREF_KEYS.metricsOn] };
    showNativeOn = !!r[PREF_KEYS.showNative];
    if (r[PREF_KEYS.tooltipActorCount] > 0) tooltipActorCount = r[PREF_KEYS.tooltipActorCount];
    const c = r[PREF_KEYS.customRange];
    if (c && /^\d{4}-\d{2}-\d{2}$/.test(c.from) && /^\d{4}-\d{2}-\d{2}$/.test(c.to) && c.from <= c.to) {
      state.customRange = { from: c.from, to: c.to };
    }
    const mode = r[PREF_KEYS.rangeMode];
    if (RANGE_MODES.includes(mode) && (mode !== "custom" || state.customRange)) state.rangeMode = mode;
    highlightsOn = r[PREF_KEYS.highlights] !== false;
    prefsLoaded = true;
    syncToolbar();
    drawChart();
  }).catch(() => {});

  // The tooltip actor count is set from the toolbar popup (a separate
  // context from this content script), not from anything in this page, so
  // pick up a change made there live rather than requiring a reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[PREF_KEYS.tooltipActorCount]) {
      const next = changes[PREF_KEYS.tooltipActorCount].newValue;
      tooltipActorCount = next > 0 ? next : DEFAULT_TOOLTIP_ACTOR_COUNT;
      renderTooltip();
    }
    // The highlights toggle lives in the popup's settings too (the only way
    // back once the panel's own Hide button was used).
    if (changes[PREF_KEYS.highlights]) {
      highlightsOn = changes[PREF_KEYS.highlights].newValue !== false;
      ensureHighlights();
    }
  });

  // ---- token bridge -------------------------------------------------------
  window.addEventListener("aap-token", (e) => AAP_API.setToken(e.detail));
  window.dispatchEvent(new Event("aap-request-token")); // in case we loaded late

  // This only ever records *which month the page is currently showing* — it
  // does NOT trigger loading. The very first request of a page load reliably
  // fires before the chart (our DOM anchor) exists, so a "load on event"
  // design would permanently mark that month as handled and never retry once
  // the anchor shows up. The poll below is the single place that decides
  // whether to (re)load, once it can confirm there's somewhere to render.
  window.addEventListener("aap-request-seen", (e) => {
    const { month, actorIds } = e.detail;
    if (!month) return;
    // The user flipped the Console's own month picker while a preset range
    // was showing: that's an explicit ask to see that month, so follow it.
    // (The very first request of a page load only *sets* the month; it
    // never overrides a persisted preset.)
    const pickerMoved = state.month && month !== state.month && state.rangeMode !== "native";
    state.month = month;
    // Sorted so the same filter always yields the same scopeKey/cache key
    // regardless of the order the page put the ids in the query string.
    state.actorIds = [...(actorIds || [])].sort();
    if (pickerMoved) setRangeMode("native");
  });

  // Reloading the extension (chrome://extensions → Reload, or an update)
  // while this tab is open leaves this script running as an orphan: its
  // timers keep firing but every chrome.* API is gone ("extension context
  // invalidated"), so the next toolbar rebuild would throw on
  // chrome.storage. The reloaded extension injects a fresh copy on the next
  // page load; the orphan just has to get out of the way.
  let retired = false;
  function contextAlive() {
    if (retired) return false;
    try {
      return !!chrome.runtime?.id && !!chrome.storage;
    } catch {
      return false;
    }
  }
  function isInvalidated(err) {
    return /Extension context invalidated|Cannot read properties of undefined \(reading '(local|onChanged|storage|runtime)'\)/.test(String(err && err.message ? err.message : err));
  }
  function retireOrphan() {
    if (retired) return;
    retired = true;
    clearInterval(poll);
    clearInterval(routeWatch);
    try {
      unmountOverlay();
    } catch {
      /* best effort */
    }
  }
  // Fire-and-forget preference write. Swallows the rejection an orphaned
  // script gets (and retires it) so a pref click never logs an uncaught error.
  function savePref(obj) {
    if (!contextAlive()) return;
    try {
      chrome.storage.local.set(obj).catch((err) => {
        if (isInvalidated(err)) retireOrphan();
      });
    } catch (err) {
      if (isInvalidated(err)) retireOrphan();
    }
  }

  // ---- SPA route watcher ---------------------------------------------------
  let lastPath = null;
  const routeWatch = setInterval(() => {
    if (!contextAlive()) return retireOrphan();
    const path = location.pathname;
    if (path === lastPath) return;
    lastPath = path;
    if (!onInsightsRoute()) unmountOverlay();
  }, 500);

  // ---- DOM anchoring --------------------------------------------------------
  // The wrapper Apify renders its Chart.js canvas into — a plain, statically
  // positioned <div> with exactly one <canvas> child.
  function findChartWrapper() {
    return document.querySelector('[class*="PaidActorProfitMarginChart"]');
  }

  // Dismiss Apify's own chart tooltip by telling Chart.js/React the pointer
  // left the native canvas. Both events bubble so React's root listener sees
  // them; pointerout covers a Chart.js build listening to pointer events.
  function dismissNativeTooltip(nativeCanvas) {
    const init = { bubbles: true, cancelable: true, relatedTarget: document.body };
    try {
      nativeCanvas.dispatchEvent(new PointerEvent("pointerout", init));
      nativeCanvas.dispatchEvent(new MouseEvent("mouseout", init));
    } catch {
      /* never let cleanup break the overlay */
    }
  }

  // Ensures: the native canvas is hidden, our toolbar sits just above the
  // chart wrapper (in normal document flow, not overlapping it), and our own
  // chart canvas + tooltip exist inside the wrapper. Safe to call repeatedly
  // — it's the single place that (re)creates anything that went missing,
  // whether that's on first paint or after Apify's own React tree re-renders
  // the wrapper and wipes out nodes it doesn't recognize.
  function ensureOverlay() {
    if (!contextAlive()) return null;
    const wrapper = findChartWrapper();
    if (!wrapper) return null;

    // visibility:hidden, not display:none — the wrapper has no height of its
    // own, it's sized by the canvas; hiding via display would collapse it to
    // 0px and our absolutely-positioned overlay would have nothing to fill.
    // When "Show original Apify chart" is on, we flip this the other way:
    // the native canvas is shown and our own overlay is display:none'd.
    const nativeCanvas = wrapper.querySelector("canvas:not(.aap-chart)");
    if (nativeCanvas) {
      const vis = nativeChartWanted() ? "" : "hidden";
      if (nativeCanvas.style.visibility !== vis) {
        nativeCanvas.style.visibility = vis;
        // If the pointer was over the native chart before we hid it (easy to
        // do while the page is still loading), Apify's tooltip — an HTML
        // `div.custom-tooltip` rendered by React from Chart.js's external
        // tooltip hook, not a canvas paint — stays on screen: a hidden
        // canvas never receives the mouseout that would dismiss it. Fake
        // that mouseout. It MUST bubble with a relatedTarget outside the
        // canvas: React listens at the document root and derives its
        // leave/out logic from the bubbled event, so a non-bubbling
        // MouseEvent (the previous fix) never reached it (verified on the
        // live page, Sep 2026).
        if (vis === "hidden") dismissNativeTooltip(nativeCanvas);
      }
    }
    if (getComputedStyle(wrapper).position === "static") wrapper.style.position = "relative";

    ensureToolbar(wrapper);

    let overlay = wrapper.querySelector(`.${OVERLAY_CLASS}`);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = OVERLAY_CLASS;

      const canvas = document.createElement("canvas");
      canvas.className = "aap-chart";
      overlay.appendChild(canvas);

      let tooltip = document.querySelector(".aap-tooltip");
      if (!tooltip) {
        tooltip = document.createElement("div");
        tooltip.className = "aap-tooltip";
        tooltip.style.display = "none";
        tooltip.addEventListener("click", onTooltipClick);
        document.body.appendChild(tooltip); // fixed-position, outside clipped ancestors
      }

      // Hover shows a live preview that follows the cursor (as before) and
      // is not interactive — pointer-events is off by default. Clicking a
      // day's bar "pins" the tooltip: it stops following the mouse and
      // becomes clickable (see PIN below) so the sort headers actually work.
      canvas.addEventListener("mousemove", onHover);
      canvas.addEventListener("mouseleave", () => {
        if (pinnedDay == null) hideTooltip();
      });
      canvas.addEventListener("click", onChartClick);

      wrapper.appendChild(overlay);
    }

    overlay.style.display = nativeChartWanted() ? "none" : "";
    if (nativeChartWanted()) hideTooltip();
    return overlay;
  }

  // The toolbar lives just above the chart wrapper (as its previous sibling,
  // in normal flow) rather than floating over the canvas, so it doesn't sit
  // on top of the graph.
  function ensureToolbar(wrapper) {
    if (wrapper.previousElementSibling?.classList.contains(TOOLBAR_CLASS)) {
      return wrapper.previousElementSibling;
    }

    const container = document.createElement("div");
    container.className = TOOLBAR_CLASS;

    const toolbar = document.createElement("div");
    toolbar.className = "aap-toggles-row";
    container.appendChild(toolbar);

    for (const m of METRICS) {
      const label = document.createElement("label");
      label.className = "aap-toggle";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "aap-toggle-checkbox aap-metric-checkbox";
      box.dataset.metric = m.key;
      box.addEventListener("change", () => {
        const next = { ...metricsOn, [m.key]: box.checked };
        if (!Object.values(next).some(Boolean)) {
          box.checked = true; // at least one metric must stay on
          return;
        }
        metricsOn = next;
        savePref({ [PREF_KEYS.metricsOn]: metricsOn });
        syncToolbar();
        drawChart();
      });
      label.appendChild(box);
      // Group the dot with the label text so it reads as belonging to the
      // label. If the dot were a direct flex child of .aap-toggle, the row's
      // `gap` would sit between the dot and the text ON TOP OF the dot's own
      // margin-right, pushing the dot oddly far from its label.
      const labelText = document.createElement("span");
      labelText.className = "aap-toggle-label";
      const dot = document.createElement("span");
      dot.className = "aap-tt-dot";
      dot.style.background = m.color;
      labelText.appendChild(dot);
      const text = document.createElement("span");
      text.textContent = m.label;
      if (m.kind === "bar") {
        // Re-labelled by syncToolbar to whichever KPI tab is active.
        dot.classList.add("aap-bar-dot");
        text.classList.add("aap-bar-label");
      }
      labelText.appendChild(text);
      label.appendChild(labelText);
      toolbar.appendChild(label);
    }

    const breakdownLabel = document.createElement("label");
    breakdownLabel.className = "aap-toggle";
    const breakdownBox = document.createElement("input");
    breakdownBox.type = "checkbox";
    breakdownBox.className = "aap-toggle-checkbox aap-breakdown-checkbox";
    breakdownBox.addEventListener("change", () => {
      compositionOn = breakdownBox.checked;
      savePref({ [PREF_KEYS.composition]: compositionOn });
      drawChart();
    });
    breakdownLabel.appendChild(breakdownBox);
    breakdownLabel.appendChild(document.createTextNode("Breakdown by actor"));
    toolbar.appendChild(breakdownLabel);

    const nativeLabel = document.createElement("label");
    nativeLabel.className = "aap-toggle";
    const nativeBox = document.createElement("input");
    nativeBox.type = "checkbox";
    nativeBox.className = "aap-toggle-checkbox aap-native-checkbox";
    nativeBox.addEventListener("change", () => {
      showNativeOn = nativeBox.checked;
      savePref({ [PREF_KEYS.showNative]: showNativeOn });
      drawChart();
    });
    nativeLabel.appendChild(nativeBox);
    nativeLabel.appendChild(document.createTextNode("Show original Apify chart"));
    toolbar.appendChild(nativeLabel);

    const status = document.createElement("span");
    status.className = "aap-status";
    toolbar.appendChild(status);

    wrapper.insertAdjacentElement("beforebegin", container);
    syncToolbar();
    return container;
  }

  // ---- date-range control -------------------------------------------------
  // Mounted right after the Console's own month picker (same flex row, same
  // 8px gap) so it reads as part of the native filter bar:
  //   [All Actors] [September 2026] [< >] (This month)(Last 30 days)(Last 90 days) [Custom range ▾]
  // The three pills are presets; with none active the chart follows the
  // month picker as before, and clicking the active pill again returns to
  // it. Custom range opens a popover with two native date inputs (the
  // browser's calendar dropdown) and Apply; once set, the button shows the
  // dates. If the native picker can't be found (a Console redesign), the
  // control falls back to the top of our own toolbar so it still works.
  const RANGE_SELECT_CLASS = "aap-range-select";
  const PILL_MODES = ["thisMonth", "last30", "last90"];
  const CHEVRON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M15 7.5c.71 0 1.08.822.652 1.352l-.063.07-5 5a.833.833 0 0 1-1.1.07l-.078-.07-5-5C3.88 8.4 4.208 7.5 5 7.5z"/></svg>';
  const CALENDAR_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><rect x="3" y="4.5" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M3 8.5h14M7 2.5v3.5M13 2.5v3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

  function findNativePicker() {
    return document.querySelector(".SequenceSelect");
  }

  function ensureRangeSelect(container) {
    let sel = document.querySelector(`.${RANGE_SELECT_CLASS}`);
    const picker = findNativePicker();
    const parent = picker ? picker.parentElement : container;
    if (sel && sel.parentElement !== parent) {
      sel.remove();
      sel = null;
    }
    if (!sel) {
      sel = buildRangeSelect();
      if (picker) {
        picker.insertAdjacentElement("afterend", sel);
        // The native header is a nowrap flex row with the filters on the
        // left and "All discounts" + download on the right; our pills make
        // the left group wide enough to push the right one off screen at
        // laptop widths. Let the left group wrap onto a second line (row
        // gap = its own 8px column gap) and keep the right group at its
        // natural size, pinned to the first line.
        const left = picker.parentElement;
        left.style.flexWrap = "wrap";
        left.style.rowGap = "8px";
        left.style.flex = "1 1 auto";
        const right = left.nextElementSibling;
        if (right) {
          right.style.flexShrink = "0";
          right.style.alignSelf = "flex-start";
        }
      } else container.prepend(sel);
      sel.classList.toggle("aap-range-select-fallback", !picker);
      syncRangeSelect(sel);
    }
    return sel;
  }

  function buildRangeSelect() {
    const sel = document.createElement("div");
    sel.className = RANGE_SELECT_CLASS;
    sel.setAttribute("role", "group");
    sel.setAttribute("aria-label", "Date range");
    sel.addEventListener("click", (e) => e.stopPropagation()); // clicks inside never reach the document "close" listeners

    for (const mode of PILL_MODES) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "aap-range-pill";
      pill.dataset.mode = mode;
      pill.textContent = RANGE_LABELS[mode];
      pill.addEventListener("click", () => {
        closeRangeMenu();
        // Clicking the active pill hands the chart back to the month picker.
        setRangeMode(state.rangeMode === mode ? "native" : mode);
      });
      sel.appendChild(pill);
    }

    const custom = document.createElement("div");
    custom.className = "aap-range-custom-wrap";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "aap-range-pill aap-range-trigger";
    trigger.dataset.mode = "custom";
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.title = "Pick a custom date range";
    trigger.innerHTML = `${CALENDAR_SVG}<span class="aap-range-trigger-label"></span>${CHEVRON_SVG}`;
    trigger.addEventListener("click", () => toggleRangeMenu(sel));
    custom.append(trigger, buildCustomPopover());
    sel.appendChild(custom);
    return sel;
  }

  function buildCustomPopover() {
    const box = document.createElement("div");
    box.className = "aap-range-menu aap-range-custom";
    box.hidden = true;
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Custom date range");

    const mk = (label, cls) => {
      const l = document.createElement("label");
      l.className = "aap-range-field";
      l.appendChild(document.createTextNode(label));
      const input = document.createElement("input");
      input.type = "date";
      input.className = cls;
      input.min = EARLIEST_CUSTOM;
      input.max = todayUtc();
      l.appendChild(input);
      return { l, input };
    };
    const from = mk("From", "aap-range-from");
    const to = mk("To", "aap-range-to");
    const err = document.createElement("div");
    err.className = "aap-range-err";
    const actions = document.createElement("div");
    actions.className = "aap-range-actions";
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "aap-range-clear";
    clear.textContent = "Clear";
    clear.title = "Back to the month picker";
    clear.addEventListener("click", () => {
      closeRangeMenu();
      if (state.rangeMode === "custom") setRangeMode("native");
    });
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "aap-range-apply";
    apply.textContent = "Apply";
    actions.append(clear, apply);
    box.append(from.l, to.l, err, actions);

    const submit = () => {
      const f = from.input.value;
      const t = to.input.value;
      const today = todayUtc();
      if (!f || !t) return void (err.textContent = "Pick both dates.");
      if (f > t) return void (err.textContent = "From must be on or before To.");
      if (t > today) return void (err.textContent = "To can't be in the future.");
      if (f < EARLIEST_CUSTOM) return void (err.textContent = `From can't be before ${EARLIEST_CUSTOM}.`);
      err.textContent = "";
      state.customRange = { from: f, to: t };
      savePref({ [PREF_KEYS.customRange]: state.customRange });
      closeRangeMenu();
      setRangeMode("custom");
    };
    apply.addEventListener("click", submit);
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    return box;
  }

  function toggleRangeMenu(sel) {
    const menu = sel.querySelector(".aap-range-menu");
    if (!menu.hidden) return closeRangeMenu();
    // Seed the inputs with the range on screen so "tweak what I'm looking
    // at" is one click away, falling back to the last 30 days.
    const cur = currentRange();
    const today = todayUtc();
    const from = menu.querySelector(".aap-range-from");
    const to = menu.querySelector(".aap-range-to");
    from.value = state.customRange?.from || cur?.from || addDays(today, -29);
    to.value = state.customRange?.to || cur?.to || today;
    from.max = today;
    to.max = today;
    menu.querySelector(".aap-range-err").textContent = "";
    menu.hidden = false;
    sel.querySelector(".aap-range-trigger").setAttribute("aria-expanded", "true");
    from.focus();
  }

  // Any deliberate use of the Console's own month picker (choosing a month
  // from its menu, or the prev/next arrows) hands the chart back to it —
  // even when the chosen month is the one already shown, which fires no new
  // request for the sniffer to notice. Capture phase, so React can't swallow
  // it first.
  document.addEventListener(
    "click",
    (e) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t || state.rangeMode === "native") return;
      if (t.closest('.SequenceSelect [role="option"], .SequenceSelect [class*="option"], .SequenceSelect-Controls button')) {
        setRangeMode("native");
      }
    },
    true,
  );

  function closeRangeMenu() {
    document.querySelectorAll(".aap-range-menu").forEach((m) => (m.hidden = true));
    document.querySelectorAll(".aap-range-trigger").forEach((t) => t.setAttribute("aria-expanded", "false"));
  }
  document.addEventListener("click", closeRangeMenu);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeRangeMenu();
  });

  // Active pill, and the custom button's label (the dates once one is set).
  function syncRangeSelect(sel) {
    sel.querySelectorAll(".aap-range-pill").forEach((pill) => {
      const active = pill.dataset.mode === state.rangeMode;
      pill.classList.toggle("aap-range-active", active);
      pill.setAttribute("aria-pressed", active ? "true" : "false");
    });
    const c = state.customRange;
    sel.querySelector(".aap-range-trigger-label").textContent =
      state.rangeMode === "custom" && c ? AAPF.rangeLabel(c.from, c.to) : RANGE_LABELS.custom;
  }

  // Reflects compositionOn/metricsOn onto whatever toolbar controls
  // currently exist (creation happens in ensureToolbar; this just keeps them
  // in sync after a state change or a poll-driven recreation).
  function syncToolbar() {
    const wrapper = findChartWrapper();
    const toolbar = wrapper?.previousElementSibling?.classList.contains(TOOLBAR_CLASS)
      ? wrapper.previousElementSibling
      : null;
    if (!toolbar) return;
    syncRangeRow(toolbar);
    toolbar.querySelectorAll(".aap-metric-checkbox").forEach((box) => {
      box.checked = !!metricsOn[box.dataset.metric];
    });
    // The bar toggle follows the active KPI tab (Costs / Revenue / Profit).
    const bar = barMetric();
    const barLabel = toolbar.querySelector(".aap-bar-label");
    if (barLabel) barLabel.textContent = bar.label;
    const barDot = toolbar.querySelector(".aap-bar-dot");
    if (barDot) barDot.style.background = bar.color;
    // Composition (stacking by Actor) only paints the bar metric.
    const breakdownBox = toolbar.querySelector(".aap-breakdown-checkbox");
    breakdownBox.checked = compositionOn;
    breakdownBox.disabled = !metricsOn.revenue;
    breakdownBox.title = breakdownBox.disabled ? `Enable ${bar.label} to see the actor breakdown` : "";

    const nativeBox = toolbar.querySelector(".aap-native-checkbox");
    nativeBox.checked = nativeChartWanted();
    nativeBox.disabled = headline === "margin";
    nativeBox.title = headline === "margin" ? "Margin is a ratio, so Apify's own chart is shown for it" : "";
  }

  // The range pills next to the native month picker.
  function syncRangeRow(toolbar) {
    const sel = ensureRangeSelect(toolbar);
    if (sel) syncRangeSelect(sel);
  }

  function unmountOverlay() {
    const wrapper = findChartWrapper();
    const overlay = wrapper?.querySelector(`.${OVERLAY_CLASS}`);
    if (overlay) overlay.remove();
    document.querySelectorAll(".aap-runs-overlay").forEach((el) => el.remove());
    document.querySelectorAll("canvas[data-aap-runs-native]").forEach((canvas) => {
      canvas.style.visibility = "";
      delete canvas.dataset.aapRunsNative;
    });
    if (wrapper?.previousElementSibling?.classList.contains(TOOLBAR_CLASS)) {
      wrapper.previousElementSibling.remove();
    }
    const nativeCanvas = wrapper?.querySelector("canvas:not(.aap-chart)");
    if (nativeCanvas) nativeCanvas.style.visibility = "";
    document.querySelector(".aap-tooltip")?.remove();
    document.querySelector(`.${RANGE_SELECT_CLASS}`)?.remove();
    document.querySelector(`.${HIGHLIGHTS_CLASS}`)?.remove();
    restoreKpiCards();
    // The tooltip element is gone, but the pin/day state is separate JS
    // state — without resetting it here, navigating back to the Insights
    // page later would find pinnedDay still set and onHover would keep
    // silently no-op'ing forever (it defers entirely to a pinned tooltip).
    pinnedDay = null;
    pinnedKind = null;
    tooltipDay = null;
  }

  // Single trigger point, polled: the anchor may not exist yet on first
  // paint, AND the Console's own React tree periodically reconciles that
  // wrapper and wipes out nodes it doesn't recognize (including re-showing
  // the native canvas). Every 400ms: make sure the overlay/toolbar exist and
  // the native canvas is hidden, load whichever range we should be showing
  // if we haven't already, and otherwise just redraw.
  let loadedKey = null;
  let prefsLoaded = false; // the persisted range mode must be known before the first load

  // Loads the current range if it isn't the one already loaded (or loading).
  // Shared by the poll and by the range buttons.
  function maybeLoad() {
    if (!prefsLoaded || !onInsightsRoute() || !ensureOverlay()) return;
    const key = scopeKey();
    if (key && key !== loadedKey) {
      loadedKey = key;
      loadRange().catch(() => {});
      return true;
    }
    return false;
  }

  const poll = setInterval(() => {
    if (!contextAlive()) return retireOrphan();
    try {
      pollTick();
    } catch (err) {
      // A reload can land mid-tick: the check above passed, then chrome.*
      // vanished under us. Anything else is a real bug and should surface.
      if (isInvalidated(err)) retireOrphan();
      else throw err;
    }
  }, 400);

  function pollTick() {
    if (!onInsightsRoute()) return;
    // Follow the Console's KPI tab (Costs / Revenue / Profit / Margin).
    const nextHeadline = nativeHeadline();
    if (nextHeadline !== headline) {
      headline = nextHeadline;
      hideTooltip();
      syncToolbar();
      if (lastData) drawChart();
    }
    const overlay = ensureOverlay();
    if (!overlay) return;
    ensureDailyRunsOverlay();
    syncKpiCards();
    // The first load of a range always runs, visible or not — macOS Chrome
    // reports an occluded window as `document.hidden`, so gating the initial
    // load on visibility left the chart blank until the window was uncovered.
    // Only the *periodic* refreshes below pause while hidden.
    if (maybeLoad()) return;
    const key = scopeKey();
    // Redraw before the visibility gate: Apify's React tree can recreate the
    // chart wrapper (and so our canvas) while the tab is hidden, and a
    // hidden tab that never redraws comes back to a blank chart. Drawing is
    // local and cheap; only the network refreshes below wait for a viewer.
    if (lastData) drawChart();
    // A hidden tab doesn't refresh: nobody is looking, and every refresh is
    // a request to Apify. It catches up via the staleness checks below the
    // moment it's visible again.
    if (document.hidden) return;
    // Live refreshes only make sense while the range reaches into the
    // current month — see rangeIsLive. A past range's numbers are final; one
    // load per cache TTL is plenty. A failed load is retried regardless
    // (ERROR_RETRY_MS).
    const live = rangeIsLive(currentRange());
    if (live && key && Date.now() - dayMetricsFetchedAt > DAY_METRICS_REFRESH_MS) {
      refreshDayMetrics(monthOf(todayUtc()), state.actorIds);
    }
    // Periodically re-run the whole load (cache check + re-index once the
    // current month's cache has gone stale) so a long-open tab's per-Actor
    // breakdown keeps up with today — see BREAKDOWN_REFRESH_MS. Past months
    // in the range are served straight from cache. loadRange stamps
    // breakdownRefreshedAt itself, which also covers the initial load.
    if ((live || lastData?.error) && key && lastData && !lastData.indexing && Date.now() - breakdownRefreshedAt > BREAKDOWN_REFRESH_MS) {
      loadRange().catch(() => {});
    }
  }
  window.addEventListener("beforeunload", () => clearInterval(poll));

  // Re-fetches just the account-wide day totals of ONE month (not the
  // per-Actor breakdown) so the headline Revenue/Costs/Runs/Results stay live
  // for as long as the tab is left open on this page, instead of freezing at
  // whatever they were when the range was first loaded. Only ever called for
  // the current month — the only one whose totals still move.
  async function refreshDayMetrics(month, actorIds) {
    if (dayMetricsFetching) return;
    dayMetricsFetching = true;
    const key = scopeKey();
    const scope = cacheScope(actorIds);
    try {
      const dayMetrics = await fetchDayMetrics(month, actorIds);
      if (key !== scopeKey()) return; // user switched month/range/filter mid-flight
      dayMetricsFetchedAt = Date.now();
      monthData[month] = { ...monthData[month], dayMetrics };
      await AAP_CACHE.setMetrics(month, scope, dayMetrics);
      if (key === scopeKey()) publish();
    } catch (err) {
      if (isInvalidated(err)) return retireOrphan();
      dayMetricsFetchedAt = Date.now(); // back off; retry after the next interval regardless
    } finally {
      dayMetricsFetching = false;
    }
  }

  // ---- data ------------------------------------------------------------
  let indexRun = 0; // guards against a stale load finishing after a range switch
  let lastData = null; // see publish(): { range, months, dayMetrics, daily, indexedMonths, actorCount, indexing, progress, pendingMonths, error }
  let compositionOn = false;
  let metricsOn = { revenue: true, runs: false, results: false };
  let showNativeOn = false;
  let highlightsOn = true;
  let tooltipActorCount = DEFAULT_TOOLTIP_ACTOR_COUNT;
  let colorByActorId = new Map();
  let iconByActorId = new Map(); // actorId -> pictureUrl, merged over the months on screen
  let dayMetricsFetchedAt = 0;
  let dayMetricsFetching = false;
  let breakdownRefreshedAt = 0;
  // Everything loaded so far for the current cache scope (org + filter),
  // per month: { dayMetrics, daily, actorCount, breakdown, indexedAt,
  // complete }. Range views are assembled from this by publish(); switching
  // between overlapping ranges (Last 30 → Last 90 → This month) reuses it
  // without touching storage, let alone the network.
  let monthData = {};
  let monthDataScope = null;
  // The scope key the user asked to index past AUTO_INDEX_MONTHS for.
  let indexAllFor = null;

  // True when a current-month cache predates activity now visible in the
  // account-wide totals. Revenue and runs are checked independently because
  // the Daily runs breakdown also includes Actors whose runs generated no
  // revenue. This lets the cheap minute refresh invalidate a stale Actor
  // index before its normal 15-minute TTL when a new day starts moving.
  function breakdownMissingActiveDay(daily, dayMetrics) {
    return Object.entries(dayMetrics || {}).some(([day, m]) => {
      const rows = daily?.[day] || [];
      if (m.revenue > 0 && !rows.some((r) => (r.revenue || 0) > 0)) return true;
      const indexedRuns = rows.reduce((sum, r) => sum + (r.runs || 0), 0);
      return m.runs > indexedRuns;
    });
  }

  // A month with no revenue, cost or runs on any day: nothing to index (and,
  // for "All time" discovery, nothing to show).
  function isEmptyMetrics(dayMetrics) {
    return !Object.values(dayMetrics || {}).some((m) => m.revenue > 0 || m.cost > 0 || m.runs > 0);
  }

  // The two cheap account-wide calls for one month, merged per day.
  async function fetchDayMetrics(month, actorIds) {
    const [margin, runs] = await Promise.all([
      AAP_API.profitMargin(month, actorIds),
      AAP_API.runStatistics(month, actorIds),
    ]);
    return buildDayMetrics(margin, runs);
  }

  // Assembles lastData for the current range from monthData: day totals and
  // per-Actor rows clipped to [from, to], colours ranked over the whole
  // range (so an Actor keeps its colour across every day on screen), plus
  // whatever load-state flags the caller passes.
  function publish(extra) {
    const range = currentRange();
    if (!range) return;
    const months = range.from ? monthsBetween(range.from, range.to) : [];
    const inRange = (day) => (!range.from || day >= range.from) && day <= range.to;
    const dayMetrics = {};
    const daily = {};
    const indexedMonths = [];
    const actors = new Set();
    const icons = new Map();
    for (const m of months) {
      const md = monthData[m];
      if (!md) continue;
      for (const [id, url] of Object.entries(md.icons || {})) icons.set(id, url);
      for (const [day, v] of Object.entries(md.dayMetrics || {})) if (inRange(day)) dayMetrics[day] = v;
      if (md.daily) {
        indexedMonths.push(m);
        for (const [day, rows] of Object.entries(md.daily)) {
          if (!inRange(day)) continue;
          daily[day] = rows;
          for (const r of rows) actors.add(r.actorId);
        }
      }
    }
    colorByActorId = buildColorMap(daily);
    iconByActorId = icons;
    setData({
      range,
      months,
      dayMetrics,
      daily,
      indexedMonths,
      actorCount: actors.size,
      progress: null,
      phase: null,
      ...extra,
    });
  }

  // Loads whatever currentRange() says should be on screen:
  //   1. day totals for every month in the range (2 requests per month not
  //      in cache; past months stay cached for 30 days) — the chart is
  //      drawn as soon as these land, newest month first;
  //   2. the per-Actor breakdown, one month at a time, newest first, from
  //      cache where it's fresh, indexing at most AUTO_INDEX_MONTHS uncached
  //      months (or all of them once the user clicked "Load more").
  // "All time" first resolves the account's earliest month (see
  // resolveFirstMonth). Any range switch mid-way bumps indexRun, and every
  // await below checks it, so a superseded load stops spending requests.
  async function loadRange() {
    if (!contextAlive()) return;
    const overlay = ensureOverlay();
    if (!overlay) return;
    breakdownRefreshedAt = Date.now(); // pace the poll's periodic re-run
    const myRun = ++indexRun;
    const key = scopeKey();
    const actorIds = state.actorIds;
    const scope = cacheScope(actorIds);
    const alive = () => myRun === indexRun && key === scopeKey();
    if (monthDataScope !== scope) {
      monthData = {};
      monthDataScope = scope;
    }

    try {
      let range = currentRange();
      if (!range) return;
      // A fresh pass: clear the previous one's outcome. Overlapping ranges
      // render immediately from monthData here, before any I/O.
      publish({ indexing: true, phase: "Loading…", error: null, pendingMonths: [] });
      if (!range.from) {
        publish({ indexing: true, phase: "Finding your first month…" });
        const first = await resolveFirstMonth(() => !alive());
        if (!alive() || !first) return;
        state.firstMonth[currentOrg()] = first;
        range = currentRange();
      }
      const months = monthsBetween(range.from, range.to);

      // 1. Day totals. Memory first, then storage, then the network.
      const missing = [];
      for (const m of months) {
        if (monthData[m]?.dayMetrics && !isCurrentMonth(m)) continue;
        const c = await AAP_CACHE.getMetrics(m, scope);
        if (c && !c.stale) {
          monthData[m] = { ...monthData[m], dayMetrics: c.dayMetrics };
          if (isCurrentMonth(m)) dayMetricsFetchedAt = c.updatedAt; // the poll's 60 s refresh counts from the cached fetch
        } else missing.push(m);
      }
      if (!alive()) return;
      publish({ indexing: true, phase: missing.length ? "Loading day totals…" : null });
      const fetched = await AAP_API.pooled(
        missing,
        async (m) => {
          const dayMetrics = await fetchDayMetrics(m, actorIds);
          if (!alive()) return true;
          monthData[m] = { ...monthData[m], dayMetrics };
          if (isCurrentMonth(m)) dayMetricsFetchedAt = Date.now();
          await AAP_CACHE.setMetrics(m, scope, dayMetrics);
          publish({ indexing: true, phase: "Loading day totals…" });
          return true;
        },
        null,
        () => !alive(),
      );
      if (!alive()) return;
      if (fetched.some((r) => r === null)) throw new Error("Failed to fetch day totals");

      // 2. Per-Actor breakdown, newest month first.
      let budget = indexAllFor === key ? Infinity : AUTO_INDEX_MONTHS;
      const pending = [];
      for (const m of months) {
        if (!alive()) return;
        const dayMetrics = monthData[m]?.dayMetrics || {};
        if (monthData[m]?.complete && !isCurrentMonth(m)) continue; // loaded earlier this session
        const cached = await AAP_CACHE.get(m, scope);
        if (!alive()) return;
        // A cache can be fresh by TTL yet already wrong: indexed before
        // today's first revenue-producing or free run, its per-Actor rows
        // trail the just-fetched totals. Re-index despite the TTL.
        const usable = cached && !cached.stale && !(isCurrentMonth(m) && breakdownMissingActiveDay(cached.daily, dayMetrics));
        if (usable) {
          monthData[m] = { ...monthData[m], daily: cached.daily, actorCount: cached.actorCount, breakdown: cached.breakdown || null, icons: cached.icons || {}, indexedAt: cached.updatedAt, complete: true };
          publish({ indexing: true });
          continue;
        }
        // Nothing happened this month: no Actor to index. Cache that as a
        // complete (empty) breakdown so it's never probed again.
        if (isEmptyMetrics(dayMetrics)) {
          monthData[m] = { ...monthData[m], daily: {}, actorCount: 0, breakdown: [], indexedAt: Date.now(), complete: true };
          await AAP_CACHE.set(m, scope, { daily: {}, actorCount: 0, breakdown: [], dayMetrics });
          continue;
        }
        if (budget <= 0) {
          pending.push(m);
          continue;
        }
        budget--;
        const r = await indexMonth(m, actorIds, scope, dayMetrics, (done, total) => {
          if (alive()) publish({ indexing: true, progress: { done, total, month: m, monthsLeft: months.length - 1 - months.indexOf(m) } });
        }, () => !alive());
        if (!alive()) return;
        monthData[m] = { ...monthData[m], ...r };
        publish({ indexing: true });
      }
      if (!alive()) return;
      publish({ indexing: false, pendingMonths: pending });
    } catch (err) {
      if (isInvalidated(err)) return retireOrphan();
      if (!alive()) return;
      // Schedule the poll's next full load ERROR_RETRY_MS from now instead
      // of a full BREAKDOWN_REFRESH_MS away.
      breakdownRefreshedAt = Date.now() - BREAKDOWN_REFRESH_MS + ERROR_RETRY_MS;
      publish({ indexing: false, error: describeError(err) });
    }
  }

  // Indexes one month's per-Actor breakdown: the month's Actor list (one
  // call), then run-statistics per active Actor and profit-margin for Actors
  // with revenue or cost (at most two calls each, 5 Actors in flight). This
  // includes free-only activity in the Daily runs breakdown without making a
  // pointless margin request for it. Caches only complete passes: a handful of per-Actor
  // fetches can transiently fail (a network blip, the auth token racing
  // readiness right after page load — see pooled()'s per-item catch), and
  // caching that would lock in an undercounted breakdown for the full TTL,
  // silently. A partial pass still renders (better than nothing) but the
  // next load retries instead of serving stale wrong data.
  async function indexMonth(month, actorIds, scope, dayMetrics, onProgress, shouldStop) {
    const raw = await AAP_API.actorBreakdown(month, actorIds);
    // Keep only fields used by the analytics UI; whole Actor objects would
    // unnecessarily bloat the local per-month cache record.
    const breakdown = (Array.isArray(raw) ? raw : raw?.monetizationPerActor || []).map((item) => ({
      actor: { _id: item.actor?._id, title: item.actor?.title, name: item.actor?.name, pictureUrl: item.actor?.pictureUrl },
      earningsStats: item.earningsStats,
      runsStats: item.runsStats,
      usersStats: item.usersStats,
    }));
    const activeActors = breakdown
      .map((item) => {
        const totalRevenueUsd = item.earningsStats?.totalRevenueUsd ?? 0;
        const totalCostUsd = item.earningsStats?.totalCostUsd ?? 0;
        const hasRuns = Object.values(item.runsStats || {}).some((v) => typeof v === "number" && v > 0);
        return {
          actorId: item.actor?._id,
          actorName: item.actor?.title || item.actor?.name || item.actor?._id,
          totalRevenueUsd,
          totalCostUsd,
          paid: totalRevenueUsd > 0 || totalCostUsd > 0,
          hasRuns,
        };
      })
      .filter((a) => a.actorId && (a.paid || a.hasRuns));

    const perActor = await AAP_API.pooled(
      activeActors,
      async (actor) => {
        const [margin, runs] = await Promise.all([
          actor.paid ? AAP_API.profitMargin(month, [actor.actorId]) : Promise.resolve(null),
          AAP_API.runStatistics(month, [actor.actorId]),
        ]);
        return { actor, margin, runs };
      },
      onProgress,
      shouldStop,
    );
    const daily = buildDailyIndex(perActor);
    const complete = perActor.every((e) => e != null);
    const actorCount = activeActors.length;
    // Actor icons (the Console's own pictureUrl), kept as a small per-month
    // map rather than on every daily row.
    const icons = {};
    for (const item of breakdown) if (item.actor._id && item.actor.pictureUrl) icons[item.actor._id] = item.actor.pictureUrl;
    if (complete) await AAP_CACHE.set(month, scope, { daily, actorCount, breakdown, dayMetrics, icons });
    return { daily, actorCount, breakdown, icons, indexedAt: Date.now(), complete };
  }

  // Finds the account's earliest month with any activity, for "All time":
  // walks back from the current month, ALL_TIME_PROBE_BATCH months at a
  // time (in parallel), until ALL_TIME_EMPTY_STREAK consecutive months are
  // empty or ALL_TIME_MAX_MONTHS have been checked. Probed months go into
  // the ordinary day-totals cache (they're wanted for the chart anyway), and
  // the answer is cached for good — activity can't appear before it.
  // Always probes account-wide, whatever the native filter says.
  async function resolveFirstMonth(shouldStop) {
    const org = currentOrg();
    const cached = await AAP_CACHE.getFirstMonth(org);
    if (cached) return cached;
    const scope = cacheScope([]);
    let month = monthOf(todayUtc());
    let firstSeen = null;
    let streak = 0;
    let checked = 0;
    while (checked < ALL_TIME_MAX_MONTHS && streak < ALL_TIME_EMPTY_STREAK) {
      if (shouldStop()) return null;
      const batch = [];
      for (let i = 0; i < ALL_TIME_PROBE_BATCH; i++) {
        batch.push(month);
        month = addMonths(month, -1);
      }
      publish({ indexing: true, phase: `Finding your first month… (${AAPF.monthLabel(batch[batch.length - 1])})` });
      const results = await Promise.all(
        batch.map(async (m) => {
          const c = await AAP_CACHE.getMetrics(m, scope);
          if (c && !c.stale) return c.dayMetrics;
          let dayMetrics;
          try {
            dayMetrics = await fetchDayMetrics(m, []);
          } catch (err) {
            // A month before the account existed may 4xx rather than come
            // back empty; auth/network failures still propagate.
            if (/HTTP (400|404|422)/.test(String(err && err.message))) dayMetrics = {};
            else throw err;
          }
          await AAP_CACHE.setMetrics(m, scope, dayMetrics);
          return dayMetrics;
        }),
      );
      for (let i = 0; i < batch.length; i++) {
        checked++;
        if (isEmptyMetrics(results[i])) streak++;
        else {
          streak = 0;
          firstSeen = batch[i];
        }
        if (streak >= ALL_TIME_EMPTY_STREAK) break;
      }
    }
    const first = firstSeen || monthOf(todayUtc());
    await AAP_CACHE.setFirstMonth(org, first);
    return first;
  }

  // "TypeError: Failed to fetch" is what the browser says for any network-
  // level failure (offline, DNS, TLS, a blocked request). Say so, and that
  // we'll retry, instead of echoing the raw exception.
  function describeError(err) {
    const msg = String(err && err.message ? err.message : err);
    if (/failed to fetch|networkerror|load failed/i.test(msg)) {
      return `network error reaching Apify, retrying in ${Math.round(ERROR_RETRY_MS / 1000)}s`;
    }
    return msg;
  }

  // Merges profit-margin + run-statistics into
  // { [date]: { revenue, cost, profit, margin, runs, results,
  //              succeeded, aborted, failed, timedOut, successRate } }.
  //
  // profit-margin returns BOTH `payingUsersUsd` and `allUsersUsd` per day.
  // The Console's own chart (and its "only paying users generate revenue and
  // costs" caption) uses `payingUsersUsd` — `allUsersUsd` is a superset that
  // folds in free-tier usage, which inflates Revenue/Costs above what Apify
  // itself displays. Use payingUsersUsd to match.
  function buildDayMetrics(margin, runs) {
    const days = new Set([
      ...Object.keys(margin?.dailyProfitMarginStats || {}),
      ...Object.keys(runs?.dailyStats || {}),
    ]);
    const out = {};
    for (const day of days) {
      const m = margin?.dailyProfitMarginStats?.[day]?.payingUsersUsd;
      const r = runs?.dailyStats?.[day];
      out[day] = {
        revenue: m?.revenueUsd ?? 0,
        cost: m?.costUsd ?? 0,
        profit: m?.profitUsd ?? 0,
        margin: m?.margin ?? null,
        runs: r?.TOTAL ?? 0,
        results: r?.RESULTS ?? 0,
        succeeded: r?.SUCCEEDED ?? 0,
        aborted: r?.ABORTED ?? 0,
        failed: r?.FAILED ?? 0,
        timedOut: r?.["TIMED-OUT"] ?? r?.TIMED_OUT ?? 0,
        successRate: r?.TOTAL ? r.SUCCEEDED / r.TOTAL : null,
      };
    }
    return out;
  }

  function metricValue(day, metric) {
    return (lastData.dayMetrics || {})[day]?.[metric] ?? 0;
  }

  // Which metric drives sorting/coloring when more than one is active:
  // Revenue > Runs > Results, whichever is checked first.
  function primaryMetric() {
    if (metricsOn.revenue) return barMetric().key;
    return METRICS.find((m) => m.kind === "line" && metricsOn[m.key])?.key || barMetric().key;
  }

  // perActor -> per-day Actor rows containing monetization, result, and
  // run-status counts used by both interactive chart tooltips.
  function buildDailyIndex(perActor) {
    const daily = {};
    for (const entry of perActor) {
      if (!entry) continue;
      const { actor, margin, runs } = entry;
      const marginByDay = margin?.dailyProfitMarginStats || {};
      const runsByDay = runs?.dailyStats || {};
      const days = new Set([...Object.keys(marginByDay), ...Object.keys(runsByDay)]);
      for (const day of days) {
        const m = marginByDay[day]?.payingUsersUsd; // see buildDayMetrics
        const r = runsByDay[day];
        if (!m && !r) continue;
        const row = {
          actorId: actor.actorId,
          name: actor.actorName,
          revenue: m?.revenueUsd ?? 0,
          cost: m?.costUsd ?? 0,
          profit: m?.profitUsd ?? 0,
          margin: m?.margin ?? null,
          runs: r?.TOTAL ?? null,
          succeeded: r?.SUCCEEDED ?? null,
          aborted: r?.ABORTED ?? null,
          failed: r?.FAILED ?? null,
          timedOut: r?.["TIMED-OUT"] ?? r?.TIMED_OUT ?? null,
          results: r?.RESULTS ?? null,
          successRate: r && r.TOTAL ? r.SUCCEEDED / r.TOTAL : null,
        };
        if (!row.revenue && !row.cost && !row.runs) continue;
        (daily[day] ||= []).push(row);
      }
    }
    return daily;
  }

  // Assigns a stable color per Actor, ranked by total revenue across the
  // whole indexed month — so an Actor's color stays the same from day to day
  // (and across metric switches) instead of being re-picked per day/metric.
  function buildColorMap(daily) {
    const totals = new Map();
    for (const rows of Object.values(daily)) {
      for (const row of rows) {
        totals.set(row.actorId, (totals.get(row.actorId) || 0) + row.revenue);
      }
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const map = new Map();
    ranked.slice(0, TOP_N).forEach(([actorId], i) => map.set(actorId, PALETTE[i]));
    return map;
  }

  function setData(data) {
    lastData = { ...lastData, ...data };
    drawChart();
  }

  // ---- chart drawing ------------------------------------------------------
  // Dual y-axis: Revenue (bars) reads the left axis in $. Runs and Results
  // (lines) each get their OWN right-side axis — sharing one would make
  // whichever metric has the smaller magnitude look flat (Results is
  // typically an order of magnitude above Runs). Gridlines are drawn once,
  // at even fractions of the plot height, and every axis's own max is
  // mapped onto those same fractions — the standard way to keep several
  // independent scales visually aligned on one set of horizontal lines.
  const PAD = { left: 56, top: 12, bottom: 22 };
  const AXIS_GUTTER = 48; // width reserved per right-side axis column
  const TICK_TARGET = 8; // max gridline steps above $0 — Apify's own chart shows 0/50/.../400

  // Single source of truth for the plot's horizontal padding. drawChart and
  // onHover MUST agree on this — each active line metric adds a right-side
  // axis gutter that narrows the plot, and if hover assumes a different width
  // it maps the cursor x to the wrong day.
  function plotPads() {
    const lineCount = METRICS.filter((m) => m.kind === "line" && metricsOn[m.key]).length;
    return {
      left: metricsOn.revenue ? PAD.left : 16,
      right: 16 + lineCount * AXIS_GUTTER,
    };
  }

  // Picks a "nice" step (1/2/5 x a power of ten) and lets the gridline COUNT
  // vary to cover the data, e.g. 360 -> steps of 50 over 8 ticks (axis 400).
  // This is what Apify's own chart does. Forcing a fixed tick count instead
  // makes the step itself absorb all the rounding — 360 over a fixed 7 needs
  // a step > 51.4, whose next nice value is 100, blowing the axis out to 700,
  // nearly double the tallest bar.
  function niceScale(maxValue) {
    if (maxValue <= 0) return { max: TICK_TARGET, ticks: TICK_TARGET };
    const rawStep = maxValue / TICK_TARGET;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    // Round UP to the next nice step so ticks never exceeds TICK_TARGET —
    // ceil() below then trims the count back down to just cover the data.
    const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    const step = niceNorm * mag;
    const ticks = Math.max(1, Math.ceil(maxValue / step));
    return { max: step * ticks, ticks };
  }

  // Rounds a data max up to a nice axis max split into a FIXED number of
  // intervals — used by the secondary axes, which must share the gridline
  // count the primary axis picked (see the note above drawChart).
  function niceAxisMax(maxValue, intervals) {
    if (maxValue <= 0) return intervals;
    const rawStep = maxValue / intervals;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    // Round UP to the next nice step — snapping to the *nearest* one can pick
    // a step below the data max (e.g. 3600/7 -> norm 5.14 -> 5 -> axis 3500),
    // which draws the series past the top of the plot.
    const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return niceNorm * mag * intervals;
  }

  function drawChart() {
    drawDailyRunsChart();
    if (headline === "margin") return; // native monetization chart is on screen
    const overlay = ensureOverlay();
    if (!overlay || !lastData) return;
    syncToolbar();

    const wrapper = overlay.parentElement;
    const toolbar = wrapper.previousElementSibling;
    const status = toolbar?.querySelector(".aap-status");
    if (status) renderStatus(status);
    ensureHighlights();

    const canvas = overlay.querySelector(".aap-chart");
    const rect = wrapper.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const days = Object.keys(lastData.dayMetrics || {}).sort();
    canvas.__aapDays = days; // read back by the hover handler
    if (!days.length) {
      if (!lastData.indexing && !lastData.error) {
        ctx.font = `13px ${getComputedStyle(wrapper).fontFamily || "sans-serif"}`;
        ctx.fillStyle = AXIS_LABEL_COLOR;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("No activity in this range.", rect.width / 2, rect.height / 2);
      }
      return;
    }

    const showLeft = metricsOn.revenue;
    const lineMetrics = METRICS.filter((m) => m.kind === "line" && metricsOn[m.key]);

    // The primary axis (Revenue when shown, else the first line metric) picks
    // both its own max AND the shared gridline count via niceScale; every
    // other axis rounds its max up onto that same count.
    const dataMax = (key) => Math.max(1, ...days.map((d) => metricValue(d, key)));
    const bar = barMetric();
    const primaryKey = showLeft ? bar.key : lineMetrics[0]?.key;
    const { max: primaryMax, ticks } = niceScale(primaryKey ? dataMax(primaryKey) : 1);
    const leftMax = showLeft ? primaryMax : 1;
    // Each line metric gets its own scale — see the note on PAD above.
    const lineMax = new Map(
      lineMetrics.map((m, i) => [
        m.key,
        !showLeft && i === 0 ? primaryMax : niceAxisMax(dataMax(m.key), ticks),
      ]),
    );

    // Canvas 2D's `font` has no "inherit" keyword (unlike CSS) — an invalid
    // value here is silently dropped, leaving the browser's ~10px default,
    // which is why this always rendered smaller than Apify's own chart no
    // matter what size was requested. Read the page's real font stack instead.
    // Set before the measureText calls below, which depend on it.
    ctx.font = `13px ${getComputedStyle(wrapper).fontFamily || "sans-serif"}`;
    ctx.textBaseline = "middle";

    // Size the left gutter to the widest y-axis label instead of a fixed
    // width — "$400.00" needs more than the old fixed gutter allowed, which
    // clipped the leading "$" off the canvas edge.
    let leftPad = 16;
    if (showLeft) {
      let w = 0;
      for (let i = 0; i <= ticks; i++) {
        w = Math.max(w, ctx.measureText(AAPF.money(leftMax * (i / ticks))).width);
      }
      leftPad = Math.ceil(w) + 16; // 8px to the plot edge + 8px to the canvas edge
    }
    const rightPad = 16 + lineMetrics.length * AXIS_GUTTER;
    // The hover handler must map cursor x with the same pads this draw used.
    canvas.__aapPads = { left: leftPad, right: rightPad };

    const plotW = rect.width - leftPad - rightPad;
    const plotH = rect.height - PAD.top - PAD.bottom;
    const slot = plotW / days.length;
    // Dense ranges (a year is ~2-3px per day) get edge-to-edge bars; roomier
    // ones keep the usual 60% bar with a gap.
    const barW = slot < 6 ? Math.max(1, slot) : Math.max(4, slot * 0.6);

    // gridlines, shared across every axis (see comment above)
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    for (let i = 0; i <= ticks; i++) {
      const frac = i / ticks;
      const y = PAD.top + plotH * (1 - frac);
      ctx.beginPath();
      ctx.moveTo(leftPad, y);
      ctx.lineTo(rect.width - rightPad, y);
      ctx.stroke();
      if (showLeft) {
        ctx.fillStyle = AXIS_LABEL_COLOR;
        ctx.textAlign = "right";
        ctx.fillText(AAPF.money(leftMax * frac), leftPad - 8, y);
      }
      lineMetrics.forEach((m, col) => {
        ctx.fillStyle = m.color;
        ctx.textAlign = "left";
        const x = rect.width - rightPad + 8 + col * AXIS_GUTTER;
        ctx.fillText(AAPF.compact(lineMax.get(m.key) * frac), x, y);
      });
    }

    // x-axis labels — see xAxisLabels for the thinning rules.
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = AXIS_LABEL_COLOR;
    for (const { i, text } of xAxisLabels(days, slot, ctx)) {
      ctx.fillText(text, leftPad + i * slot + slot / 2, rect.height - PAD.bottom + 6);
    }

    // Bar metric (Costs / Revenue / Profit, left axis), optionally stacked
    // by Actor. A negative day (profit can be) draws as an empty slot — the
    // axis starts at $0 like Apify's own — its value still shows in the
    // tooltip.
    if (showLeft) {
      days.forEach((day, i) => {
        const x = leftPad + i * slot + slot / 2;
        const total = Math.max(0, metricValue(day, bar.key));
        const barH = (total / leftMax) * plotH;
        const yTop = PAD.top + plotH - barH;

        if (compositionOn && lastData.daily?.[day]?.length) {
          let acc = 0;
          const grouped = new Map();
          for (const row of lastData.daily[day]) {
            const key = colorByActorId.get(row.actorId) || OTHER_COLOR;
            grouped.set(key, (grouped.get(key) || 0) + Math.max(0, row[bar.key] || 0));
          }
          // Stack every bar in the SAME order — by each Actor's month-long
          // revenue rank (its position in PALETTE), with the merged "other
          // Actors" grey band always on top. Without this, segments are drawn
          // in whatever order Actors happened to be active that day, so a
          // given Actor's colour lands in a different band on each bar and
          // looks like it changed colour from day to day.
          const rank = (color) => {
            const i = PALETTE.indexOf(color);
            return i === -1 ? Infinity : i; // OTHER_COLOR (not in PALETTE) sorts last → top of stack
          };
          const sumRows = [...grouped.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
          const rowsTotal = [...grouped.values()].reduce((s, v) => s + v, 0) || 1;
          for (const [color, value] of sumRows) {
            const segH = (value / rowsTotal) * barH;
            ctx.fillStyle = color;
            ctx.fillRect(x - barW / 2, yTop + barH - acc - segH, barW, segH);
            acc += segH;
          }
        } else {
          ctx.fillStyle = bar.color;
          ctx.fillRect(x - barW / 2, yTop, barW, barH);
        }
      });
    }

    // Runs/Results lines (each on its own right-side axis) — drawn as a
    // smooth spline rather than straight segments between days, closer to a
    // typical analytics chart.
    for (const m of lineMetrics) {
      const max = lineMax.get(m.key);
      const pts = days.map((day, i) => {
        const x = leftPad + i * slot + slot / 2;
        const v = metricValue(day, m.key);
        const y = PAD.top + plotH - (v / max) * plotH;
        return { x, y };
      });

      ctx.strokeStyle = m.color;
      ctx.fillStyle = m.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      drawSmoothLine(ctx, pts);
      ctx.stroke();

      // Point markers only when there's room for them; on a dense range
      // they'd merge into a thick smear over the line.
      if (slot >= 6) {
        for (const p of pts) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  // x-axis labels thinned to a clean day step (every 1/2/4/7/14 days) like
  // Apify's own chart, based on the measured label width (a fixed ~34px
  // guess under-measures "Jul 27"-style labels and they ran into each
  // other). Once even every-14-days won't fit — a multi-month range — label
  // month starts instead ("Sep 2026"), thinned to every 2nd/3rd/6th/12th
  // month the same way.
  function xAxisLabels(days, slot, ctx) {
    const dayW = Math.max(...days.map((d) => ctx.measureText(AAPF.shortDate(d)).width));
    const every = [1, 2, 4, 7, 14].find((s) => slot * s >= dayW + 24);
    if (every) return days.map((d, i) => (i % every === 0 ? { i, text: AAPF.shortDate(d) } : null)).filter(Boolean);
    const starts = days.map((d, i) => ({ d, i })).filter((x) => x.d.endsWith("-01"));
    if (!starts.length) return [{ i: 0, text: AAPF.shortDate(days[0]) }];
    const monthW = Math.max(...starts.map((x) => ctx.measureText(AAPF.monthLabel(x.d)).width));
    const mEvery = [1, 2, 3, 6, 12].find((s) => slot * 28 * s >= monthW + 24) ?? 12;
    return starts.filter((_, k) => k % mEvery === 0).map((x) => ({ i: x.i, text: AAPF.monthLabel(x.d) }));
  }

  // The toolbar status line: load progress, errors, or — once a range has
  // more uncached months than AUTO_INDEX_MONTHS — how much of the range has
  // a per-Actor breakdown, with a button to index the rest.
  function renderStatus(status) {
    const d = lastData;
    // Rebuilding on every 400 ms poll tick would swap the "Load more" button
    // out from under a click in progress; only touch the DOM on a change.
    const sig = JSON.stringify([d.error, d.progress, d.indexing, d.phase, d.pendingMonths, d.months?.length]);
    if (status.dataset.sig === sig) return;
    status.dataset.sig = sig;
    status.replaceChildren();
    const text = (t) => status.appendChild(document.createTextNode(t));
    if (d.error) return text(`Couldn't load Actor data (${d.error}).`);
    if (d.progress) {
      const { done, total, month, monthsLeft } = d.progress;
      const which = (d.months || []).length > 1 ? `${AAPF.monthLabel(month)} ` : "";
      const more = monthsLeft > 0 ? ` (${monthsLeft} more month${monthsLeft === 1 ? "" : "s"} to go)` : "";
      return text(`Indexing ${which}Actors… ${done}/${total}${more}`);
    }
    if (d.indexing) return text(d.phase || "Indexing Actors…");
    const pending = d.pendingMonths || [];
    if (!pending.length) return;
    const months = d.months || [];
    const indexedCount = months.length - pending.length;
    // Conservative request estimate: up to 1 + 2 per active Actor, using
    // indexed months as the yardstick (20 Actors if none is).
    const counts = (d.indexedMonths || []).map((m) => monthData[m]?.actorCount).filter((n) => n > 0);
    const avg = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 20;
    const est = Math.round(pending.length * (1 + 2 * avg));
    text(`Actor breakdown covers ${indexedCount} of ${months.length} months. `);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "aap-link-btn";
    btn.textContent = `Load ${pending.length} more (~${est} requests)`;
    btn.title = "Index the per-Actor breakdown for the rest of the range. The chart's day totals are already complete.";
    btn.addEventListener("click", () => {
      indexAllFor = scopeKey();
      loadedKey = null; // force maybeLoad to start a fresh pass
      maybeLoad();
    });
    status.appendChild(btn);
  }

  // ---- KPI cards (Costs / Revenue / Profit / Margin) ---------------------------
  // The Console's four headline cards above the chart only ever show the
  // picker month. While a preset or custom range is active we swap the figure
  // in each card for the range's total (formatted the way Apify does, "$4.8K"
  // / "98.82%"), so the header agrees with the chart underneath; the hover
  // title names the range and keeps Apify's own month figure. Back on the
  // picker month the native figures are restored. The Console re-renders
  // these on its own refresh, so this runs on every poll tick and re-applies
  // only when the text differs.

  function kpiCards() {
    const out = [];
    for (const tab of document.querySelectorAll('[class*="StyledLargeTabNav"] a[role="tab"]')) {
      const label = (tab.textContent || "").trim().toLowerCase();
      const key = label.startsWith("cost") ? "cost" : label.startsWith("revenue") ? "revenue" : label.startsWith("profit") ? "profit" : label.startsWith("margin") ? "margin" : null;
      if (!key) continue;
      const value = [...tab.querySelectorAll("span")].find((el) => el.children.length === 0 && /^-?\$|%$|^–$/.test(el.textContent.trim()));
      if (value) out.push({ tab, key, value });
    }
    return out;
  }

  // "$57.10" below a thousand, "$4.8K" / "$1.2M" above — what the cards show.
  function kpiMoney(n) {
    const abs = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
    return `${sign}$${abs.toFixed(2)}`;
  }

  function rangeTotals(dayMetrics) {
    const t = { cost: 0, revenue: 0, profit: 0 };
    for (const m of Object.values(dayMetrics || {})) {
      t.cost += m.cost || 0;
      t.revenue += m.revenue || 0;
      t.profit += m.profit || 0;
    }
    return t;
  }

  function rangeTagText() {
    if (state.rangeMode === "custom" && state.customRange) return AAPF.rangeLabel(state.customRange.from, state.customRange.to);
    return RANGE_LABELS[state.rangeMode] || "";
  }

  function syncKpiCards() {
    if (state.rangeMode === "native" || !lastData?.range) return restoreKpiCards();
    const totals = rangeTotals(lastData.dayMetrics);
    const text = {
      cost: kpiMoney(totals.cost),
      revenue: kpiMoney(totals.revenue),
      profit: kpiMoney(totals.profit),
      margin: totals.revenue ? `${((totals.profit / totals.revenue) * 100).toFixed(2)}%` : "–",
    };
    const tag = rangeTagText();
    for (const { key, value } of kpiCards()) {
      const current = value.textContent.trim();
      // Anything we didn't write is Apify's own figure: remember it so it can
      // be put back (and shown in the tooltip).
      if (current !== value.dataset.aapValue) value.dataset.aapOrig = current;
      if (current !== text[key]) {
        value.textContent = text[key];
        value.dataset.aapValue = text[key];
      }
      value.title = `${tag} total. Apify's ${state.month ? AAPF.monthLabelLong(state.month) : "month"} figure: ${value.dataset.aapOrig}`;
    }
  }

  function restoreKpiCards() {
    for (const { value } of kpiCards()) {
      if (value.dataset.aapOrig != null && value.textContent.trim() === value.dataset.aapValue) {
        value.textContent = value.dataset.aapOrig;
      }
      delete value.dataset.aapOrig;
      delete value.dataset.aapValue;
      value.removeAttribute("title");
    }
  }

  // ---- highlights panel -------------------------------------------------------
  // Four small cards between the chart and the Console's Actor table, for
  // the active range: top 3 by profit, top 3 by cost, top 3 and bottom 3 by
  // success rate. Built from the per-day-per-Actor index already in memory,
  // so it costs no requests. The panel's own Hide button turns it off; the
  // popup's settings turn it back on (PREF_KEYS.highlights).
  const HIGHLIGHTS_CLASS = "aap-highlights";
  // Success-rate rankings ignore Actors with fewer runs than this in the
  // range, so a single successful run can't top the list (or one failure
  // bottom it).
  const HIGHLIGHT_MIN_RUNS = 20;
  const HIGHLIGHT_N = 3;

  // The block Apify wraps the whole chart card in — its next sibling is the
  // Actor table's card, and the parent spaces its children with a gap, so a
  // panel inserted between them inherits the page's own rhythm.
  function findHighlightsAnchor() {
    return findChartWrapper()?.closest('[class*="StyledChartWrapper"]') || null;
  }

  function ensureHighlights() {
    let panel = document.querySelector(`.${HIGHLIGHTS_CLASS}`);
    if (!highlightsOn || !onInsightsRoute()) {
      panel?.remove();
      return;
    }
    const anchor = findHighlightsAnchor();
    if (!anchor) return;
    if (!panel || panel.previousElementSibling !== anchor) {
      panel?.remove();
      panel = document.createElement("section");
      panel.className = HIGHLIGHTS_CLASS;
      panel.dataset.sig = "";
      anchor.insertAdjacentElement("afterend", panel);
    }
    renderHighlights(panel);
  }

  // Per-Actor totals over the days on screen.
  function aggregateActors(daily) {
    const totals = new Map();
    for (const rows of Object.values(daily || {})) {
      for (const r of rows) {
        const t = totals.get(r.actorId) || { actorId: r.actorId, name: r.name, revenue: 0, cost: 0, profit: 0, runs: 0, succeeded: 0, results: 0 };
        t.revenue += r.revenue || 0;
        t.cost += r.cost || 0;
        t.profit += r.profit || 0;
        t.runs += r.runs || 0;
        // Older cache records predate `succeeded`; reconstruct it from the
        // day's rate so the range rate is still runs-weighted.
        t.succeeded += r.succeeded ?? (r.successRate != null && r.runs ? r.successRate * r.runs : 0);
        t.results += r.results || 0;
        totals.set(r.actorId, t);
      }
    }
    for (const t of totals.values()) t.successRate = t.runs ? t.succeeded / t.runs : null;
    return [...totals.values()];
  }

  function computeHighlights(daily) {
    const actors = aggregateActors(daily);
    const byRuns = actors.filter((a) => a.runs >= HIGHLIGHT_MIN_RUNS && a.successRate != null);
    const top = (arr, cmp) => [...arr].sort(cmp).slice(0, HIGHLIGHT_N);
    return {
      profit: top(actors.filter((a) => a.profit !== 0), (a, b) => b.profit - a.profit),
      cost: top(actors.filter((a) => a.cost > 0), (a, b) => b.cost - a.cost),
      topSuccess: top(byRuns, (a, b) => b.successRate - a.successRate || b.runs - a.runs),
      bottomSuccess: top(byRuns, (a, b) => a.successRate - b.successRate || b.runs - a.runs),
      qualified: byRuns.length,
    };
  }

  const HIGHLIGHT_CARDS = [
    { key: "profit", title: "Top profit", value: (a) => AAPF.money(a.profit), hint: (a) => `${AAPF.money(a.revenue)} revenue` },
    { key: "cost", title: "Top cost", value: (a) => AAPF.money(a.cost), hint: (a) => `${AAPF.compact(a.runs)} runs` },
    { key: "topSuccess", title: "Best success rate", value: (a) => AAPF.pct(a.successRate), hint: (a) => `${AAPF.compact(a.runs)} runs` },
    { key: "bottomSuccess", title: "Worst success rate", value: (a) => AAPF.pct(a.successRate), hint: (a) => `${AAPF.compact(a.runs)} runs` },
  ];

  // The Actor's own Console icon; falls back to its chart colour dot for an
  // Actor without a picture (or one cached before icons were stored).
  function actorIconHtml(actorId) {
    const url = iconByActorId.get(actorId);
    if (url && /^https:\/\//.test(url)) {
      return `<img class="aap-hl-icon" src="${escapeHtml(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
    }
    return `<span class="aap-hl-icon aap-hl-icon-dot"><span class="aap-tt-dot" style="background:${colorByActorId.get(actorId) || OTHER_COLOR}"></span></span>`;
  }

  function renderHighlights(panel) {
    const d = lastData;
    const range = d?.range;
    const h = computeHighlights(d?.daily);
    const months = d?.months || [];
    const pending = d?.pendingMonths || [];
    // Only touch the DOM when something visible changed — this runs on every
    // poll tick, and rebuilding would swap the Hide button out from under a
    // click.
    const sig = JSON.stringify([range, h, !!d?.indexing, pending.length, months.length, [...colorByActorId.entries()], iconByActorId.size]);
    if (panel.dataset.sig === sig) return;
    panel.dataset.sig = sig;

    const rangeText = range ? (range.from ? AAPF.rangeLabel(range.from, range.to) : "All time") : "";
    let html = `<div class="aap-hl-head"><span class="aap-hl-title">Highlights</span><span class="aap-hl-range">${escapeHtml(rangeText)}</span>`;
    html += `<button type="button" class="aap-hl-hide" title="Hide this panel. Turn it back on in the extension's settings.">Hide</button></div>`;

    const empty = !h.profit.length && !h.cost.length && !h.topSuccess.length;
    if (empty) {
      html += `<div class="aap-hl-note">${d?.indexing ? "Indexing Actors…" : "No paid Actor activity in this range."}</div>`;
    } else {
      html += '<div class="aap-hl-grid">';
      for (const card of HIGHLIGHT_CARDS) {
        const rows = h[card.key];
        html += `<div class="aap-hl-card"><div class="aap-hl-card-title">${card.title}</div>`;
        if (!rows.length) {
          const why = card.key.endsWith("Success") ? `No Actor with ${HIGHLIGHT_MIN_RUNS}+ runs yet.` : "Nothing yet.";
          html += `<div class="aap-hl-note">${why}</div>`;
        } else {
          html += "<ol class=\"aap-hl-list\">";
          for (const a of rows) {
            html += `<li>${actorIconHtml(a.actorId)}<span class="aap-hl-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span><span class="aap-hl-value">${card.value(a)}</span><span class="aap-hl-hint">${card.hint(a)}</span></li>`;
          }
          html += "</ol>";
        }
        html += "</div>";
      }
      html += "</div>";
      if (d?.indexing) html += `<div class="aap-hl-foot">Indexing Actors… rankings will update.</div>`;
      else if (pending.length) html += `<div class="aap-hl-foot">Actor breakdown covers ${months.length - pending.length} of ${months.length} months in this range (see "Load more" in the toolbar).</div>`;
      else if (h.qualified === 0) html += `<div class="aap-hl-foot">Success-rate cards need an Actor with ${HIGHLIGHT_MIN_RUNS}+ runs.</div>`;
    }
    panel.innerHTML = html;
    panel.querySelector(".aap-hl-hide").addEventListener("click", () => {
      highlightsOn = false;
      savePref({ [PREF_KEYS.highlights]: false });
      ensureHighlights();
    });
  }

  // ---- Daily runs chart ----------------------------------------------------
  // The native Daily runs card already has a stacked status chart, but its
  // tooltip only shows account totals. Replace just that chart canvas with a
  // matching dependency-free canvas backed by the per-Actor index above. The
  // card, heading, note, and native summary figures remain untouched.
  function findDailyRunsCanvas() {
    const heading = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].find((el) => {
      const text = (el.textContent || "").trim().toLowerCase();
      return text === "number of daily runs" || text === "daily runs";
    });
    if (!heading) return null;
    // Start at the heading and stop at the first ancestor that contains a
    // native canvas. This selects the heading's own card rather than an outer
    // page section that also contains the monetization and results charts.
    for (let el = heading.parentElement; el && el !== document.body; el = el.parentElement) {
      const canvas = el.querySelector("canvas:not(.aap-chart):not(.aap-runs-chart)");
      if (canvas) return canvas;
    }
    return null;
  }

  function ensureDailyRunsOverlay() {
    if (!onInsightsRoute()) return null;
    const nativeCanvas = findDailyRunsCanvas();
    if (!nativeCanvas) return null;
    const host = nativeCanvas.parentElement;
    if (!host) return null;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    nativeCanvas.dataset.aapRunsNative = "true";
    nativeCanvas.style.visibility = "hidden";

    let overlay = host.querySelector(":scope > .aap-runs-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "aap-runs-overlay";
      const canvas = document.createElement("canvas");
      canvas.className = "aap-runs-chart";
      canvas.setAttribute("aria-label", "Daily runs by status. Hover a day for the Actor breakdown; click to pin it.");
      canvas.addEventListener("mousemove", onHover);
      canvas.addEventListener("mouseleave", () => {
        if (pinnedDay == null) hideTooltip();
      });
      canvas.addEventListener("click", onChartClick);
      overlay.appendChild(canvas);
      host.appendChild(overlay);
    }
    return overlay;
  }

  function drawDailyRunsChart() {
    const overlay = ensureDailyRunsOverlay();
    if (!overlay || !lastData) return;
    const canvas = overlay.querySelector(".aap-runs-chart");
    const rect = overlay.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const days = Object.keys(lastData.dayMetrics || {}).sort();
    canvas.__aapDays = days;
    if (!days.length) return;
    ctx.font = `13px ${getComputedStyle(overlay).fontFamily || "sans-serif"}`;
    ctx.textBaseline = "middle";

    const maxRuns = Math.max(1, ...days.map((day) => lastData.dayMetrics[day]?.runs || 0));
    const { max, ticks } = niceScale(maxRuns);
    let labelWidth = 0;
    for (let i = 0; i <= ticks; i++) labelWidth = Math.max(labelWidth, ctx.measureText(AAPF.compact(max * (i / ticks))).width);
    const leftPad = Math.ceil(labelWidth) + 16;
    const rightPad = 16;
    canvas.__aapPads = { left: leftPad, right: rightPad };
    const plotW = rect.width - leftPad - rightPad;
    const plotH = rect.height - PAD.top - PAD.bottom;
    const slot = plotW / days.length;
    const barW = slot < 6 ? Math.max(1, slot) : Math.max(4, slot * 0.62);

    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    for (let i = 0; i <= ticks; i++) {
      const frac = i / ticks;
      const y = PAD.top + plotH * (1 - frac);
      ctx.beginPath();
      ctx.moveTo(leftPad, y);
      ctx.lineTo(rect.width - rightPad, y);
      ctx.stroke();
      ctx.fillStyle = AXIS_LABEL_COLOR;
      ctx.textAlign = "right";
      ctx.fillText(AAPF.compact(max * frac), leftPad - 8, y);
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = AXIS_LABEL_COLOR;
    for (const { i, text } of xAxisLabels(days, slot, ctx)) {
      ctx.fillText(text, leftPad + i * slot + slot / 2, rect.height - PAD.bottom + 6);
    }

    const statuses = [
      ["succeeded", RUN_STATUS_COLORS.succeeded],
      ["aborted", RUN_STATUS_COLORS.aborted],
      ["failed", RUN_STATUS_COLORS.failed],
      ["timedOut", RUN_STATUS_COLORS.timedOut],
    ];
    days.forEach((day, i) => {
      const dm = lastData.dayMetrics[day] || {};
      const x = leftPad + i * slot + slot / 2;
      let y = PAD.top + plotH;
      for (const [key, color] of statuses) {
        const h = ((dm[key] || 0) / max) * plotH;
        if (h <= 0) continue;
        y -= h;
        ctx.fillStyle = color;
        ctx.fillRect(x - barW / 2, y, barW, h);
      }
    });
  }

  // ---- hover tooltip --------------------------------------------------------
  // Maps a clientX on the canvas to the day it falls in, or null outside the
  // plot area. Shared by hover (preview) and click (pin) so they agree on
  // which day the cursor is over.
  function dayAtClientX(canvas, clientX) {
    const days = canvas.__aapDays || [];
    if (!days.length) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    // Use the pads the last draw actually used (the left gutter is sized to
    // the measured y-labels there); plotPads() is only a pre-first-draw fallback.
    const { left: leftPad, right: rightPad } = canvas.__aapPads || plotPads();
    const plotW = rect.width - leftPad - rightPad;
    if (x < leftPad || x > rect.width - rightPad) return null;
    const slot = plotW / days.length;
    const idx = Math.min(days.length - 1, Math.max(0, Math.floor((x - leftPad) / slot)));
    return days[idx];
  }

  function tooltipKindForCanvas(canvas) {
    return canvas.classList.contains("aap-runs-chart") ? "runs" : "monetization";
  }

  function onHover(e) {
    if (pinnedDay != null) return; // pinned tooltip ignores hover entirely until unpinned
    if (!lastData) return hideTooltip();
    const day = dayAtClientX(e.currentTarget, e.clientX);
    if (day == null) return hideTooltip();
    showTooltip(e.clientX, e.clientY, day, tooltipKindForCanvas(e.currentTarget));
  }

  // Clicking a bar pins the tooltip in place: it stops following the mouse
  // and gains pointer-events (see .aap-tt-pinned in app.css) so the sort
  // headers are actually clickable — a pure hover tooltip can't host a click
  // target, since leaving the canvas to reach it just hides it. Clicking the
  // same day again (or the close button, or Escape, or clicking outside
  // both the chart and the tooltip — see the document-level listeners below)
  // unpins and hands control back to hover.
  function onChartClick(e) {
    if (!lastData) return;
    const day = dayAtClientX(e.currentTarget, e.clientX);
    if (day == null) return;
    const kind = tooltipKindForCanvas(e.currentTarget);
    if (pinnedDay === day && pinnedKind === kind) {
      pinnedDay = null;
      pinnedKind = null;
      showTooltip(e.clientX, e.clientY, day, kind); // resume as a normal hover preview
      return;
    }
    pinnedDay = day;
    pinnedKind = kind;
    tooltipKind = kind;
    tooltipDay = day;
    tooltipSort = { key: kind === "runs" ? "runs" : primaryMetric(), dir: "desc" };
    renderTooltip();
    positionTooltip(e.clientX, e.clientY);
  }

  document.addEventListener("click", (e) => {
    if (pinnedDay == null) return;
    const tooltip = document.querySelector(".aap-tooltip");
    const canvas = e.target instanceof Element ? e.target.closest(".aap-chart, .aap-runs-chart") : null;
    if (tooltip?.contains(e.target) || canvas) return; // handled above
    hideTooltip();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pinnedDay != null) hideTooltip();
  });

  // Columns available in the per-day actor table, in display order. `sort`
  // is the row field each header sorts by; "name" compares alphabetically,
  // everything else numerically.
  const TOOLTIP_COLUMNS = [
    { sort: "name", label: "Actor" },
    { sort: "revenue", label: "Revenue", fmt: (r) => AAPF.money(r.revenue || 0) },
    { sort: "cost", label: "Cost", fmt: (r) => AAPF.money(r.cost || 0) },
    { sort: "profit", label: "Profit", fmt: (r) => AAPF.money(r.profit || 0) },
    { sort: "runs", label: "Runs", fmt: (r) => AAPF.compact(r.runs || 0) },
    { sort: "results", label: "Results", fmt: (r) => AAPF.compact(r.results || 0) },
  ];
  const RUN_TOOLTIP_COLUMNS = [
    { sort: "name", label: "Actor" },
    { sort: "runs", label: "Total", fmt: (r) => AAPF.compact(r.runs || 0) },
    { sort: "succeeded", label: "Successful", fmt: (r) => AAPF.compact(r.succeeded || 0) },
    { sort: "aborted", label: "Aborted", fmt: (r) => AAPF.compact(r.aborted || 0) },
    { sort: "failed", label: "Failed", fmt: (r) => AAPF.compact(r.failed || 0) },
  ];

  // Which day's table is currently shown, and how its rows are ordered.
  // Reset to "by the active headline metric, descending" whenever the
  // hovered/pinned day changes; a header click overrides it for that day
  // only, so moving to a new day always starts from the metric-relevant
  // view again.
  let pinnedDay = null; // non-null while the tooltip is pinned (see onChartClick)
  let pinnedKind = null;
  let tooltipKind = "monetization";
  let tooltipDay = null;
  let tooltipSort = { key: "revenue", dir: "desc" };

  function showTooltip(clientX, clientY, day, kind = "monetization") {
    if (day !== tooltipDay || kind !== tooltipKind) {
      tooltipDay = day;
      tooltipKind = kind;
      tooltipSort = { key: kind === "runs" ? "runs" : primaryMetric(), dir: "desc" };
    }
    renderTooltip();
    positionTooltip(clientX, clientY);
  }

  function onTooltipClick(e) {
    // Any click that reaches the tooltip is fully handled right here — never
    // let it bubble to the document "click outside to unpin" listener below.
    // That matters beyond tidiness: sorting rebuilds the table via innerHTML,
    // which detaches the clicked <th>, so by the time a bubbled event reached
    // the document listener, tooltip.contains(e.target) would check a node
    // no longer in the tree and read as "clicked outside" — closing the
    // tooltip right after every sort click.
    e.stopPropagation();
    if (e.target.closest(".aap-tt-close")) return hideTooltip();
    const th = e.target.closest("th[data-sort]");
    if (!th || tooltipDay == null) return;
    const key = th.dataset.sort;
    tooltipSort =
      tooltipSort.key === key
        ? { key, dir: tooltipSort.dir === "desc" ? "asc" : "desc" }
        : { key, dir: key === "name" ? "asc" : "desc" }; // names default A→Z, numbers default high→low
    renderTooltip();
  }

  function renderTooltip() {
    const tooltip = document.querySelector(".aap-tooltip");
    const day = tooltipDay;
    if (!tooltip || day == null || !lastData) return;

    const pinned = pinnedDay === day && pinnedKind === tooltipKind;
    tooltip.classList.toggle("aap-tt-pinned", pinned);

    const dm = (lastData.dayMetrics || {})[day];
    if (tooltipKind === "runs") {
      renderRunsTooltip(tooltip, day, dm, pinned);
      return;
    }
    const metric = primaryMetric();
    const metricInfo = metricDef(metric);
    const headlineValue = BAR_METRICS[metric] ? AAPF.money(dm?.[metric] ?? 0) : AAPF.compact(dm?.[metric] ?? 0);

    // Only a pinned tooltip has pointer-events, so this affordance would be
    // misleading (and inert) on a plain hover preview.
    let html = pinned
      ? `<div class="aap-tt-pin-bar">📌 Pinned — click the bar again or press Esc to close<button type="button" class="aap-tt-close" aria-label="Close">×</button></div>`
      : "";

    // Headline metric + value up top (matching Apify's own tooltip), date
    // just below it, then our fuller day/actor breakdown underneath.
    html += `<div class="aap-tt-header">`;
    html += `<span class="aap-tt-dot" style="background:${metricInfo.color}"></span>`;
    html += `<span class="aap-tt-header-label">${metricInfo.label}</span>`;
    html += `<span class="aap-tt-header-value">${headlineValue}</span>`;
    html += "</div>";
    html += `<div class="aap-tt-date">${AAPF.longDate(day)}</div>`;
    html += '<div class="aap-tt-stats">';
    html += `<span>Revenue <b>${AAPF.money(dm?.revenue ?? 0)}</b></span>`;
    html += `<span>Costs <b>${AAPF.money(dm?.cost ?? 0)}</b></span>`;
    html += `<span>Profit <b>${AAPF.money(dm?.profit ?? 0)}</b></span>`;
    html += `<span>Margin <b>${dm?.margin != null ? AAPF.pct(dm.margin) : "–"}</b></span>`;
    html += `<span>Runs <b>${AAPF.compact(dm?.runs ?? 0)}</b></span>`;
    html += `<span>Results <b>${AAPF.compact(dm?.results ?? 0)}</b></span>`;
    html += `<span>Success <b>${dm?.successRate != null ? AAPF.pct(dm.successRate) : "–"}</b></span>`;
    html += "</div>";

    // The Actor count is always picked by the active headline metric —
    // clicking a column header only reorders that same set, it never swaps
    // which Actors are shown.
    const ranked = [...(lastData.daily?.[day] || [])].sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
    const topActors = ranked.slice(0, tooltipActorCount);

    if (topActors.length) {
      const sortDir = tooltipSort.dir === "asc" ? 1 : -1;
      const sorted = [...topActors].sort((a, b) => {
        if (tooltipSort.key === "name") return sortDir * a.name.localeCompare(b.name);
        return sortDir * ((a[tooltipSort.key] || 0) - (b[tooltipSort.key] || 0));
      });

      html += `<div class="aap-tt-subtitle">Top ${tooltipActorCount} Actors by ${metricInfo.label}</div>`;
      html += '<table class="aap-tt-table"><thead><tr>';
      for (const col of TOOLTIP_COLUMNS) {
        const isSortCol = tooltipSort.key === col.sort;
        const arrow = isSortCol ? `<span class="aap-tt-sort-arrow">${tooltipSort.dir === "asc" ? "▲" : "▼"}</span>` : "";
        html += `<th data-sort="${col.sort}" class="${isSortCol ? "aap-tt-sorted" : ""}">${col.label}${arrow}</th>`;
      }
      // pinned/unpinned only changes interactivity via CSS (.aap-tt-pinned),
      // not this markup — pointer-events:none on the unpinned tooltip makes
      // the (identical) headers inert without a second code path.
      html += "</tr></thead><tbody>";
      for (const row of sorted) {
        const color = colorByActorId.get(row.actorId) || OTHER_COLOR;
        html += `<tr><td><span class="aap-tt-dot" style="background:${color}"></span>${escapeHtml(row.name)}</td>`;
        for (const col of TOOLTIP_COLUMNS.slice(1)) html += `<td>${col.fmt(row)}</td>`;
        html += "</tr>";
      }
      html += "</tbody></table>";
    } else if ((lastData.indexedMonths || []).includes(monthOf(day))) {
      html += `<div class="aap-tt-note">No paid Actor activity this day.</div>`;
    } else if (lastData.indexing) {
      html += `<div class="aap-tt-note">Indexing Actors… ${lastData.progress ? `${lastData.progress.done}/${lastData.progress.total}` : ""}</div>`;
    } else {
      html += `<div class="aap-tt-note">Actor breakdown not loaded for this month yet, see "Load more" in the toolbar.</div>`;
    }
    tooltip.innerHTML = html;
    tooltip.style.display = "block";
  }

  function renderRunsTooltip(tooltip, day, dm, pinned) {
    let html = pinned
      ? `<div class="aap-tt-pin-bar">📌 Pinned — click the bar again or press Esc to close<button type="button" class="aap-tt-close" aria-label="Close">×</button></div>`
      : "";
    html += `<div class="aap-tt-header"><span class="aap-tt-header-label">Daily runs</span><span class="aap-tt-header-value">${AAPF.compact(dm?.runs ?? 0)}</span></div>`;
    html += `<div class="aap-tt-date">${AAPF.longDate(day)}</div>`;
    html += '<div class="aap-tt-run-stats">';
    const stats = [
      ["Total", dm?.runs ?? 0, null],
      ["Successful", dm?.succeeded ?? 0, RUN_STATUS_COLORS.succeeded],
      ["Aborted", dm?.aborted ?? 0, RUN_STATUS_COLORS.aborted],
      ["Failed", dm?.failed ?? 0, RUN_STATUS_COLORS.failed],
    ];
    if ((dm?.timedOut ?? 0) > 0) stats.push(["Timed out", dm.timedOut, RUN_STATUS_COLORS.timedOut]);
    for (const [label, value, color] of stats) {
      const dot = color ? `<span class="aap-tt-dot" style="background:${color}"></span>` : "";
      html += `<span>${dot}${label}</span><b>${AAPF.compact(value)}</b>`;
    }
    html += "</div>";

    const topActors = [...(lastData.daily?.[day] || [])]
      .filter((row) => (row.runs || 0) > 0)
      .sort((a, b) => (b.runs || 0) - (a.runs || 0))
      .slice(0, tooltipActorCount);
    if (topActors.length) {
      const sortDir = tooltipSort.dir === "asc" ? 1 : -1;
      const sorted = [...topActors].sort((a, b) => {
        if (tooltipSort.key === "name") return sortDir * a.name.localeCompare(b.name);
        return sortDir * ((a[tooltipSort.key] || 0) - (b[tooltipSort.key] || 0));
      });
      html += `<div class="aap-tt-subtitle">Top ${tooltipActorCount} Actors by total runs</div>`;
      html += '<table class="aap-tt-table aap-tt-runs-table"><thead><tr>';
      for (const col of RUN_TOOLTIP_COLUMNS) {
        const active = tooltipSort.key === col.sort;
        const arrow = active ? `<span class="aap-tt-sort-arrow">${tooltipSort.dir === "asc" ? "▲" : "▼"}</span>` : "";
        html += `<th data-sort="${col.sort}" class="${active ? "aap-tt-sorted" : ""}">${col.label}${arrow}</th>`;
      }
      html += "</tr></thead><tbody>";
      for (const row of sorted) {
        const color = colorByActorId.get(row.actorId) || OTHER_COLOR;
        html += `<tr><td><span class="aap-tt-dot" style="background:${color}"></span>${escapeHtml(row.name)}</td>`;
        for (const col of RUN_TOOLTIP_COLUMNS.slice(1)) html += `<td>${col.fmt(row)}</td>`;
        html += "</tr>";
      }
      html += "</tbody></table>";
    } else if ((lastData.indexedMonths || []).includes(monthOf(day))) {
      html += '<div class="aap-tt-note">No Actor runs this day.</div>';
    } else if (lastData.indexing) {
      html += `<div class="aap-tt-note">Indexing Actors… ${lastData.progress ? `${lastData.progress.done}/${lastData.progress.total}` : ""}</div>`;
    } else {
      html += '<div class="aap-tt-note">Actor breakdown not loaded for this month yet, see "Load more" above.</div>';
    }
    tooltip.innerHTML = html;
    tooltip.style.display = "block";
  }

  function positionTooltip(clientX, clientY) {
    const tooltip = document.querySelector(".aap-tooltip");
    if (!tooltip) return;
    const ttRect = tooltip.getBoundingClientRect();
    let left = clientX + 14;
    let top = clientY + 14;
    if (left + ttRect.width > window.innerWidth - 8) left = clientX - ttRect.width - 14;
    if (top + ttRect.height > window.innerHeight - 8) top = clientY - ttRect.height - 14;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function hideTooltip() {
    const tooltip = document.querySelector(".aap-tooltip");
    if (tooltip) {
      tooltip.style.display = "none";
      tooltip.classList.remove("aap-tt-pinned");
    }
    tooltipDay = null;
    pinnedDay = null; // any path that closes the tooltip also releases the pin
    pinnedKind = null;
  }

  // Traces `pts` as a smooth Catmull-Rom spline converted to cubic beziers —
  // unlike a midpoint-quadratic smoother, this passes exactly through every
  // point (converted to bezier tangents from each point's neighbors), so the
  // dot markers drawn at the same points always sit right on the line.
  //
  // Each segment's control-point y is clamped to its endpoints' range: a
  // bezier never leaves its control points' convex hull, so the curve can't
  // overshoot a local extreme — without this, a steep drop into a flat run of
  // zeros swings the spline below the $0 baseline (and past axis maxima).
  function drawSmoothLine(ctx, pts) {
    ctx.beginPath();
    if (pts.length < 2) return;
    ctx.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 2) {
      ctx.lineTo(pts[1].x, pts[1].y);
      return;
    }
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const yLo = Math.min(p1.y, p2.y);
      const yHi = Math.max(p1.y, p2.y);
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = clamp(p1.y + (p2.y - p0.y) / 6, yLo, yHi);
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = clamp(p2.y - (p3.y - p1.y) / 6, yLo, yHi);
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
})();
