# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file Tampermonkey/Greasemonkey userscript (`claude-usage-enhancer.user.js`) that injects a dashboard widget into `https://claude.ai/settings/usage*`. There is no build step, no package manager, and no test framework — the file is deployed directly by installing it in a userscript manager.

## Development workflow

- **Install/update**: Open the raw `.user.js` file in a browser with Tampermonkey installed, or drag it into the Tampermonkey dashboard to install. On subsequent edits, Tampermonkey can auto-detect updates from a local server or you reinstall manually.
- **Test live**: Navigate to `https://claude.ai/settings/usage` while the script is active.
- **No linting or test commands** — validate by manual inspection in the browser console.

## Architecture

The entire script is one IIFE with no external dependencies. All persistent state is stored via the Tampermonkey `GM_getValue`/`GM_setValue` API (not `localStorage`).

**Data flow** (runs every 60 seconds via `setInterval`):
1. `getUsagePercents()` — scrapes the page's `[role="progressbar"]` elements to read `sessionPct` (current 5h window) and `weeklyPct` (weekly cumulative).
2. `recordUsage(sessionPct)` — appends to `cue_usage_history` (last 24h, max one entry per 2 min) for burn-rate calculation.
3. `updateWeekLog(weeklyPct)` — maintains `cue_week_log`, a per-week record of `{used, cap, rollover}` per day. Daily caps are derived from a user-configurable base percentage plus rollover surplus from prior days.
4. `buildWidget(...)` — constructs the DOM for the injected widget entirely in JS (no template files). Returns the root element.
5. `inject(widget)` / `existing.replaceWith(widget)` — places or replaces the widget in the page.

**Storage keys** (all in GM storage):
- `cue_plan` — selected plan key (free/pro/max5/max20/team)
- `cue_usage_history` — `[{t: timestamp, p: pctFloat}]`
- `cue_daily_budget_pct` — user's base daily cap as a percentage (default 14.3%)
- `cue_week_log` — `{weekStart: timestamp, days: {YYYY-MM-DD: {used, cap, rollover}}}`

**Week boundary**: resets Thursday 12:00 **local time** (`getWeekStart()`).

**Peak hours**: 08:00–14:00 Eastern = 13:00–19:00 UTC (`PEAK_START_UTC`/`PEAK_END_UTC`).

**SPA navigation**: a `MutationObserver` on `document.body` watches for path changes and re-runs `start()` when navigating back to `/settings/usage`.

## Key constraints

- `sessionPct` and `weeklyPct` are scraped from different progressbar elements. The classifier in `nearbyText()` uses sibling/cousin text to tell them apart — fragile against Claude UI changes.
- The `PLAN_INFO` message counts are community-estimated approximations, not official values.
- Rollover arithmetic lives in `recomputeRollovers()` — called after a manual cap override to cascade changes forward through the week.
