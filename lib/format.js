/* Shared money/percent/date helpers, classic script (no modules). */
(function () {
  function money(n) {
    if (n == null || Number.isNaN(n)) return "–";
    const sign = n < 0 ? "-" : "";
    return sign + "$" + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function pct(n) {
    if (n == null || Number.isNaN(n)) return "–";
    return (n * 100).toFixed(1) + "%";
  }

  function compact(n) {
    if (n == null || Number.isNaN(n)) return "–";
    const abs = Math.abs(n);
    if (abs >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (abs >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(n);
  }

  // "2026-07-08" -> "8"
  function dayOfMonth(dateStr) {
    return String(Number(dateStr.slice(8, 10)));
  }

  // "2026-07-08" -> "Jul 8" (matches Apify's own chart; hardcoded to en-US
  // so the month-then-day order doesn't flip under a day-first browser locale)
  function shortDate(dateStr) {
    const d = new Date(dateStr + "T00:00:00Z");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }

  // "2026-07-08" -> "Jul 8, 2026" (tooltips in a multi-month range)
  function longDate(dateStr) {
    const d = new Date(dateStr + "T00:00:00Z");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  }

  // "2026-07-01" / "2026-07" -> "Jul 2026"
  function monthLabel(month) {
    const d = new Date(String(month).slice(0, 7) + "-01T00:00:00Z");
    return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  }

  // "2026-07-01" -> "July 2026" (matches the Console's own month picker)
  function monthLabelLong(month) {
    const d = new Date(String(month).slice(0, 7) + "-01T00:00:00Z");
    return d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  }

  // "Aug 21 – Sep 19, 2026" / "Dec 1, 2025 – Sep 19, 2026"
  function rangeLabel(from, to) {
    if (from.slice(0, 4) === to.slice(0, 4)) return `${shortDate(from)} – ${longDate(to)}`;
    return `${longDate(from)} – ${longDate(to)}`;
  }

  self.AAPF = { money, pct, compact, dayOfMonth, shortDate, longDate, monthLabel, monthLabelLong, rangeLabel };
})();
