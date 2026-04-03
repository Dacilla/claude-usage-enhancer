// ==UserScript==
// @name         Claude Usage Enhancer
// @namespace    https://claude.ai/
// @version      2.8
// @description  Adds daily allocation view, reset countdowns, burn rate, daily % budget with rollover, and weekly burndown to the Claude usage page.
// @author       Dacilla
// @match        https://claude.ai/settings/usage*
// @updateURL    https://raw.githubusercontent.com/Dacilla/claude-usage-enhancer/main/claude-usage-enhancer.user.js
// @downloadURL  https://raw.githubusercontent.com/Dacilla/claude-usage-enhancer/main/claude-usage-enhancer.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─── Plan data ───────────────────────────────────────────────────────────────
  // Approximate messages per 5-hour window (community-reported; varies with
  // conversation length, model, and attachments — treat as rough indicators).

  const PLAN_INFO = {
    free:  { label: 'Free',    windowMsgs: 9   },
    pro:   { label: 'Pro',     windowMsgs: 45  },
    max5:  { label: 'Max 5×',  windowMsgs: 225 },
    max20: { label: 'Max 20×', windowMsgs: 900 },
    team:  { label: 'Team',    windowMsgs: 45  },
  };

  const WINDOW_HOURS    = 5;
  const WINDOWS_PER_DAY = 24 / WINDOW_HOURS; // 4.8

  // Peak hours: 8 AM – 2 PM Eastern = 13:00–19:00 UTC
  const PEAK_START_UTC = 13;
  const PEAK_END_UTC   = 19;

  // Week resets Thursday 12:00 local time
  const WEEK_RESET_DOW  = 4;   // 0=Sun … 4=Thu
  const WEEK_RESET_HOUR = 12;
  const WEEK_RESET_MIN  = 0;

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // ─── Storage keys ─────────────────────────────────────────────────────────────

  const KEY_PLAN         = 'cue_plan';
  const KEY_HISTORY      = 'cue_usage_history';   // [{t, p}]  — last 24 h of readings
  const KEY_DAILY_BUDGET = 'cue_daily_budget_pct'; // number: user's base daily cap %
  const KEY_WEEK_LOG     = 'cue_week_log';         // {weekStart, days:{date:{used,cap}}}
  const KEY_SESSION_START = 'cue_session_start';   // timestamp: when current 5h session began

  // ─── Colour palettes (resolved per-render based on page theme) ────────────────

  const DARK_PALETTE = {
    bg:      '#1a1a2e',
    card:    '#16213e',
    border:  '#0f3460',
    accent:  '#e94560',
    muted:   '#8892a4',
    text:    '#e8eaf0',
    good:    '#4caf82',
    warn:    '#f5a623',
    bad:     '#e94560',
    peak:    'rgba(245,166,35,0.12)',
    offpeak: 'rgba(76,175,130,0.08)',
  };

  const LIGHT_PALETTE = {
    bg:      '#f5f7fa',
    card:    '#ffffff',
    border:  '#e1e4eb',
    accent:  '#c0392b',
    muted:   '#667085',
    text:    '#101828',
    good:    '#027a48',
    warn:    '#b54708',
    bad:     '#b42318',
    peak:    'rgba(180,71,8,0.08)',
    offpeak: 'rgba(2,122,72,0.06)',
  };

  // ─── Module-level state ───────────────────────────────────────────────────────

  let _closePopoversHandler = null; // document click listener ref — prevents accumulation
  let _lastRefreshed        = null; // timestamp of last successful refresh
  let _startPending         = false; // guard against concurrent start() calls

  // ─── Utility ──────────────────────────────────────────────────────────────────

  function pad(n) { return String(n).padStart(2, '0'); }

  function formatDuration(ms) {
    if (ms <= 0) return '0m';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    if (h > 0) return `${h}h ${pad(m)}m`;
    if (m > 0) return `${m}m ${pad(s)}s`;
    return `${s}s`;
  }

  function formatTime(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatDateShort(date) {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  // ─── Week boundary ────────────────────────────────────────────────────────────
  // Returns the timestamp of the most recent Thursday 12:00 local.

  function getWeekStart() {
    const now = new Date();
    const d = new Date(now);
    while (d.getDay() !== WEEK_RESET_DOW) {
      d.setDate(d.getDate() - 1);
    }
    d.setHours(WEEK_RESET_HOUR, WEEK_RESET_MIN, 0, 0);
    if (d > now) d.setDate(d.getDate() - 7);
    return d.getTime();
  }

  function getNextWeekStart() {
    return getWeekStart() + 7 * 86400000;
  }

  function isoDate(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // ─── Peak helpers ─────────────────────────────────────────────────────────────

  function isPeakNow() {
    const h = new Date().getUTCHours();
    return h >= PEAK_START_UTC && h < PEAK_END_UTC;
  }

  function msUntilPeakTransition() {
    const now = new Date();
    const totalMin = now.getUTCHours() * 60 + now.getUTCMinutes() + now.getUTCSeconds() / 60;
    const peakS = PEAK_START_UTC * 60;
    const peakE = PEAK_END_UTC   * 60;
    let targetMin;
    if (totalMin < peakS)      targetMin = peakS;
    else if (totalMin < peakE) targetMin = peakE;
    else                       targetMin = peakS + 1440;
    return (targetMin - totalMin) * 60000;
  }

  // ─── Page scraping ────────────────────────────────────────────────────────────

  // Extract the numeric % from a single progressbar element.
  function readBar(el) {
    if (!el) return null;
    const v = parseFloat(el.getAttribute('aria-valuenow'));
    const m = parseFloat(el.getAttribute('aria-valuemax') || '100');
    if (!isNaN(v)) return Math.min(100, (v / m) * 100);
    if (el.tagName === 'PROGRESS' && el.value !== undefined)
      return Math.min(100, (el.value / (el.max || 1)) * 100);
    const fill = el.querySelector('[style*="width"]');
    if (fill) {
      const w = parseFloat(fill.style.width);
      if (!isNaN(w) && w >= 0 && w <= 100) return w;
    }
    return null;
  }

  // Walk up from el, stopping at maxLevels, collecting the text of all
  // elements at each level that are NOT ancestors of el (i.e. siblings and
  // their descendants). This gives us the "nearby" label text without
  // accidentally pulling in the whole page.
  function nearbyText(el, maxLevels) {
    const parts = [];
    let node = el.parentElement;
    for (let i = 0; i < maxLevels && node && node !== document.body; i++, node = node.parentElement) {
      for (const child of node.children) {
        if (!child.contains(el)) {
          parts.push(child.innerText || child.textContent || '');
        }
      }
    }
    return parts.join(' ').toLowerCase();
  }

  // Returns { sessionPct, weeklyPct } — either may be null if not found.
  // Strategy: classify each progressbar by the text found in its immediate
  // neighbourhood (siblings/cousins up to 4 levels), which is narrow enough
  // to avoid cross-contamination between the two sections.
  function getUsagePercents() {
    const bars = Array.from(document.querySelectorAll('[role="progressbar"]'));
    let sessionPct = null;
    let weeklyPct  = null;

    for (const bar of bars) {
      const pct = readBar(bar);
      if (pct === null) continue;

      const nearby = nearbyText(bar, 4);

      if (nearby.includes('current session') || nearby.includes('resets in')) {
        // "Resets in X hr" is unique to the session row.
        if (sessionPct === null) sessionPct = pct;
      } else if (nearby.includes('all models') || nearby.includes('resets thu') || nearby.includes('weekly')) {
        // "Resets Thu" and "All models" are unique to the weekly row.
        if (weeklyPct === null) weeklyPct = pct;
      } else if (nearby.includes('extra usage') || nearby.includes('spent') || nearby.includes('spending cap')) {
        // Skip extra usage section progressbars (e.g., "$19.57 spent", "A$20 monthly spend limit").
        continue;
      } else {
        // Fallback: first unclassified bar → session, second → weekly.
        if (sessionPct === null) sessionPct = pct;
        else if (weeklyPct === null) weeklyPct = pct;
      }
    }

    return { sessionPct, weeklyPct };
  }

  function detectPlanFromPage() {
    // Try specific low-level text elements first to avoid false positives
    // (e.g. "pro" appearing in unrelated words like "improve")
    const candidates = document.querySelectorAll('[class*="text-text-"]');
    for (const el of candidates) {
      const t = (el.textContent || '').toLowerCase().trim();
      if (t === 'max 20× plan' || t === 'max20 plan') return 'max20';
      if (t === 'max 5× plan'  || t === 'max5 plan')  return 'max5';
      if (t === 'team plan')   return 'team';
      if (t === 'pro plan')    return 'pro';
      if (t === 'free plan')   return 'free';
    }
    // Fallback: whole-body scan
    const t = document.body.innerText.toLowerCase();
    if (t.includes('max 20') || t.includes('max20')) return 'max20';
    if (t.includes('max 5')  || t.includes('max5'))  return 'max5';
    if (t.includes('team plan')) return 'team';
    if (t.includes('pro plan'))  return 'pro';
    return null;
  }

  // ─── Usage history (burn-rate tracking) ──────────────────────────────────────

  function loadHistory() {
    try { return JSON.parse(GM_getValue(KEY_HISTORY, '[]')); }
    catch { return []; }
  }

  function saveHistory(history) {
    const cutoff = Date.now() - 86400000;
    GM_setValue(KEY_HISTORY, JSON.stringify(history.filter(e => e.t > cutoff)));
  }

  function recordUsage(pct) {
    if (pct === null) return;
    const history = loadHistory();
    const now = Date.now();
    const last = history[history.length - 1];

    // Detect session boundary: if current pct is significantly lower than recent pct,
    // a new 5h session has started.
    if (last && last.p > 20 && pct < 10) {
      GM_setValue(KEY_SESSION_START, now);
    }

    if (last && now - last.t < 120000) { last.p = pct; last.t = now; }
    else history.push({ t: now, p: pct });
    saveHistory(history);
  }

  // Extract session remaining time from "Resets in X min/hr" text on the page
  function extractSessionRemainingMs() {
    const bars = Array.from(document.querySelectorAll('[role="progressbar"]'));
    for (const bar of bars) {
      const nearby = nearbyText(bar, 4);
      if (nearby.includes('current session') || nearby.includes('resets in')) {
        // Found the session bar; extract "Resets in X hr Y min" or "Resets in X min/hr" from nearby text
        let totalMs = 0;

        // Match hours (e.g., "3 hr")
        const hrMatch = nearby.match(/resets in.*?(\d+)\s*hr/i);
        if (hrMatch) {
          totalMs += parseInt(hrMatch[1], 10) * 60 * 60 * 1000;
        }

        // Match minutes (e.g., "31 min")
        const minMatch = nearby.match(/(\d+)\s*min/i);
        if (minMatch) {
          totalMs += parseInt(minMatch[1], 10) * 60 * 1000;
        }

        // If we found at least one unit, return the total
        if (totalMs > 0) {
          return totalMs;
        }
      }
    }
    return null;
  }

  function getSessionStart() {
    const val = GM_getValue(KEY_SESSION_START, null);
    if (val) return parseInt(val, 10);

    // Fallback: calculate from "Resets in X min" text on the page
    const remainingMs = extractSessionRemainingMs();
    if (remainingMs !== null) {
      const SESSION_DURATION = 5 * 60 * 60 * 1000;
      return Date.now() - (SESSION_DURATION - remainingMs);
    }

    return null;
  }

  function estimateBurnRate(history) {
    if (history.length < 2) return null;
    const recent = history.slice(-12);
    const first = recent[0], last = recent[recent.length - 1];
    const dp = last.p - first.p;
    const dh = (last.t - first.t) / 3600000;
    if (dh < 0.03 || dp <= 0) return null;
    return dp / dh;
  }

  // ─── Weekly budget & rollover ─────────────────────────────────────────────────

  function loadWeekLog() {
    try { return JSON.parse(GM_getValue(KEY_WEEK_LOG, 'null')); }
    catch { return null; }
  }

  function saveWeekLog(log) {
    GM_setValue(KEY_WEEK_LOG, JSON.stringify(log));
  }

  function getDailyBaseCap() {
    const v = parseFloat(GM_getValue(KEY_DAILY_BUDGET, '14.3'));
    return isNaN(v) ? 14.3 : v;
  }

  // Returns the weekly-cumulative value stored at the end of the most recent
  // past day that has data (used to derive today's daily delta).
  function getPrevWeeklyAtEnd(log, todayKey) {
    const pastKeys = Object.keys(log.days).filter(k => k < todayKey).sort();
    for (let i = pastKeys.length - 1; i >= 0; i--) {
      const e = log.days[pastKeys[i]];
      if (e.weeklyAtEnd != null) return e.weeklyAtEnd;
    }
    return 0;
  }

  function computeRollover(log, todayKey) {
    let rollover = 0;
    for (const [key, entry] of Object.entries(log.days)) {
      if (key >= todayKey) continue;
      const surplus = entry.cap - (entry.used || 0);
      if (surplus > 0) rollover += surplus;
    }
    return rollover;
  }

  function ensureTodayEntry(log, baseCap, todayKey) {
    if (!log.days[todayKey]) {
      const rollover = computeRollover(log, todayKey);
      const effectiveCap = Math.min(100, baseCap + rollover);
      log.days[todayKey] = { used: 0, cap: effectiveCap, rollover };
    }
    return log.days[todayKey];
  }

  // weeklyPct is the weekly bar (0–100); used for budget tracking.
  function updateWeekLog(weeklyPct) {
    const weekStart = getWeekStart();
    const todayKey  = isoDate(new Date());
    const baseCap   = getDailyBaseCap();

    let log = loadWeekLog();
    if (!log || log.weekStart !== weekStart) {
      log = { weekStart, days: {} };
    }

    ensureTodayEntry(log, baseCap, todayKey);

    if (weeklyPct !== null) {
      // Store the weekly-cumulative snapshot so tomorrow can derive its delta.
      log.days[todayKey].weeklyAtEnd = weeklyPct;
      // Daily consumption = how much the weekly bar moved since yesterday's close.
      const prevWeeklyAtEnd = getPrevWeeklyAtEnd(log, todayKey);
      const todayDelta = Math.max(0, weeklyPct - prevWeeklyAtEnd);
      const existing = log.days[todayKey].used || 0;
      log.days[todayKey].used = Math.max(existing, todayDelta);
    }

    saveWeekLog(log);
    return log;
  }

  // After a manual override, recompute caps for all days that come after
  // changedKey, since their rollover depends on prior days' surplus.
  // We walk the 7-day window in order, recalculating each day's cap from scratch.
  function recomputeRollovers(log, baseCap) {
    // Collect all day keys in the week, sorted chronologically
    const weekStart = log.weekStart;
    const allKeys = [];
    const d = new Date(weekStart);
    for (let i = 0; i < 7; i++) {
      const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      allKeys.push(k);
      d.setDate(d.getDate() + 1);
    }

    let runningRollover = 0;
    for (const key of allKeys) {
      const entry = log.days[key];
      if (!entry) continue; // no data for this day — carry rollover forward unchanged
      entry.cap = Math.min(100, baseCap + runningRollover);
      entry.rollover = runningRollover;
      const surplus = entry.cap - (entry.used || 0);
      runningRollover = surplus > 0 ? runningRollover + surplus : 0;
      // Cap rollover so it can't exceed 100% total
      runningRollover = Math.min(runningRollover, 100 - baseCap);
    }
  }

  function buildWeekGrid(log, baseCap, todayKey) {
    const grid = [];
    const d = new Date(log.weekStart);
    for (let i = 0; i < 7; i++) {
      const key = isoDate(d);
      const entry = log.days[key] || null;
      grid.push({
        key,
        date:      new Date(d),
        dow:       DAYS[d.getDay()],
        cap:       entry ? entry.cap : baseCap,
        used:      entry ? (entry.used || 0) : null,
        isPast:    key < todayKey,
        isToday:   key === todayKey,
        isFuture:  key > todayKey,
        isWeekend: d.getDay() === 0 || d.getDay() === 6,
      });
      d.setDate(d.getDate() + 1);
    }
    return grid;
  }

  // ─── Warning banner ───────────────────────────────────────────────────────────

  const BANNER_ID = 'cue-budget-banner';

  function showBudgetWarning(usedPct, capPct, rollover) {
    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = BANNER_ID;
      banner.style.cssText = `
        position:fixed;top:0;left:0;right:0;z-index:99999;
        background:#7c3a00;color:#ffe0b2;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        font-size:13px;padding:10px 20px;
        display:flex;align-items:center;justify-content:space-between;
        border-bottom:2px solid #f5a623;
      `;
      document.body.prepend(banner);
    }
    const rolloverStr = rollover > 0 ? ` (includes ${rollover.toFixed(1)}% rolled over)` : '';
    banner.innerHTML = `
      <span>
        <strong>Daily budget exceeded:</strong>
        used ${usedPct.toFixed(1)}% — today's cap is ${capPct.toFixed(1)}%${rolloverStr}.
        You can keep going, but this reduces tomorrow's allocation.
      </span>
      <button onclick="this.parentElement.remove()" style="
        background:none;border:1px solid #f5a623;color:#ffe0b2;
        border-radius:4px;padding:3px 10px;cursor:pointer;font-size:12px;margin-left:16px;
      ">Dismiss</button>
    `;
  }

  function removeBudgetWarning() {
    document.getElementById(BANNER_ID)?.remove();
  }

  // ─── Widget ───────────────────────────────────────────────────────────────────

  const WIDGET_ID = 'cue-widget';

  // sessionPct: current 5h window usage (for live cards + burn rate)
  // weeklyPct:  weekly cumulative usage (for budget / rollover system)
  function buildWidget(plan, sessionPct, weeklyPct, history, weekLog) {
    const isDark = document.documentElement.getAttribute('data-mode') !== 'light';
    const C      = isDark ? DARK_PALETTE : LIGHT_PALETTE;

    const planData   = PLAN_INFO[plan] || PLAN_INFO.pro;
    const burnRate   = estimateBurnRate(history);
    const peak       = isPeakNow();
    const msTilTrans = msUntilPeakTransition();
    const remaining  = sessionPct !== null ? Math.max(0, 100 - sessionPct) : null;
    const msgsPerWin = planData.windowMsgs;
    const msgsTotal  = Math.round(msgsPerWin * WINDOWS_PER_DAY);
    const msgsLeft   = remaining !== null ? Math.round((remaining / 100) * msgsTotal) : null;
    const hoursLeft  = (burnRate && burnRate > 0 && remaining !== null) ? remaining / burnRate : null;
    // Session time remaining: 5 hours - elapsed time since session start
    const sessionStart = getSessionStart();
    const SESSION_DURATION = 5 * 60 * 60 * 1000; // 5 hours in ms
    const sessionMsRemaining = (sessionStart !== null) ? Math.max(0, SESSION_DURATION - (Date.now() - sessionStart)) : null;
    const baseCap    = getDailyBaseCap();
    const todayKey   = isoDate(new Date());
    const todayEntry = weekLog?.days?.[todayKey] || null;
    const todayCap   = todayEntry?.cap ?? baseCap;
    const todayUsed  = todayEntry?.used ?? 0;
    const rollover   = todayEntry?.rollover ?? 0;
    // Daily delta: how much the weekly bar moved since yesterday's close.
    const prevWeeklyAtEnd  = weekLog ? getPrevWeeklyAtEnd(weekLog, todayKey) : 0;
    const todayDeltaLive   = weeklyPct !== null ? Math.max(0, weeklyPct - prevWeeklyAtEnd) : null;
    const overBudget = todayDeltaLive !== null && todayDeltaLive > todayCap;
    const weekGrid   = weekLog ? buildWeekGrid(weekLog, baseCap, todayKey) : [];
    const msUntilWeekReset = getNextWeekStart() - Date.now();

    // 5-hour window blocks
    const now = new Date();
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
    const windowBlocks = Array.from({ length: 5 }, (_, i) => {
      const start = new Date(startOfDay.getTime() + i * WINDOW_HOURS * 3600000);
      const end   = new Date(start.getTime() + WINDOW_HOURS * 3600000);
      const su    = start.getUTCHours();
      const isPk  = (su >= PEAK_START_UTC && su < PEAK_END_UTC) ||
                    (su + WINDOW_HOURS > PEAK_START_UTC && su < PEAK_END_UTC);
      return { start, end, isPeak: isPk, isCurrent: now >= start && now < end };
    });

    // ── Styles ──
    const styleId = 'cue-styles';
    document.getElementById(styleId)?.remove();
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      #${WIDGET_ID} {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: ${C.card};
        border: 1px solid ${overBudget ? C.warn : C.border};
        border-radius: 12px;
        padding: 20px 24px;
        margin: 24px 0;
        color: ${C.text};
        max-width: 720px;
        box-shadow: ${overBudget ? `0 0 0 1px ${C.warn}` : 'none'};
      }
      #${WIDGET_ID} h2 {
        margin: 0 0 4px;
        font-size: 14px; font-weight: 600;
        letter-spacing: 0.08em; text-transform: uppercase; color: ${C.muted};
      }
      #${WIDGET_ID} .cue-section-title {
        font-size: 11px; color: ${C.muted};
        text-transform: uppercase; letter-spacing: 0.06em; margin: 18px 0 8px;
      }
      #${WIDGET_ID} .cue-grid {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 10px;
      }
      #${WIDGET_ID} .cue-card {
        background: ${C.bg}; border: 1px solid ${C.border}; border-radius: 8px; padding: 11px 13px;
      }
      #${WIDGET_ID} .cue-card .lbl {
        font-size: 10px; color: ${C.muted}; text-transform: uppercase;
        letter-spacing: 0.06em; margin-bottom: 3px;
      }
      #${WIDGET_ID} .cue-card .val { font-size: 20px; font-weight: 700; line-height: 1.1; }
      #${WIDGET_ID} .cue-card .sub { font-size: 10px; color: ${C.muted}; margin-top: 3px; }
      #${WIDGET_ID} .cue-bar-wrap {
        background: ${C.bg}; border-radius: 4px; height: 5px; overflow: hidden; margin-top: 7px;
      }
      #${WIDGET_ID} .cue-bar-fill { height: 100%; border-radius: 4px; transition: width 0.5s ease; }
      #${WIDGET_ID} .cue-budget-row { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
      #${WIDGET_ID} .cue-budget-label { font-size: 11px; color: ${C.muted}; min-width: 38px; }
      #${WIDGET_ID} .cue-budget-track {
        flex: 1; background: rgba(255,255,255,0.06); border-radius: 4px; height: 10px; position: relative; overflow: hidden;
      }
      #${WIDGET_ID} .cue-budget-fill { height: 100%; position: absolute; top: 0; left: 0; border-radius: 4px; transition: width 0.4s ease; }
      #${WIDGET_ID} .cue-budget-over { height: 100%; position: absolute; top: 0; border-radius: 0 4px 4px 0; }
      #${WIDGET_ID} .cue-budget-cap-line {
        position: absolute; top: 0; bottom: 0; width: 2px; background: ${C.warn}; opacity: 0.8;
      }
      #${WIDGET_ID} .cue-budget-value { font-size: 11px; color: ${C.text}; min-width: 64px; text-align: right; }
      #${WIDGET_ID} .cue-week-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; }
      #${WIDGET_ID} .cue-day-cell {
        background: ${C.bg}; border: 1px solid ${C.border}; border-radius: 6px;
        padding: 8px 4px 6px; text-align: center; font-size: 11px; position: relative;
      }
      #${WIDGET_ID} .cue-day-cell.today { border-color: ${C.accent}; box-shadow: 0 0 0 1px ${C.accent}; }
      #${WIDGET_ID} .cue-day-cell.weekend { background: ${C.offpeak}; }
      #${WIDGET_ID} .cue-day-cell.editable { cursor: pointer; }
      #${WIDGET_ID} .cue-day-cell.editable:hover { border-color: ${C.muted}; }
      #${WIDGET_ID} .cue-day-cell .day-dow { color: ${C.muted}; margin-bottom: 3px; letter-spacing: 0.04em; }
      #${WIDGET_ID} .cue-day-cell .edit-hint {
        font-size: 8px; color: ${C.muted}; margin-top: 2px; opacity: 0; transition: opacity 0.15s;
      }
      #${WIDGET_ID} .cue-day-cell.editable:hover .edit-hint { opacity: 1; }
      #${WIDGET_ID} .cue-day-popover {
        position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
        background: ${C.card}; border: 1px solid ${C.border}; border-radius: 8px;
        padding: 10px 12px; z-index: 1000; min-width: 150px; box-shadow: 0 4px 16px rgba(0,0,0,0.4);
        text-align: left;
      }
      #${WIDGET_ID} .cue-day-popover label { display: block; font-size: 10px; color: ${C.muted}; margin-bottom: 5px; }
      #${WIDGET_ID} .cue-day-popover .pop-row { display: flex; gap: 5px; align-items: center; }
      #${WIDGET_ID} .cue-day-popover input[type=number] {
        flex: 1; background: ${C.bg}; color: ${C.text}; border: 1px solid ${C.border};
        border-radius: 5px; padding: 4px 6px; font-size: 12px; width: 60px;
      }
      #${WIDGET_ID} .cue-day-popover .pop-save {
        background: ${C.accent}; color: white; border: none; border-radius: 5px;
        padding: 4px 8px; font-size: 11px; cursor: pointer;
      }
      #${WIDGET_ID} .cue-day-popover .pop-clear {
        background: none; color: ${C.muted}; border: 1px solid ${C.border}; border-radius: 5px;
        padding: 4px 6px; font-size: 11px; cursor: pointer; margin-top: 5px; width: 100%;
      }
      #${WIDGET_ID} .cue-day-popover .pop-manual-tag {
        font-size: 9px; color: ${C.warn}; margin-top: 4px;
      }
      #${WIDGET_ID} .day-bar-wrap {
        background: rgba(255,255,255,0.05); border-radius: 3px;
        height: 36px; margin: 4px 0; position: relative; display: flex; align-items: flex-end;
      }
      #${WIDGET_ID} .day-bar-cap {
        position: absolute; left: 0; right: 0; height: 2px; background: ${C.warn}; opacity: 0.5;
      }
      #${WIDGET_ID} .day-bar-used { width: 100%; border-radius: 3px; transition: height 0.4s ease; }
      #${WIDGET_ID} .cue-blocks { display: flex; gap: 4px; }
      #${WIDGET_ID} .cue-block {
        flex: 1; border-radius: 6px; padding: 7px 4px; font-size: 9px; text-align: center;
        border: 1px solid ${C.border};
      }
      #${WIDGET_ID} .cue-block.peak    { background: ${C.peak};    border-color: rgba(245,166,35,0.3); }
      #${WIDGET_ID} .cue-block.offpeak { background: ${C.offpeak}; border-color: rgba(76,175,130,0.2); }
      #${WIDGET_ID} .cue-block.current { border-color: ${C.accent}; box-shadow: 0 0 0 1px ${C.accent}; }
      #${WIDGET_ID} .bk-time { color: ${C.muted}; margin-bottom: 3px; line-height: 1.4; }
      #${WIDGET_ID} .bk-badge { font-size: 8px; padding: 1px 3px; border-radius: 3px; display: inline-block; }
      #${WIDGET_ID} .cue-block.peak    .bk-badge { background: rgba(245,166,35,0.2); color: ${C.warn}; }
      #${WIDGET_ID} .cue-block.offpeak .bk-badge { background: rgba(76,175,130,0.2); color: ${C.good}; }
      #${WIDGET_ID} .now-dot {
        width: 5px; height: 5px; background: ${C.accent}; border-radius: 50%;
        display: inline-block; margin-bottom: 2px;
      }
      #${WIDGET_ID} .cue-footer {
        font-size: 11px; color: ${C.muted}; border-top: 1px solid ${C.border};
        padding-top: 12px; margin-top: 18px; display: flex; gap: 14px; flex-wrap: wrap; align-items: center;
      }
      #${WIDGET_ID} .cue-dot {
        display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 3px; vertical-align: middle;
      }
      #${WIDGET_ID} .cue-controls { margin-left: auto; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      #${WIDGET_ID} .cue-controls label { font-size: 11px; }
      #${WIDGET_ID} select, #${WIDGET_ID} input[type=number] {
        background: ${C.bg}; color: ${C.text}; border: 1px solid ${C.border};
        border-radius: 5px; padding: 3px 6px; font-size: 11px; cursor: pointer;
      }
      #${WIDGET_ID} input[type=number] { width: 52px; }
    `;
    document.head.appendChild(style);

    // ── Build DOM ────────────────────────────────────────────────────────────────

    const widget = document.createElement('div');
    widget.id = WIDGET_ID;

    // Title bar
    const titleBar = document.createElement('div');
    titleBar.style.cssText = 'display:flex;align-items:baseline;justify-content:space-between;margin-bottom:16px';
    titleBar.innerHTML = `<h2 style="margin:0">Usage Dashboard</h2>${
      overBudget ? `<span style="font-size:11px;color:${C.warn};font-weight:600;letter-spacing:0.04em">BUDGET EXCEEDED</span>` : ''
    }`;
    widget.appendChild(titleBar);

    // ── Section 1: Live stats ────────────────────────────────────────────────────
    const sessionColor = sessionPct === null ? C.muted : sessionPct < 50 ? C.good : sessionPct < 80 ? C.warn : C.bad;
    const weeklyColor  = weeklyPct  === null ? C.muted : weeklyPct  < 50 ? C.good : weeklyPct  < 80 ? C.warn : C.bad;

    const s1 = document.createElement('div');
    s1.className = 'cue-section-title';
    s1.textContent = 'Live window';
    widget.appendChild(s1);

    if (sessionPct === null && weeklyPct === null) {
      const notice = document.createElement('div');
      notice.style.cssText = `font-size:12px;color:${C.muted};padding:10px 0 6px;font-style:italic`;
      notice.textContent = 'Waiting for page data — make sure the usage bars are visible on this page.';
      widget.appendChild(notice);
    }

    const grid = document.createElement('div');
    grid.className = 'cue-grid';

    const cards = [
      { lbl: 'Session usage',  val: sessionPct !== null ? `${Math.round(sessionPct)}%` : '—', sub: 'current 5h window',  color: sessionColor, bar: sessionPct, barColor: sessionColor },
      { lbl: 'Session ends in', val: sessionMsRemaining !== null ? formatDuration(sessionMsRemaining) : '—', sub: sessionMsRemaining !== null ? 'until 5h window resets' : 'waiting for data', color: C.text },
      { lbl: 'Weekly usage',   val: weeklyPct  !== null ? `${Math.round(weeklyPct)}%`  : '—', sub: 'of weekly limit',    color: weeklyColor,  bar: weeklyPct,  barColor: weeklyColor  },
      { lbl: 'Est. msgs left', val: msgsLeft !== null ? `~${msgsLeft}` : '—',                 sub: `of ~${msgsTotal} this window`, color: C.text },
      { lbl: 'Burn rate',      val: burnRate ? `${burnRate.toFixed(1)}%/h` : '—',             sub: burnRate ? 'recent sessions' : 'need more data', color: C.text },
      { lbl: hoursLeft !== null ? 'Depletes in' : 'Window left',
        val: hoursLeft !== null ? formatDuration(hoursLeft * 3600000) : '—',
        sub: hoursLeft !== null ? 'at current rate' : 'insufficient data', color: C.text },
      { lbl: peak ? 'Peak ends in' : 'Peak starts in',
        val: formatDuration(msTilTrans),
        sub: peak ? 'then extended limits' : 'extended limits now', color: peak ? C.warn : C.good },
    ];

    for (const c of cards) {
      const card = document.createElement('div');
      card.className = 'cue-card';
      card.innerHTML = `
        <div class="lbl">${c.lbl}</div>
        <div class="val" style="color:${c.color}">${c.val}</div>
        <div class="sub">${c.sub}</div>
        ${c.bar != null ? `<div class="cue-bar-wrap"><div class="cue-bar-fill" style="width:${c.bar}%;background:${c.barColor}"></div></div>` : ''}
      `;
      grid.appendChild(card);
    }
    widget.appendChild(grid);

    // ── Section 2: Daily budget ──────────────────────────────────────────────────
    const s2 = document.createElement('div');
    s2.className = 'cue-section-title';
    s2.textContent = 'Daily budget';
    widget.appendChild(s2);

    const isStale       = todayDeltaLive === null && todayUsed > 0;
    const currentUsed   = todayDeltaLive ?? todayUsed;
    const withinCap     = Math.min(currentUsed, todayCap);
    const overCap       = Math.max(0, currentUsed - todayCap);
    const budgetColor   = overBudget ? C.bad : C.good;
    // Cap line at 99.5% max so it's always visible even when todayCap === 100
    const capLineLeft   = Math.min(99.5, todayCap);
    const rolloverTitle = rollover > 0
      ? `title="Base cap ${baseCap.toFixed(1)}% + ${rollover.toFixed(1)}% surplus rolled over from prior days"`
      : '';

    const budgetWrap = document.createElement('div');
    budgetWrap.style.cssText = `background:${C.bg};border:1px solid ${C.border};border-radius:8px;padding:12px 14px`;
    budgetWrap.innerHTML = `
      <div class="cue-budget-row">
        <div class="cue-budget-label">Today${isStale ? `&nbsp;<span style="color:${C.warn};font-size:9px" title="Live data unavailable — showing last recorded value">stale</span>` : ''}</div>
        <div class="cue-budget-track">
          <div class="cue-budget-fill" style="width:${withinCap}%;background:${budgetColor}"></div>
          ${overCap > 0 ? `<div class="cue-budget-over" style="left:${withinCap}%;width:${overCap}%;background:${C.bad}"></div>` : ''}
          <div class="cue-budget-cap-line" style="left:${capLineLeft}%"></div>
        </div>
        <div class="cue-budget-value">${currentUsed.toFixed(1)}% / ${todayCap.toFixed(1)}%</div>
      </div>
      <div style="font-size:10px;color:${C.muted};margin-top:6px;line-height:1.6">
        Base cap: <strong style="color:${C.text}">${baseCap.toFixed(1)}%</strong>
        ${rollover > 0 ? `&nbsp;+&nbsp;<span style="color:${C.good};cursor:help" ${rolloverTitle}>${rollover.toFixed(1)}% rolled over (?)</span>` : ''}
        &nbsp;&nbsp;|&nbsp;&nbsp;
        Week resets in <strong style="color:${C.text}">${formatDuration(msUntilWeekReset)}</strong>
        &nbsp;&nbsp;|&nbsp;&nbsp;
        ${overBudget
          ? `<span style="color:${C.bad}">Over by ${(currentUsed - todayCap).toFixed(1)}% — reduces tomorrow's cap</span>`
          : `<span style="color:${C.good}">${(todayCap - currentUsed).toFixed(1)}% remaining in today's budget</span>`
        }
      </div>
    `;
    widget.appendChild(budgetWrap);

    // ── Section 3: Weekly burndown ───────────────────────────────────────────────
    if (weekGrid.length > 0) {
      const s3 = document.createElement('div');
      s3.className = 'cue-section-title';
      s3.textContent = 'Weekly burndown  (Thu 12pm → Wed 12pm)';
      widget.appendChild(s3);

      const weekWrap = document.createElement('div');
      weekWrap.className = 'cue-week-grid';

      // Close any open popover when clicking elsewhere.
      // Remove the previous listener (if any) before adding a new one so they don't accumulate.
      const closePopovers = () => {
        weekWrap.querySelectorAll('.cue-day-popover').forEach(p => p.remove());
      };
      if (_closePopoversHandler) {
        document.removeEventListener('click', _closePopoversHandler, { capture: true });
      }
      _closePopoversHandler = closePopovers;
      document.addEventListener('click', closePopovers, { capture: true });

      for (const day of weekGrid) {
        const cell = document.createElement('div');
        const isEditable = !day.isFuture;
        cell.className = 'cue-day-cell'
          + (day.isToday ? ' today' : '')
          + (day.isWeekend ? ' weekend' : '')
          + (isEditable ? ' editable' : '');

        const usedH  = day.used !== null ? Math.min(100, day.used) : 0;
        const capH   = Math.min(100, day.cap);
        const uColor = (day.isFuture || day.used === null) ? C.muted
          : (day.used > day.cap) ? C.bad
          : (day.used > day.cap * 0.75) ? C.warn
          : C.good;
        const usedPx = Math.round((usedH / 100) * 34);
        const capPxFromBottom = Math.round(((100 - capH) / 100) * 34);
        const isManual = weekLog?.days?.[day.key]?.manual === true;

        cell.innerHTML = `
          <div class="day-dow">${day.dow}</div>
          <div style="font-size:10px;color:${C.muted};margin-bottom:2px">${formatDateShort(day.date)}</div>
          <div class="day-bar-wrap">
            <div class="day-bar-cap" style="bottom:${capPxFromBottom}px"></div>
            ${!day.isFuture && day.used !== null
              ? `<div class="day-bar-used" style="height:${usedPx}px;background:${uColor}"></div>`
              : `<div style="width:100%;height:2px;background:${C.border};border-radius:2px"></div>`
            }
          </div>
          <div style="font-weight:600;color:${day.isFuture ? C.muted : uColor}">
            ${day.isFuture ? `~${day.cap.toFixed(0)}%` : (day.used !== null ? `${day.used.toFixed(0)}%` : '—')}
            ${isManual ? '<span style="font-size:8px;opacity:0.6" title="Manually set"> *</span>' : ''}
          </div>
          <div style="font-size:10px;color:${C.muted}" title="${(() => { const rv = weekLog?.days?.[day.key]?.rollover ?? 0; return rv > 0 ? `cap = ${(day.cap - rv).toFixed(1)}% base + ${rv.toFixed(1)}% rollover` : `cap = ${day.cap.toFixed(1)}% (base)`; })()}">cap ${day.cap.toFixed(0)}%</div>
          ${isEditable ? '<div class="edit-hint">click to edit</div>' : ''}
        `;

        if (isEditable) {
          cell.addEventListener('click', (e) => {
            e.stopPropagation();
            // Close any other open popovers first
            weekWrap.querySelectorAll('.cue-day-popover').forEach(p => p.remove());

            const popover = document.createElement('div');
            popover.className = 'cue-day-popover';
            const currentVal = day.used !== null ? day.used.toFixed(1) : '';
            popover.innerHTML = `
              <label>${day.dow} ${formatDateShort(day.date)} — weekly % used</label>
              <div class="pop-row">
                <input type="number" class="pop-input" min="0" max="100" step="0.1"
                  value="${currentVal}" placeholder="e.g. 3.0">
                <span style="font-size:11px;color:${C.muted}">%</span>
                <button class="pop-save">Save</button>
              </div>
              ${isManual ? '<button class="pop-clear">Clear override (use auto)</button>' : ''}
              ${isManual ? '<div class="pop-manual-tag">* manually overridden</div>' : ''}
            `;

            cell.appendChild(popover);
            // Flip below the cell if the popover would extend above the viewport
            const cellRect = cell.getBoundingClientRect();
            if (cellRect.top < 160) {
              popover.style.bottom = 'auto';
              popover.style.top = 'calc(100% + 6px)';
            }
            popover.querySelector('.pop-input').focus();

            // Save handler
            const doSave = () => {
              const raw = parseFloat(popover.querySelector('.pop-input').value);
              if (isNaN(raw) || raw < 0 || raw > 100) return;
              // Write override into week log
              const log = loadWeekLog() || { weekStart: getWeekStart(), days: {} };
              if (!log.days[day.key]) log.days[day.key] = { used: 0, cap: baseCap, rollover: 0 };
              log.days[day.key].used   = raw;
              log.days[day.key].manual = true;
              // Recompute caps for all days after this one
              recomputeRollovers(log, baseCap);
              saveWeekLog(log);
              popover.remove();
              refresh();
            };

            popover.querySelector('.pop-save').addEventListener('click', (ev) => {
              ev.stopPropagation(); doSave();
            });
            popover.querySelector('.pop-input').addEventListener('keydown', (ev) => {
              if (ev.key === 'Enter') { ev.stopPropagation(); doSave(); }
              if (ev.key === 'Escape') { ev.stopPropagation(); popover.remove(); }
            });

            // Clear handler (only present if already manual)
            const clearBtn = popover.querySelector('.pop-clear');
            if (clearBtn) {
              clearBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const log = loadWeekLog();
                if (log?.days?.[day.key]) {
                  delete log.days[day.key].manual;
                  // If it's a past day with no auto reading, zero it out
                  if (day.key < todayKey) log.days[day.key].used = 0;
                  recomputeRollovers(log, baseCap);
                  saveWeekLog(log);
                }
                popover.remove();
                refresh();
              });
            }

            // Stop clicks inside popover from bubbling to the document close handler
            popover.addEventListener('click', ev => ev.stopPropagation());
          });
        }

        weekWrap.appendChild(cell);
      }
      widget.appendChild(weekWrap);
    }

    // ── Section 4: 5-hour window timeline ───────────────────────────────────────
    const s4 = document.createElement('div');
    s4.className = 'cue-section-title';
    s4.textContent = '5-hour windows — today (local)';
    widget.appendChild(s4);

    const blocksRow = document.createElement('div');
    blocksRow.className = 'cue-blocks';
    for (const b of windowBlocks) {
      const div = document.createElement('div');
      div.className = 'cue-block ' + (b.isPeak ? 'peak' : 'offpeak') + (b.isCurrent ? ' current' : '');
      div.innerHTML = `
        ${b.isCurrent ? '<div class="now-dot"></div>' : ''}
        <div class="bk-time">${formatTime(b.start)}<br>${formatTime(b.end)}</div>
        <div class="bk-badge">${b.isPeak ? 'Peak' : 'Off-pk'}</div>
      `;
      div.title = `${formatTime(b.start)} – ${formatTime(b.end)}\n${b.isPeak ? 'Peak: standard limits' : 'Off-peak: extended limits when active'}`;
      blocksRow.appendChild(div);
    }
    widget.appendChild(blocksRow);

    // ── Footer / controls ────────────────────────────────────────────────────────
    const footer = document.createElement('div');
    footer.className = 'cue-footer';
    const updatedStr = _lastRefreshed
      ? `Updated ${formatTime(_lastRefreshed)}`
      : 'Not yet updated';
    footer.innerHTML = `
      <span><span class="cue-dot" style="background:${C.warn}"></span>Peak 8AM–2PM ET</span>
      <span><span class="cue-dot" style="background:${C.good}"></span>Off-peak</span>
      <span><span class="cue-dot" style="background:${C.muted}"></span>${planData.label}: ~${msgsPerWin} msgs/window</span>
      <span style="color:${C.muted};font-style:italic">${updatedStr}</span>
      <div class="cue-controls">
        <label>Daily cap&nbsp;
          <input type="number" id="cue-cap-input" min="1" max="100" step="0.5"
            value="${baseCap.toFixed(1)}" title="% of weekly limit you allow per day">%
        </label>
        <label>Plan&nbsp;
          <select id="cue-plan-input">
            ${Object.entries(PLAN_INFO).map(([k, v]) =>
              `<option value="${k}" ${k === plan ? 'selected' : ''}>${v.label}</option>`
            ).join('')}
          </select>
        </label>
        <button id="cue-refresh-btn" title="Refresh native usage data and update dashboard" style="
          background:none;border:1px solid ${C.border};color:${C.text};
          border-radius:5px;padding:3px 8px;font-size:11px;cursor:pointer;
        ">↻ Refresh</button>
        <button id="cue-reset-btn" title="Clear stored week data and burn-rate history" style="
          background:none;border:1px solid ${C.border};color:${C.muted};
          border-radius:5px;padding:3px 8px;font-size:11px;cursor:pointer;
        ">Reset data</button>
      </div>
    `;

    footer.querySelector('#cue-cap-input').addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (!isNaN(v) && v > 0 && v <= 100) {
        GM_setValue(KEY_DAILY_BUDGET, String(v));
        // Clear today's cached cap so it's recalculated with the new base
        const log = loadWeekLog();
        if (log?.days?.[todayKey]) {
          delete log.days[todayKey];
          saveWeekLog(log);
        }
        refresh();
      }
    });

    footer.querySelector('#cue-plan-input').addEventListener('change', (e) => {
      GM_setValue(KEY_PLAN, e.target.value);
      refresh();
    });

    footer.querySelector('#cue-refresh-btn').addEventListener('click', forceRefresh);

    footer.querySelector('#cue-reset-btn').addEventListener('click', () => {
      if (!confirm('Clear all stored week data and burn-rate history? This cannot be undone.')) return;
      GM_setValue(KEY_WEEK_LOG, 'null');
      GM_setValue(KEY_HISTORY, '[]');
      refresh();
    });

    widget.appendChild(footer);
    return widget;
  }

  // ─── Injection ────────────────────────────────────────────────────────────────

  function findInsertTarget() {
    for (const fn of [
      () => document.querySelector('main'),
      () => document.querySelector('[class*="settings"]'),
      () => document.querySelector('[class*="usage"]'),
      () => document.querySelector('h1')?.parentElement,
      () => document.querySelector('article'),
      () => document.body,
    ]) {
      const el = fn();
      if (el) return el;
    }
    return document.body;
  }

  function inject(widget) {
    const target = findInsertTarget();
    const h1 = target.querySelector('h1');
    if (h1?.nextSibling) target.insertBefore(widget, h1.nextSibling);
    else target.prepend(widget);
  }

  // ─── Main refresh loop ────────────────────────────────────────────────────────

  let refreshTimer = null;

  function refresh() {
    // Auto-sync plan from page if it has changed since last manual selection
    const storedPlan   = GM_getValue(KEY_PLAN, null);
    const detectedPlan = detectPlanFromPage();
    if (detectedPlan && detectedPlan !== storedPlan) {
      GM_setValue(KEY_PLAN, detectedPlan);
    }
    const plan = GM_getValue(KEY_PLAN, null) || detectedPlan || 'pro';

    const { sessionPct, weeklyPct } = getUsagePercents();

    // Burn-rate history tracks the session window (resets every 5h).
    recordUsage(sessionPct);
    const history = loadHistory();

    // Budget/rollover system tracks weekly cumulative usage.
    const weekLog = updateWeekLog(weeklyPct);

    // Mark refresh time (shown in footer)
    _lastRefreshed = new Date();

    // Budget warning banner — compare today's daily delta against today's cap.
    const todayKey        = isoDate(new Date());
    const todayEntry      = weekLog?.days?.[todayKey];
    const prevWeeklyAtEnd = getPrevWeeklyAtEnd(weekLog, todayKey);
    const todayDelta      = weeklyPct !== null ? Math.max(0, weeklyPct - prevWeeklyAtEnd) : null;
    if (todayDelta !== null && todayEntry && todayDelta > todayEntry.cap) {
      showBudgetWarning(todayDelta, todayEntry.cap, todayEntry.rollover ?? 0);
    } else {
      removeBudgetWarning();
    }

    const widget = buildWidget(plan, sessionPct, weeklyPct, history, weekLog);
    const existing = document.getElementById(WIDGET_ID);
    if (existing) existing.replaceWith(widget);
    else inject(widget);
  }

  // Click the native page update button (if present), wait for re-render, then refresh dashboard.
  function forceRefresh() {
    const widget = document.getElementById(WIDGET_ID);
    const allButtons = Array.from(document.querySelectorAll('button'));
    const nativeBtn = allButtons.find(btn => {
      if (widget?.contains(btn)) return false;
      const t = (btn.textContent || btn.innerText || '').toLowerCase().trim();
      return t === 'update' || t === 'refresh' || t === 'update usage' || t === 'refresh usage';
    });
    if (nativeBtn) {
      nativeBtn.click();
      setTimeout(refresh, 2000);
    } else {
      refresh();
    }
  }

  function start() {
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      const ready = document.querySelector('main') || document.querySelector('[class*="settings"]');
      if (ready || attempts > 30) {
        clearInterval(poll);
        refresh();
        refreshTimer = setInterval(refresh, 5000);
      }
    }, 500);
  }

  // SPA navigation handler
  let lastPath = location.pathname;
  new MutationObserver(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      if (location.pathname.includes('/settings/usage')) {
        clearInterval(refreshTimer);
        if (!_startPending) {
          _startPending = true;
          setTimeout(() => { _startPending = false; start(); }, 600);
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  if (location.pathname.includes('/settings/usage')) start();

})();