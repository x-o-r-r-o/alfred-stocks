# Stocks — Plan

**Priority tier:** 3 · **Bundle ID:** `com.xorro.stocks`

## Why build it
Raycast demand this workflow replaces (downloads, 2026-09-26):

| Raycast extension | Downloads |
|---|---|
| Stock Tracker | 6,546 |
| **Total** | **6,546** |

**Alfred today:** 'Stock Quote' workflows from 2013–16, broken (Yahoo/Google APIs retired).

## Features (v1.0)
- [ ] `stock <ticker>` price, change, day range
- [ ] Watchlist with sparkline icons
- [ ] Open in Stocks.app / Yahoo / TradingView

## Tech
- **Stack:** zsh + JXA.
- **Dependencies:** Free quote API key (e.g. Finnhub/Alpha Vantage).
- Output via Alfred Script Filter JSON; settings via Workflow Configuration (`userconfigurationconfig`).
- Secrets (API keys/tokens) in the macOS Keychain, never in `prefs.plist`.
- Target: macOS 13+ on Apple Silicon and Intel (universal binaries for any Swift helpers).

## Milestones
1. Script filter prototype for the main keyword
2. Actions + modifiers, Universal Actions / File Actions where relevant
3. Workflow Configuration, icons, error states (no network / missing dependency)
4. README with screenshots, `build.sh` release, submit to Alfred Gallery + forum post
