# AGENTS.md

## Project overview

This repository contains a dependency-free Chrome/Chromium Manifest V3 extension that augments Apify Console's Monetization insights page. It replaces the native chart with a richer date-range chart, adds per-day and per-Actor breakdowns, and stores computed results in `chrome.storage.local`.

There is no build step, package manager, or generated application bundle. The files in this repository are the extension that Chromium loads.

## Repository map

- `manifest.json` — extension metadata, permissions, icons, and script load order.
- `content/token-sniffer.js` — main-world bridge that observes Apify Console requests and passes the existing bearer token to the isolated content-script world. Treat this as security-sensitive.
- `content/app.js` — page detection, UI injection, chart rendering, date ranges, loading, and breakdown behavior.
- `content/app.css` — all injected UI styles. Keep selectors scoped with the existing `aap-` prefix.
- `lib/api.js` — bounded client for Apify's actor-analytics endpoints and concurrent request pooling.
- `lib/cache.js` — versioned, month-scoped cache and TTL policy in `chrome.storage.local`.
- `lib/format.js` — shared display and date formatting helpers.
- `popup/` — extension popup, cache controls, and user preferences.
- `icons/` — checked-in extension icons referenced by the manifest.

## Development constraints

- Keep the extension dependency-free unless a change clearly requires otherwise. Do not introduce a bundler for a small change.
- Use browser-compatible plain JavaScript. The scripts are classic scripts, not ES modules.
- Preserve the script order in `manifest.json`: formatting, API, and cache globals must exist before `content/app.js` runs.
- Preserve the isolated-world/main-world boundary. `token-sniffer.js` runs in `MAIN`; the rest of the content code runs in the extension's isolated world.
- Never log, persist, expose in DOM, or transmit the captured authorization token anywhere except the existing Apify backend request flow.
- Keep network access limited to the hosts declared in `host_permissions`. Any permission expansion must be explicitly justified in the change description.
- Respect the request-pool concurrency limit and cancellation checks. Avoid changes that multiply API calls or bypass the cache.
- Apify API month and day values are UTC-based. Do not silently convert them through local time when computing cache keys, ranges, or chart buckets.
- Existing storage keys use the `aap.` prefix. Changing or removing one requires an intentional migration or cache-version strategy.
- When cached record semantics change, bump the extension version in `manifest.json` so the cache invalidation gate runs.
- Treat Apify's page DOM and CSS as unstable. Prefer narrow selectors, defensive checks, and idempotent rendering.
- User-facing markup created from API data must remain escaped. Do not insert untrusted Actor names or other backend values directly into HTML.

## Making changes

1. Read the complete function or subsystem before editing; `content/app.js` coordinates substantial shared state.
2. Keep changes focused and follow the existing IIFE/global-helper structure.
3. Update all user-facing name references together when renaming the extension, especially `manifest.json` and `popup/popup.html`.
4. Keep comments that explain non-obvious API behavior, cache policy, browser-world boundaries, or DOM workarounds accurate.
5. Avoid unrelated formatting churn in the large content script.

## Verification

At minimum, after every change:

- Parse-check every JavaScript file with:
  `for f in content/*.js lib/*.js popup/*.js; do node --check "$f"; done`
- Validate that `manifest.json` is valid JSON.
- Search for stale names or storage prefixes when making a rename or migration.

For behavior changes, manually load the repository as an unpacked extension in a Chromium browser, then verify on `https://console.apify.com/actors/insights/monetization`:

- the page still loads without console errors;
- the custom chart appears and responds to metric and date-range controls;
- Actor filters and organization context remain scoped correctly;
- per-day tooltips and breakdowns agree with the selected range;
- cached data is reused and the popup's Clear cache action works;
- settings update the live page and survive a reload;
- reloading the extension while the Console tab is open does not cause repeated errors.

## Documentation and releases

- Keep the README, manifest description, screenshots, and extension/repository name consistent.
- Document any new permission and why it is required.
- Use semantic versioning in `manifest.json`; user-visible fixes and features require a version bump.
- Never commit real bearer tokens, account identifiers, private analytics output, browser profiles, or exported storage data.
