// ==UserScript==
// @name         CommandCode 每月限额助手
// @namespace    https://commandcode.ai/ccx-meter
// @version      1.7.0
// @description  增强 commandcode.ai 用量页：分钟级自动同步服务器额度，三张限额卡（每月/5 小时/每周）的百分比、进度格与重置倒计时随倒计时同拍自动刷新，无需重载页面；联动页面「刷新」按钮强制同步，并补充「每月限额」安全限额警示线与按周期固定日均（自然日/工作日分摊，月中不重算不压缩）
// @author       ws1993
// @match        https://commandcode.ai/*
// @connect      api.commandcode.ai
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ============================ 可调常量 ============================ */
  var CFG = {
    PAD_ID: 'ccx-monthly-pad',
    LABEL_RE: /^(每月限额|monthly limit)$/i,          // 每月限额
    FIVE_RE: /^(5 小时限额|5-hour limit)$/i,          // 5 小时限额
    WEEK_RE: /^(每周限额|weekly limit)$/i,            // 每周限额
    RESET_RE: /(\d{1,2})月(\d{1,2})日|([A-Za-z]{3,})\s+(\d{1,2})/,
    SUBS_API: 'https://api.commandcode.ai/internal/billing/subscriptions?withPending=true',
    CREDITS_API: 'https://api.commandcode.ai/internal/billing/credits',
    USAGE_API: 'https://api.commandcode.ai/internal/usage/summary',
    SYNC_MS: 60 * 1000,                              // 分钟节拍（与倒计时同拍刷新占比）
    MIN_SYNC_MS: 20 * 1000,                          // 两次拉取的最小间隔，防重复触发
    FULL_MS: 5 * 60 * 1000,                          // 全量同步周期（含订阅精确重置时刻）
    FALLBACK_RESET_HOUR: 0,                          // DOM 推算重置日的默认时刻（本地 0 点）
    ACCENT: '#76DEC8',
    RED: '#E5484D',
    WARN_PCT: 70,                                    // 站点转橙阈值（>=70% peach）
    HOT_PCT: 90,                                     // 站点转红阈值（>=90% coral）
    CELL_BASE: 'flex-1 min-w-[2px] transition-colors duration-500',
    OFF: 'bg-muted',
    ON_TEAL: 'bg-[#76DEC8]',
    ON_PEACH: 'bg-[#F1B27E]',
    ON_CORAL: 'bg-[#EF8169]'
  };

  var MODES = { natural: '自然日', workday: '工作日' };
  var MONTH_EN = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  /* ============================ 运行时状态 ============================ */
  var state = {
    resetAt: null,   // 每月重置时刻（Date）：优先订阅接口精确值，否则 DOM 文本推算
    precise: false,
    sync: null,      // 服务器快照 { five:{pct,resetAt,exceeded}, weekly:{…}, monthly:{pct} }
    lastSync: 0,     // 最近一次同步成功时刻（面板回显，证明占比在自动刷新）
    syncErr: null    // 最近一次同步失败原因
  };
  var mode = loadMode();
  var capEl = null;       // 「今日安全限额」红字标签
  var capMarker = null;   // 进度条警示竖线
  var padEl = null;       // 本脚本面板容器（观察器据此忽略自身写入）

  /* ============================ 工具函数 ============================ */

  function store(fn, key, val) {
    var gm = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
    try {
      if (fn === 'get') return gm ? GM_getValue(key, val) : (localStorage.getItem(key) || val);
      if (fn === 'set') { if (gm) { GM_setValue(key, val); } else { localStorage.setItem(key, val); } }
    } catch (e) { /* 受限环境静默降级 */ }
    return val;
  }
  function loadMode() {
    var m = store('get', 'ccx_mode', 'natural');
    return MODES[m] ? m : 'natural';
  }

  function dayStart(t) { return new Date(t.getFullYear(), t.getMonth(), t.getDate()); }
  function fmtPct(x) { return (Math.round(x * 100) / 100).toString(); }

  function fmtCountdown(ms) {
    if (ms == null) return '--';
    if (ms <= 0) return '正在重置…';
    var d = Math.floor(ms / 86400000);
    var h = Math.floor(ms % 86400000 / 3600000);
    var m = Math.floor(ms % 3600000 / 60000);
    return d > 0 ? (d + '天 ' + h + '小时 ' + m + '分') : (h + '小时 ' + m + '分');
  }

  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') { var n = parseFloat(v); return isFinite(n) ? n : null; }
    return null;
  }

  // 5 小时/每周卡片的重置文案，与站点 ca() 同口径：horizon='long'（每周）才显示天
  function fmtResetIn(ms, horizon) {
    if (ms == null) return null;
    if (ms <= 0) return '正在重置…';
    var a = Math.floor(ms / 60000);           // 剩余分钟
    var h = Math.floor(a / 60);
    var d = Math.floor(h / 24);
    if (horizon === 'long' && d >= 1) {
      var rh = h - d * 24;
      return rh > 0 ? d + ' 天 ' + rh + ' 小时后重置' : d + ' 天后重置';
    }
    if (h >= 1) {
      var rm = a - h * 60;
      return rm > 0 ? h + ' 小时 ' + rm + ' 分钟后重置' : h + ' 小时后重置';
    }
    return Math.max(1, a) + ' 分钟后重置';
  }

  function fmtDT(t) {
    return (t.getMonth() + 1) + '月' + t.getDate() + '日 ' +
      String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
  }

  function fmtClock(ms) {
    var t = new Date(ms);
    return String(t.getHours()).padStart(2, '0') + ':' +
      String(t.getMinutes()).padStart(2, '0') + ':' +
      String(t.getSeconds()).padStart(2, '0');
  }

  /* ============================ 数据获取 ============================ */

  // 定位限额项：label span → 向上找含 progressbar 的 flex-col 容器
  // 返回 { item, row, pct, p }；pct = 行末右值 span，p = 重置说明
  function findLimitItem(labelRe) {
    var spans = document.querySelectorAll('span');
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i];
      if (s.children.length || !labelRe.test(s.textContent.trim())) continue;
      var n = s.parentElement;
      while (n && n !== document.body) {
        if (n.querySelector('[role="progressbar"]')) {
          var row = n.children && n.children[0];
          return {
            item: n,
            row: row || null,
            pct: row && row.children.length ? row.children[row.children.length - 1] : null,
            p: n.querySelector('p')
          };
        }
        n = n.parentElement;
      }
    }
    return null;
  }

  // 站点 DOM 口径用量（API 不可用时的回退）
  function readUsedPercent(item) {
    var pb = item.querySelector('[role="progressbar"]');
    if (!pb) return NaN;
    var v = parseFloat(pb.getAttribute('aria-valuenow'));
    var max = parseFloat(pb.getAttribute('aria-valuemax'));
    if (isFinite(v) && isFinite(max) && max > 0) return v / max * 100;
    if (pb.firstElementChild) {
      var cells = pb.children, lit = 0;
      for (var i = 0; i < cells.length; i++) {
        if (cells[i].className.indexOf('bg-muted') === -1) lit++;
      }
      if (cells.length) return lit / cells.length * 100;
    }
    return NaN;
  }

  function parseResetText(txt) {
    var m = txt.match(CFG.RESET_RE);
    if (!m) return null;
    var mi, d;
    if (m[1]) { mi = +m[1] - 1; d = +m[2]; }
    else {
      mi = MONTH_EN[m[3].slice(0, 3).toLowerCase()];
      if (mi == null) return null;
      d = +m[4];
    }
    var now = new Date();
    var t = new Date(now.getFullYear(), mi, d, CFG.FALLBACK_RESET_HOUR, 0, 0, 0);
    if (t.getTime() <= now.getTime()) t = new Date(now.getFullYear() + 1, mi, d, CFG.FALLBACK_RESET_HOUR, 0, 0, 0);
    return t;
  }

  // 通用 JSON 拉取：优先页面 fetch（同源登录态最可靠），失败回退 GM（跨域带 cookie）
  function apiJson(url, cb) {
    var done = false;
    var finish = function (err, j) { if (!done) { done = true; cb(err, j); } };
    var viaGM = function () {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET', url: url, timeout: 15000,
          onload: function (r) { try { finish(null, JSON.parse(r.responseText)); } catch (e) { finish(e); } },
          onerror: function () { finish(new Error('network')); },
          ontimeout: function () { finish(new Error('timeout')); }
        });
      } else finish(new Error('no-transport'));
    };
    try {
      fetch(url, { credentials: 'include' })
        .then(function (r) { return r.json(); })
        .then(function (j) { finish(null, j); })
        .catch(viaGM);
    } catch (e) { viaGM(); }
  }

  // 站点口径：windowLimits 位于 /internal/billing/credits 响应的**根层**（不在 credits 内）
  // 取整公式与站点一致：pct = min(100, round(used / cap * 100))，cap<=0 记 0，exceeded 记满
  function evalPct(x) {
    if (!x) return null;
    if (x.exceeded) return 100;
    var cap = num(x.cap);
    if (cap == null || cap <= 0) return 0;
    var used = num(x.used);
    return Math.max(0, Math.min(100, (used == null ? 0 : used) / cap * 100));
  }

  // 时间字段兼容：秒/毫秒时间戳或 ISO 字符串
  function toMs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' && isFinite(v)) return v < 1e12 ? v * 1000 : v;
    if (/^\d+$/.test(String(v))) { var n = +String(v); return n < 1e12 ? n * 1000 : n; }
    var t = Date.parse(v);
    return isNaN(t) ? null : t;
  }

  // 本轮接口结果 → 同步快照；本轮缺失的项沿用上一次的值，不回退到静态 DOM
  function mergeSync(out) {
    var prev = state.sync || {}, next = {};
    var c = out.credits || null;
    var inner = (c && c.credits) || c || {};
    var w = (c && c.windowLimits) || (c && c.credits && c.credits.windowLimits) || null;
    var granted = num(inner.monthlyCreditsGranted != null ? inner.monthlyCreditsGranted : (c && c.monthlyCreditsGranted));
    var remain = num(inner.monthlyCredits != null ? inner.monthlyCredits : (c && c.monthlyCredits));

    // 月度：两条同步路径统一用站点同源口径（granted - 剩余），避免全量/轻量之间来回跳；
    //       概览接口仅在 credits 未给出剩余时兜底
    if (granted && granted > 0) {
      var mp = null;
      if (remain != null) {
        mp = Math.max(0, Math.min(granted, granted - remain)) / granted * 100;
      } else if (out.summary) {
        var us = num(out.summary.totalMonthlyCredits);
        if (us != null) mp = us / granted * 100;
      }
      if (mp != null) next.monthly = { pct: Math.max(0, Math.min(100, mp)) };
    }

    if (w) {
      if (w.fiveHour) next.five = { pct: evalPct(w.fiveHour), resetAt: toMs(w.fiveHour.resetAt), exceeded: !!w.fiveHour.exceeded };
      if (w.weekly) next.weekly = { pct: evalPct(w.weekly), resetAt: toMs(w.weekly.resetAt), exceeded: !!w.weekly.exceeded };
    }

    ['monthly', 'five', 'weekly'].forEach(function (k) { if (!next[k] && prev[k]) next[k] = prev[k]; });
    return (next.monthly || next.five || next.weekly) ? next : null;
  }

  // 同步：full = 订阅(精确重置时刻) + 概览(本月已用) + credits(窗口限额)
  //       full=false → 只拉 credits（分钟级轻量刷新，单请求）
  function fetchAll(cb, full) {
    var out = {}, pend = full ? 3 : 1;
    var finish = function () { if (--pend === 0) cb(mergeSync(out)); };
    if (full) {
      apiJson(CFG.SUBS_API, function (err, j) {
        var d = err ? null : ((j && j.data) || j);
        var t = d && toMs(d.currentPeriodEnd);
        if (t) { state.resetAt = new Date(t); state.precise = true; }
        finish();
      });
      apiJson(CFG.USAGE_API, function (err, u) {
        if (!err && u) out.summary = u;
        finish();
      });
    }
    apiJson(CFG.CREDITS_API, function (err, c) {
      if (!err && c) out.credits = c;
      finish();
    });
  }

  /* ============================ 计算模型 ============================ */

  // 钳制日：日期回退一个月时防止日溢出（如 31 号回退 4 月 → 30 号）
  function clampDay(y, m, d) {
    return Math.min(d, new Date(y, m + 1, 0).getDate());
  }

  // 首次运行时的周期起点估算：重置日回退一个自然月（日溢出钳制）
  function prevCycleEstimate(resetAt) {
    var d = dayStart(resetAt);
    return new Date(d.getFullYear(), d.getMonth() - 1, clampDay(d.getFullYear(), d.getMonth() - 1, d.getDate()));
  }

  // 周期锚点定位：以重置日为指纹，检测到新周期时用上一周期的重置日作为本周期起点；
  // 结果持久化，跨刷新保持同一周期口径。返回 { start, est }（est = 起点为估算值）
  function locateCycle(resetAt) {
    var start = null, est = false;
    var anchor = dayStart(resetAt).getTime();
    var obj = null;
    try { obj = JSON.parse(store('get', 'ccx_cycle', null)); } catch (e) { obj = null; }
    if (obj && typeof obj.resetAt === 'string' && typeof obj.start === 'string') {
      var savedStart = new Date(+obj.start);
      if (String(anchor) === obj.resetAt && !isNaN(savedStart.getTime())) {
        start = savedStart;                        // 同一周期的既有锚点，直接复用
      } else {
        var savedReset = isNaN(+obj.resetAt) ? NaN : +obj.resetAt;
        if (!isNaN(savedReset) && savedReset < anchor) {
          start = dayStart(new Date(savedReset));  // 新周期：上次重置日即本周期起点
        }
      }
    }
    if (!start) { start = prevCycleEstimate(resetAt); est = true; }
    if (String(anchor) !== (obj && obj.resetAt)) {
      store('set', 'ccx_cycle', JSON.stringify({ resetAt: String(anchor), start: String(dayStart(start).getTime()) }));
    }
    return { start: dayStart(start), est: est };
  }

  // 周期统计：全周期天数/工作日数 + 今天是周期内第几天（含当天）
  // 起点·第 1 天计入，重置日不计入；tIdx 钳制在周期范围内防异常时钟
  function cycleStats(start, resetAt, now) {
    var days = Math.max(1, Math.round((dayStart(resetAt) - start) / 86400000));
    var tIdx = Math.max(0, Math.min(days - 1, Math.round((dayStart(now) - start) / 86400000)));
    var i, w, workdays = 0, elapsedWorkdays = 0;
    for (i = 0; i < days; i++) {
      w = new Date(start.getTime() + i * 86400000).getDay();
      if (w >= 1 && w <= 5) { workdays++; if (i <= tIdx) elapsedWorkdays++; }
    }
    return {
      days: days, workdays: workdays,
      elapsedDays: tIdx + 1, elapsedWorkdays: elapsedWorkdays,
      todayWorkday: now.getDay() >= 1 && now.getDay() <= 5
    };
  }

  /* ============================ 站点卡片补丁 ============================ */

  // 格子配色分档（与站点 oa()+dr 表一致）：<70% 青，70~90% 橙，≥90% 或超限 珊瑚红
  function cellTone(pct, exceeded) {
    var on = (exceeded || pct >= CFG.HOT_PCT) ? CFG.ON_CORAL
           : pct >= CFG.WARN_PCT ? CFG.ON_PEACH : CFG.ON_TEAL;
    return { on: CFG.CELL_BASE + ' ' + on, off: CFG.CELL_BASE + ' ' + CFG.OFF };
  }

  // 用同步值重写限额卡：数字、格子、aria、重置倒计时文案
  // pct 传 null 时跳过数字/格子（保留站点自身口径），仅重写倒计时
  function patchLimit(L, pct, resetAt, exceeded, horizon) {
    if (!L || !L.item) return;
    var pb = L.item.querySelector('[role="progressbar"]');
    if (!pb) return;
    if (pct != null && isFinite(pct)) {
      var p2 = Math.max(0, Math.min(100, Math.round(pct)));   // 站点为 Math.round
      if (L.pct) {
        var want = p2 + '%';
        if (L.pct.textContent !== want) L.pct.textContent = want;
        // 内联色用节点记忆：浏览器会规范化 var() 串，实时读回比较会每轮都误判为“有变化”
        var color = exceeded ? 'var(--color-red-500,#ef4444)' : '';
        if (L.pct.__ccxColor !== color) { L.pct.__ccxColor = color; L.pct.style.color = color; }
      }
      if (pb.getAttribute('aria-valuenow') !== String(p2)) pb.setAttribute('aria-valuenow', String(p2));
      var cells = [];
      for (var i = 0; i < pb.children.length; i++) {
        var c = pb.children[i];
        if (!(c.getAttribute && c.getAttribute('data-ccx-marker'))) cells.push(c);
      }
      // 站点亮格口径 Ft()：pct>0 时至少点亮 1 格
      var lit = p2 > 0 ? Math.max(1, Math.round(p2 * cells.length / 100)) : 0;
      var tone = cellTone(p2, exceeded);
      for (i = 0; i < cells.length; i++) {
        var target = i < lit ? tone.on : tone.off;
        if (cells[i].className !== target) cells[i].className = target;
      }
    }
    if (resetAt && L.p) {
      var ms = (resetAt instanceof Date ? resetAt.getTime() : +resetAt) - Date.now();
      var txt = fmtResetIn(ms, horizon);
      if (txt && L.p.textContent !== txt) L.p.textContent = txt;
    }
  }

  /* ============================ 面板渲染 ============================ */

  var S = {
    row: 'display:flex;align-items:baseline;justify-content:space-between;gap:8px;',
    lab: 'font-family:var(--font-mono,ui-monospace,monospace);font-size:13px;' +
         'color:var(--color-muted-foreground,var(--muted-foreground,#a1a1aa));' +
         'text-transform:uppercase;letter-spacing:.05em;margin:0;',
    val: 'font-family:var(--font-mono,ui-monospace,monospace);font-size:13px;' +
         'font-variant-numeric:tabular-nums;color:var(--color-foreground,var(--foreground,#fafafa));',
    note: 'font-family:var(--font-mono,ui-monospace,monospace);font-size:12px;line-height:1.35;' +
          'color:var(--color-muted-foreground,var(--muted-foreground,#a1a1aa));opacity:.75;margin:0;',
    cap:  'font-family:var(--font-mono,ui-monospace,monospace);font-size:13px;' +
          'color:' + CFG.RED + ';margin-right:auto;white-space:nowrap;',
    mk:   'position:absolute;top:-4px;bottom:-4px;width:2px;border-radius:2px;' +
          'background:' + CFG.RED + ';z-index:2;pointer-events:none;'
  };

  function chipHTML(m) {
    var active = mode === m;
    var style = 'border:1px solid ' + (active ? CFG.ACCENT : 'var(--color-border,var(--border,#222225))') +
      ';background:' + (active ? CFG.ACCENT : 'transparent') +
      ';color:' + (active ? '#000' : S.lab.split('color:')[1].split(';')[0]) +
      ';font-family:inherit;font-size:12px;padding:2px 9px;cursor:pointer;letter-spacing:.05em;';
    return '<button data-mode="' + m + '" style="' + style + '">' + MODES[m] + '</button>';
  }

  function render() {
    var mL = findLimitItem(CFG.LABEL_RE);
    if (!mL) return; // 不在用量页或结构变更，等待观察器重试

    var pad = document.getElementById(CFG.PAD_ID);
    if (!pad) { pad = document.createElement('div'); pad.id = CFG.PAD_ID; pad.addEventListener('click', onPadClick); }
    if (pad.parentElement !== mL.item) mL.item.appendChild(pad);
    padEl = pad;

    // 用量：优先服务器同步值，回退站点进度条
    var used = state.sync && state.sync.monthly ? state.sync.monthly.pct : readUsedPercent(mL.item);
    if (!isFinite(used)) { if (pad.__ccx !== '') { pad.__ccx = ''; pad.textContent = ''; } return; }
    used = Math.max(0, Math.min(100, used));
    var remaining = Math.max(0, 100 - used);

    // 重置时刻：API 精确值 >（缓存）> DOM 文本推算
    if (!state.resetAt) {
      var t = mL.p && parseResetText(mL.p.textContent);
      if (t) { state.resetAt = t; state.precise = false; }
    }
    if (!state.resetAt) return;

    var now = new Date();
    var left = state.resetAt.getTime() - now.getTime();
    var cyc = locateCycle(state.resetAt);
    var cs = cycleStats(cyc.start, state.resetAt, now);
    // 固定日均 = 周期总额（100%）÷ 周期天数/工作日数，周期开局锁定，月中不重算；
    // 今日安全限额 = 固定日均 × 周期内已过天数（含今天）累计节奏线
    var perDay, capBase, capLine;
    if (mode === 'workday') {
      perDay = 100 / Math.max(1, cs.workdays);
      capBase = cs.elapsedWorkdays;
      capLine = '今日安全限额' + (cs.todayWorkday ? '' : '（休息日）');
    } else {
      perDay = 100 / cs.days;
      capBase = cs.elapsedDays;
      capLine = '今日安全限额';
    }
    var todayCap = Math.min(100, perDay * capBase);

    // ── 补丁每月限额卡（同步值生效时直接重写站点数字与格子）──
    if (state.sync && state.sync.monthly) patchLimit(mL, used, null, Math.round(used) >= 100);

    // ── 红字标签 + 进度条警示线（全部按节点记忆做差异写入，防观察器空转）──
    var pb = mL.item.querySelector('[role="progressbar"]');
    var rowEl = mL.row;
    if (pb && rowEl) {
      var capPct = Math.max(0, Math.min(100, todayCap));
      var capTxt = capLine + '： ' + fmtPct(todayCap) + '%';
      if (!capEl) capEl = document.createElement('span');
      if (capEl.parentElement !== rowEl || capEl !== rowEl.children[1]) {
        rowEl.insertBefore(capEl, rowEl.children[1] || null);
      }
      if (capEl.__ccxCap !== '1') {
        capEl.__ccxCap = '1';
        capEl.setAttribute('data-ccx-cap', '1');
      }
      if (capEl.__ccxStyle !== S.cap) { capEl.__ccxStyle = S.cap; capEl.setAttribute('style', S.cap); }
      if (capEl.__ccxTxt !== capTxt) { capEl.__ccxTxt = capTxt; capEl.textContent = capTxt; }

      if (pb.__ccxPos !== 'relative') { pb.__ccxPos = 'relative'; pb.style.position = 'relative'; }
      if (!capMarker) capMarker = document.createElement('div');
      if (capMarker.parentElement !== pb) pb.appendChild(capMarker);
      if (capMarker.__ccxMk !== '1') {
        capMarker.__ccxMk = '1';
        capMarker.setAttribute('data-ccx-marker', '1');
      }
      var mkStyle = S.mk + 'left:calc(' + capPct + '% - 1px);';
      if (capMarker.__ccxStyle !== mkStyle) { capMarker.__ccxStyle = mkStyle; capMarker.setAttribute('style', mkStyle); }
    }

    // ── 补丁 5 小时 / 每周限额卡：数字 + 格子 + 重置倒计时全部接管 ──
    // 数据同源（credits 接口根层 windowLimits），口径与站点一致，故可安全覆写
    if (state.sync) {
      var f = state.sync.five, wk = state.sync.weekly;
      if (f) patchLimit(findLimitItem(CFG.FIVE_RE), f.pct, f.resetAt, f.exceeded, 'short');
      if (wk) patchLimit(findLimitItem(CFG.WEEK_RE), wk.pct, wk.resetAt, wk.exceeded, 'long');
    }

    var modeNote;
    if (mode === 'workday') {
      modeNote = cs.todayWorkday
        ? '固定日均 = 100% ÷ 周期 ' + cs.workdays + ' 个工作日 = ' + fmtPct(perDay) + '%/天；已过 ' + cs.elapsedWorkdays + ' 个工作日'
        : '今日为休息日，不消耗工作日配额（累计线维持 ' + fmtPct(todayCap) + '%）';
    } else {
      modeNote = '固定日均 = 100% ÷ 周期 ' + cs.days + ' 个自然日 = ' + fmtPct(perDay) + '%/天；今日为周期第 ' + cs.elapsedDays + ' 天';
    }

    var val = 'text-align:right;';
    var accent = val + 'color:' + CFG.ACCENT + ';';
    var stamp = state.lastSync
      ? '额度已自动同步 ' + fmtClock(state.lastSync)
      : (state.syncErr ? '额度同步未成功，下一分钟自动重试' : '额度等待首次同步');

    var html =
      '<div style="' + S.row + 'border-top:1px solid var(--color-border,var(--border,#222225));padding-top:13px;">' +
        '<span style="' + S.lab + '">重置倒计时</span>' +
        '<span style="' + accent + '">' + fmtCountdown(left) + '</span>' +
      '</div>' +
      '<div style="' + S.row + '">' +
        '<span style="' + S.lab + '">重置时点</span>' +
        '<span style="' + val + '">' + fmtDT(state.resetAt) +
          (state.precise ? '' : ' *') + '</span>' +
      '</div>' +
      '<div style="' + S.row + '">' +
        '<span style="' + S.lab + '">剩余额度</span>' +
        '<span style="' + val + '">' + fmtPct(remaining) + '% · 周期 ' + (mode === 'workday'
          ? cs.workdays + ' 工作日'
          : cs.days + ' 天') + '</span>' +
      '</div>' +
      '<div style="' + S.row + '">' +
        '<span style="' + S.lab + '">今日配额（固定）</span>' +
        '<span style="' + val + '">+' + fmtPct(perDay) + '%</span>' +
      '</div>' +
      '<div style="' + S.row + '">' +
        '<span style="' + S.lab + '">' + capLine + '</span>' +
        '<span style="' + val + '">' + fmtPct(todayCap) + '%</span>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
        '<span style="' + S.lab + '">模式</span>' +
        chipHTML('natural') + chipHTML('workday') +
      '</div>' +
      '<p style="' + S.note + '">' +
        modeNote + '；安全限额 = 固定日均 × 周期内已过天数（累计节奏线，整周期口径不变）' +
        (cyc.est ? '；周期起点为估算，下次重置后自动校准' : '') +
        (state.precise ? '' : '；* 时间由页面文本推算') +
        '；' + stamp + '（每 ' + Math.round(CFG.SYNC_MS / 1000) + ' 秒）' +
      '</p>';

    // 内容无变化则不写 DOM：避免观察器自激，也不打断文本选中
    if (pad.__ccx !== html) { pad.__ccx = html; pad.innerHTML = html; }
  }

  function onPadClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-mode]') : null;
    if (!b) return;
    var m = b.getAttribute('data-mode');
    if (MODES[m] && m !== mode) {
      mode = m;
      store('set', 'ccx_mode', m);
      render();
    }
  }

  /* ============================ 生命周期 ============================ */

  var syncing = false;

  // 同步入口：full=true 全量（订阅 + 概览 + 额度）；否则只拉 credits（1 个请求，分钟级）
  function sync(full) {
    if (syncing || document.hidden) return;                     // 后台标签页不打接口
    if (!full && Date.now() - state.lastSync < CFG.MIN_SYNC_MS) return;
    syncing = true;
    fetchAll(function (res) {
      syncing = false;
      if (res) {
        state.sync = res;
        state.syncErr = null;
        state.lastSync = Date.now();
      } else {
        state.syncErr = '数据';
      }
      render();
    }, !!full);
  }

  // 分钟节拍：整点对齐，先刷新倒计时与节奏线，再拉一次最新用量占比
  function tick() { render(); sync(false); }
  function minuteLoop() {
    var now = new Date();
    var next = now.getTime() - now.getMilliseconds() - now.getSeconds() * 1000 + 60000;
    setTimeout(function () { tick(); minuteLoop(); }, next - now.getTime());
  }
  function fullLoop() {
    setTimeout(function () { sync(true); fullLoop(); }, CFG.FULL_MS);
  }

  // 站点 React 重渲染会覆盖我们的补丁 → 下一帧重新贴回（render 幂等，无差异不写 DOM）
  var checkTimer = null;
  function scheduleCheck() {
    if (checkTimer) return;
    checkTimer = setTimeout(function () { checkTimer = null; render(); }, 200);
  }

  function bindLifecycle() {
    ['pushState', 'replaceState'].forEach(function (k) {
      var orig = history[k];
      history[k] = function () { var r = orig.apply(this, arguments); scheduleCheck(); return r; };
    });
    window.addEventListener('popstate', scheduleCheck);

    if (document.body) {
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var t = muts[i].target;
          if (t && t.nodeType === 3) t = t.parentElement;
          if (padEl && t && (t === padEl || padEl.contains(t))) continue;  // 忽略自身面板写入
          scheduleCheck();
          return;
        }
      }).observe(document.body, { childList: true, subtree: true });
    }

    // 切回前台/窗口聚焦时立即补一次，避免看到的是几分钟前的旧占比
    document.addEventListener('visibilitychange', function () { if (!document.hidden) sync(false); });
    window.addEventListener('focus', function () { sync(false); });

    // 站点「刷新」按钮只重取概览接口，不更新用量限额 → 点击后强制全量同步两次
    document.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!b || e.target.closest('#' + CFG.PAD_ID)) return;
      var t = (b.textContent || '').trim();
      if (t.length <= 12 && /刷新|refresh/i.test(t)) {
        setTimeout(function () { sync(true); }, 400);
        setTimeout(function () { sync(true); }, 1600);
      }
    }, true);
  }

  // 启动：DOM 就绪后按页面兜底渲染 → 全量同步一次 → 进入分钟级自动刷新
  function boot() {
    bindLifecycle();
    render();
    sync(true);
    minuteLoop();
    fullLoop();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
