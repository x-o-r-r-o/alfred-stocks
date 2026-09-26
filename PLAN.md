# Stocks — Plan

**Priority tier:** 3 · **Bundle ID:** `io.github.x-o-r-r-o.stocks` · **Keywords:** `stock`

## Why build it
Raycast demand this workflow replaces (downloads, 2026-09-26):

| Raycast extension | Downloads |
|---|---|
| Stock Tracker | 6,546 |
| Stock Lookup | ~2,000 |
| **Total** | **~8,500** |

**Alfred today:** 'Stock Quote' workflows from 2013–16, broken (Yahoo/Google APIs retired).

## Features (v1.0)
- [x] `stock <ticker>` price, change, day range
- [x] Watchlist with sparkline icons
- [x] Open in Stocks.app / Yahoo / TradingView
- [x] Company/ticker search (Yahoo search endpoint or the keyed provider's search), crypto (`BTC-USD`) and FX (`EURUSD=X`)
- [x] Market state (pre / open / after hours / closed), currency, exchange; ▲▼ with green/red icons
- [x] ↩ open in Yahoo Finance / Google Finance / TradingView / Stocks.app, ⌘↩ copy price, ⌥↩ add/remove, ⌃↩ move to (or add at) the top
- [x] Providers: Yahoo Finance (no key, unofficial) by default; Finnhub, Twelve Data, Alpha Vantage with the key in the Keychain (`:key`)
- [x] Cache: quotes 60 s while a session is open, 15 min when closed; background refresh with `rerun`; searches 24 h
- [x] Clear provider errors (401/403/429/5xx/malformed/empty/timeout/offline) pointing to the Workflow’s Configuration
- [x] Damaged watchlist file detected, symbols salvaged, backup kept
- [x] Keyed free plans: one request log shared by every process (Finnhub 55/min, Twelve Data 8/min and 800/day, Alpha Vantage 25/day), so searches and background refreshes never exceed the published limits; plus a back-off after a 429
- [x] Tests against fixtures captured from the real endpoints, a mock server, and an optional live smoke test

## Known limitations
- Yahoo Finance's endpoints are unofficial: they can change or start requiring a cookie/crumb at any time (the error row points to the other providers).
- Keyed free plans mostly cover US markets; other symbols show "Not available on your plan".
- Alpha Vantage's 25 requests a day go quickly: every new search costs a search and a quote.
- The request log counts only this workflow's requests; a key also used elsewhere can still hit the provider's limit (then the 429 back-off applies).
- Alfred passes the typed query to the Script Filter's bash as an argument, so a key typed after `:key` is visible in `ps` for a few milliseconds (bash then `exec`s osascript with the query in the environment). Saving the key from the clipboard avoids it.
- NYSE holidays are listed for 2026–2027 (only used by Finnhub and Alpha Vantage quotes; later years fall back to weekdays).

## Round 4 audit (post-release, 2026-09-27)
- [x] Alfred runtime (`env -i`, no LANG, spaced Alfred paths, fresh install): Script Filter and actions work; numbers and times come from NSLocale, not LANG, so they match the Mac's region
- [x] Number format: macOS-style identifiers (`de_DE`, `en_US@rg=dezzzz`) in the Workflow's Configuration were silently ignored; now accepted
- [x] Custom separators (Language & Region › Number format) and `@numbers=latn` are honoured when no locale is configured; "as of" times use NSDateFormatter (12/24-hour setting)
- [x] Script Filter `queuemode` 2 (terminate the previous run, as Alfred's own network workflows do) instead of 1 (wait, so a slow request held up the next keystroke). Every write is atomic; the `mkdir` locks and the refresh lock carry the owner's pid, so a killed run's lock is taken over at once (was: up to 3 s wait, or 30 s of "Loading…")
- [x] Actions print nothing on success (JXA `return ""` printed a newline: a possible empty notification after ↩)
- [x] v1.1: after-hours / pre-market price (Yahoo Finance, `includePrePost`), ⇧↩ copies a summary line, ★ marks search results already in the watchlist

## Ideas for v1.1
Ranked by value for effort (sources: raycast/extensions issues and changelogs for Stock Tracker and Stock Lookup, 2023–2026):
1. Several named watchlists (raycast/extensions#7200), e.g. `:list crypto`.
2. 52-week range in Large Type and Quick Look (Yahoo sends `fiftyTwoWeekHigh`/`Low` already).
3. Pence-quoted markets (`GBp`, `ZAc`, `ILA`): show "72.50p" or convert to pounds (Stock Tracker fixed the same in 2026-06).
4. "Move up / down" in the watchlist (⌃↩ only moves to the top).
5. Portfolio: holdings and day gain per row.
6. Price alerts via a background check (needs a scheduler; Alfred has none, so only on keyword use).
7. A Hotkey that shows the watchlist, and a Snippet-style `{stock:AAPL}` via an external trigger.
8. Market-cap / volume in the subtitle for search results (costs width; maybe ⌘ subtitle).

## Verify in real Alfred before release
- `:config` reveals the workflow in Alfred Preferences (AppleScript `reveal workflow`); check it lands on the workflow and the Configure button is obvious.
- ⌥↩ / ⌃↩ in the watchlist reopen Alfred on the watchlist (AppleScript `search`); the first run may ask for Automation permission.
- The background refresh survives typing (setsid) and `rerun` refreshes the rows without flicker.
- Sparkline icons refresh (a new file per refresh) and ⌘Y / ⌘L work on quote rows.
- `stocks://` opens the Stocks app on the right symbol.
- The Universal Action on selected text (e.g. "AAPL" in a web page).

## Tech
- **Stack:** JXA (`osascript -l JavaScript`) + `/usr/bin/curl` (parallel requests, config on stdin so keys never appear in `ps`) + AppKit drawing for sparklines + the Security framework for the Keychain (no `security -w KEY` on a command line).
- **Dependencies:** None. Yahoo Finance needs no key; Finnhub / Twelve Data / Alpha Vantage need a free key.
- **Provider research (2026-09):** Yahoo retired its official API in 2017 and the `v7/finance/quote` endpoint now needs a cookie + crumb (the failure that broke older workflows). The `v8/finance/chart` and `v1/finance/search` endpoints still answer without one, but return 429 to full browser user agents without cookies, so the workflow sends `Mozilla/5.0`. Finnhub (60 calls/min, US-centric, key in `X-Finnhub-Token`), Twelve Data (8 credits/min, key in `Authorization: apikey`), Alpha Vantage (25 calls/day, key only as a query parameter) are the keyed fallbacks. Adding a provider = one object in `PROVIDERS` (request builders + parsers).
- Output via Alfred Script Filter JSON; settings via Workflow Configuration (`userconfigurationconfig`).
- Secrets (API keys/tokens) in the macOS Keychain, never in `prefs.plist`.
- Target: macOS 13+ on Apple Silicon and Intel.

## Milestones
1. [x] Script filter prototype for the main keyword
2. [x] Actions + modifiers, Universal Actions / File Actions where relevant
3. [x] Workflow Configuration, icons, error states (no network / missing dependency)
4. [ ] README with screenshots, release, forum post, then Gallery submission when invited

## Release checklist (Alfred forum + Gallery)
Sources: alfred.app/submit, alfred.app/submit/styleguide, alfred.app/submit/screenshots, alfredforum.com topics 23976 and 23388.

- [x] README starts with `## Usage`; each paragraph ends "via the `kw` keyword" / "via the Universal Action"
- [ ] A clean screenshot (window only, transparent background, real-looking data, no other workflows) after each paragraph, stored in `images/`
- [x] Modifiers listed as `* <kbd>⌘</kbd><kbd>↩</kbd> Action.`; Quick Look written as <kbd>⌘</kbd><kbd>Y</kbd>
- [x] `## Setup` only for genuine manual steps (no app installs or API keys; the Gallery lists those)
- [x] Every keyword is ≥ 3 characters and configurable via `{var:keyword_*}`
- [x] Settings in Workflow Configuration; the info.plist `readme` (About This Workflow) matches README.md
- [x] Main icon ≥ 256×256 px
- [x] No self-updater; never download or install software (no pip/brew/curl of binaries); dependencies declared for Alfred to handle
- [x] Any compiled binary is Developer ID signed + notarised; never strip quarantine
- [x] No hard-coded paths; `prefs.plist` is git-ignored; secrets stay in Keychain
- [ ] AI assistance disclosed in the README (done) and the forum post
- [ ] Version bumped in `workflow.json`; `python3 tools/build.py --package`; GitHub release with the `.alfredworkflow` attached
- [ ] Forum post in "Share your Workflows" with a screenshot, keywords, and the GitHub link
