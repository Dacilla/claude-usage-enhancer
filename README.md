# Claude Usage Enhancer

A personal Tampermonkey userscript that adds a more detailed dashboard to the Claude usage page (`claude.ai/settings/usage`).

## What it does

The script injects a widget below the existing usage bars on the Claude settings page. The widget refreshes every 60 seconds and shows:

- **Session usage** — current percentage of the active 5-hour window consumed, with an estimated number of messages remaining based on plan
- **Burn rate** — how fast the session window is being consumed (percentage per hour), derived from the last several readings over 24 hours
- **Time until session resets** — countdown to when the current 5-hour window ends
- **Peak hours indicator** — flags whether it is currently peak hours (08:00–14:00 Eastern), since Claude tends to be rate-limited more aggressively during that window
- **Daily budget with rollover** — divides the weekly usage cap into per-day allocations; any surplus from a lighter day carries forward to the next
- **Weekly burndown grid** — a row per day showing cap, used percentage, and whether you were over or under budget

There is also a dismissible banner that appears if you exceed your daily cap.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Open `claude-usage-enhancer.user.js` directly — Tampermonkey will prompt you to install it.
3. Navigate to `https://claude.ai/settings/usage`.

No build step or package manager is involved. The file is deployed as-is.

## Configuration

On first load the script tries to detect your plan from the page text. You can override it with the plan selector inside the widget. The following plans are recognised:

| Key    | Label    | Approx. messages per 5-hour window |
|--------|----------|-------------------------------------|
| free   | Free     | 9                                   |
| pro    | Pro      | 45                                  |
| max5   | Max 5x   | 225                                 |
| max20  | Max 20x  | 900                                 |
| team   | Team     | 45                                  |

You can also set a base daily budget percentage (default 14.3%, which is roughly 1/7 of the weekly cap) and override per-day caps directly in the weekly grid.

## A note on the message counts

The per-window message counts are community-reported approximations, not official figures from Anthropic. Actual limits vary depending on message length, model used, file attachments, and other factors. Treat them as rough indicators, not precise limits.

## How data is stored

All state is stored in Tampermonkey's `GM_getValue`/`GM_setValue` storage (not `localStorage`). Nothing is sent anywhere.

| Key                  | Contents                                                    |
|----------------------|-------------------------------------------------------------|
| `cue_plan`           | Selected plan key                                           |
| `cue_usage_history`  | Timestamped percentage readings for the last 24 hours       |
| `cue_daily_budget_pct` | Base daily cap percentage                                 |
| `cue_week_log`       | Per-day used/cap/rollover data for the current week         |

The week resets on Thursday at 12:00 local time, matching Claude's own weekly reset.

## Caveats

- The script scrapes the page's `[role="progressbar"]` elements and classifies them by nearby label text to distinguish the session bar from the weekly bar. This is fragile and may break if Anthropic changes the page structure.
- Peak hours (08:00–14:00 Eastern) are hardcoded based on observed behaviour, not official documentation.
- This was built for personal use and is not actively maintained as a public project.
