/*
 * MAIN-world script (runs in the page's own JS realm, before the console SPA
 * boots). The Insights page authenticates its own XHR/fetch calls to
 * console-backend.apify.com with a bearer token attached by the page's own
 * API client — there's no auth cookie on that host (a direct navigation to
 * the endpoint 401s with "token-not-provided"). We never read that token out
 * of storage ourselves; instead we watch the header the PAGE already attaches
 * to a request it was going to make anyway, and hand it to our isolated
 * content script over a CustomEvent so it can make a few *additional* calls
 * to the same first-party endpoint, for the same logged-in user, entirely
 * inside this browser. The token never leaves the page.
 */
(function () {
  const TOKEN_EVENT = "aap-token";
  const SEEN_EVENT = "aap-request-seen";
  let lastToken = null;

  function parseInfo(url) {
    try {
      const u = new URL(url, location.origin);
      if (!u.hostname.endsWith("console-backend.apify.com")) return null;
      if (!u.pathname.includes("/actor-analytics/")) return null;
      // The console sends the native Actor filter as one comma-joined
      // `actorIds` param (it used to be repeated `actorIds[]=` params —
      // still read as a fallback for older console builds).
      const joined = u.searchParams.get("actorIds") || "";
      const actorIds = joined ? joined.split(",").filter(Boolean) : u.searchParams.getAll("actorIds[]");
      return {
        path: u.pathname.replace(/^\/actor-analytics\//, ""),
        month: u.searchParams.get("month"),
        actorIds,
      };
    } catch {
      return null;
    }
  }

  function dispatchToken(token) {
    window.dispatchEvent(new CustomEvent(TOKEN_EVENT, { detail: token }));
  }

  // Only every *new* token value triggers this — most requests carry the
  // same token, so without the dedup we'd fire on every single XHR.
  function announceToken(token) {
    if (!token || token === lastToken) return;
    lastToken = token;
    dispatchToken(token);
  }

  function announceSeen(info) {
    if (info) window.dispatchEvent(new CustomEvent(SEEN_EVENT, { detail: info }));
  }

  const OrigOpen = XMLHttpRequest.prototype.open;
  const OrigSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__aptUrl = typeof url === "string" ? url : String(url);
    announceSeen(parseInfo(this.__aptUrl));
    return OrigOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (
      name &&
      name.toLowerCase() === "authorization" &&
      this.__aptUrl &&
      this.__aptUrl.includes("console-backend.apify.com")
    ) {
      announceToken(value);
    }
    return OrigSetHeader.apply(this, arguments);
  };

  const OrigFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : input && input.url;
      announceSeen(parseInfo(url));
      const headers = init && init.headers;
      if (url && headers && url.includes("console-backend.apify.com")) {
        const auth = new Headers(headers).get("authorization");
        if (auth) announceToken(auth);
      }
    } catch {
      /* never let sniffing break a real request */
    }
    return OrigFetch.apply(this, arguments);
  };

  // Isolated content script asks us to replay the last-known token (e.g. it
  // loaded after the first request already went out — very likely, since the
  // dedup above means only the FIRST request of a page load ever announces).
  // This must bypass announceToken's dedup, which would otherwise treat the
  // replay as a no-op because the value already equals lastToken.
  window.addEventListener("aap-request-token", () => {
    if (lastToken) dispatchToken(lastToken);
  });
})();
