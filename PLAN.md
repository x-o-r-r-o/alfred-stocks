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
- [x] ↩ open in Yahoo Finance / Google Finance / TradingView / Stocks.app, ⌘↩ copy price, ⌥↩ add/remove, ⌃↩ move to top
- [x] Providers: Yahoo Finance (no key, unofficial) by default; Finnhub, Twelve Data, Alpha Vantage with the key in the Keychain (`:key`)
- [x] Cache: quotes 60 s while a session is open, 15 min when closed; background refresh with `rerun`; searches 24 h
- [x] Clear provider errors (401/403/429/5xx/malformed/empty/timeout/offline) pointing to the Workflow’s Configuration
- [x] Damaged watchlist file detected, symbols salvaged, backup kept
- [x] Tests against fixtures captured from the real endpoints, a mock server, and an optional live smoke test

## Tech
- **Stack:** JXA (`osascript -l JavaScript`) + `/usr/bin/curl` (parallel requests, config on stdin so keys never appear in `ps`) + AppKit drawing for sparklines.
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
