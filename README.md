# Apify Monetization Insights

An open-source Chrome/Chromium extension that adds richer analytics to the Apify Console Monetization insights page.

## Features

- View revenue, costs, profit, runs, results, and success rate over custom date ranges.
- Click a day to see which Actors contributed to its totals.
- Compare top profit, top cost, and Actor success rates at a glance.
- Follow native Actor filters and organization context.
- Cache analytics locally to reduce repeat API requests.
- Configure highlights and the number of Actors shown in breakdown tooltips.

## Install from source

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome or another Chromium-based browser.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose this repository's directory.
5. Open [Apify Console Monetization insights](https://console.apify.com/actors/insights/monetization).

The extension uses the authenticated Apify Console session already present in the page. It does not persist the session's authorization token or send analytics data to third parties.

## Permissions

- `storage` stores preferences and cached analytics in the browser.
- `unlimitedStorage` allows historical month caches to remain available locally.
- Access to `console.apify.com` injects the analytics interface.
- Access to `console-backend.apify.com` loads the same authenticated analytics data used by Apify Console.

## Development

There is no build step or package installation. Edit the source files directly, then reload the unpacked extension from `chrome://extensions`.

Run basic source checks with:

```sh
for f in content/*.js lib/*.js popup/*.js; do node --check "$f"; done
node -e 'JSON.parse(require("fs").readFileSync("manifest.json", "utf8"))'
```

See [AGENTS.md](AGENTS.md) for architecture, security constraints, and the manual verification checklist.

## Disclaimer

This is an independent community project. It is not affiliated with, endorsed by, or maintained by Apify Technologies s.r.o. Apify and related marks belong to their respective owners.

## License

Released into the public domain under [The Unlicense](LICENSE).
