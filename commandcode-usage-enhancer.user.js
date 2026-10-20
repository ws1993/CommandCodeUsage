// ==UserScript==
// @name         CommandCode 每月限额助手
// @namespace    https://commandcode.ai/ccx-meter
// @version      1.6.0
// @description  增强 commandcode.ai 用量页：联动页面「刷新」按钮强制同步限额（站点刷新不更新用量限额），同步后直接补丁三张限额卡（百分比/格子/重置倒计时）、「每月限额」安全限额警示线，按周期固定日均（自然日/工作日分摊，月中不重算不压缩）
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
    CALIBRATE_MS: 5 * 60 * 1000,                     // 例行同步周期
    FALLBACK_RESET_HOUR: 0,                          // DOM 推算重置日的默认时刻（本地 0 点）
    ACCENT: '#76DEC8',
    RED: '#E5484D',
    CELL_LIT: 'flex-1 min-w-[2px] transition-colors duration-500 bg-[#76DEC8]',  // 已用格
    CELL_OFF: 'flex-1 min-w-[2px] transition-colors duration-500 bg-muted'       // 剩余格
  };

  var MODES = { natural: '自然日', workday: '工作日' };
  var MONTH_EN = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  /* ============================ 运行时状态 ============================ */
  var state = {
    resetAt: null,   // 每月重置时刻（Date）：优先订阅接口精确值，否则 DOM 文本推算
    precise: false,
    sync: null       // 服务器同步结果 { five:{pct,resetAt}, weekly:{pct,resetAt}, monthly:{pct} }
  };
  var mode = loadMode();
  var capEl = null;       // 「今日安全限额」红字标签
  var capMarker = null;   // 进度条警示竖线

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

  // 5 小时/每周卡片的重置文案（与站点格式一致，但每分钟实时）
  function fmtResetIn(ms) {
    if (ms == null) return null;
    if (ms <= 0) return '正在重置…';
    var d = Math.floor(ms / 86400000);
    var h = Math.floor(ms % 86400000 / 3600000);
    var m = Math.floor(ms % 3600000 / 60000);
    if (d > 0) return d + ' 天 ' + h + ' 小时后重置';
    if (h > 0) return h + ' 小时 ' + m + ' 分钟后重置';
    return m + ' 分钟后重置';
  }

  function fmtDT(t) {
    return (t.getMonth() + 1) + '月' + t.getDate() + '日 ' +
      String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
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

  // 汇总同步：订阅(精确重置时刻) + usage/summary(月度已用) + credits(配额与窗口限额)
  function fetchAll(cb) {
    var result = null, pend = 2;
    var done = function () { if (--pend === 0) cb(result ? null : new Error('no-data'), result); };
    apiJson(CFG.SUBS_API, function (err, j) {
      if (!err && j && j.data && j.data.currentPeriodEnd) {
        var t = new Date(j.data.currentPeriodEnd);
        if (!isNaN(t.getTime())) { state.resetAt = t; state.precise = true; }
      }
      done();
    });
    apiJson(CFG.USAGE_API, function (errU, u) {
      var used = errU || !u || !isFinite(u.totalMonthlyCredits) ? null : u.totalMonthlyCredits;
      apiJson(CFG.CREDITS_API, function (errC, c) {
        var credits = (!errC && c && c.credits) || null;
        var w = (credits && credits.windowLimits) || {};
        var wp = function (x) { return x && x.cap > 0 ? x.used / x.cap * 100 : null; };
        if (credits && credits.monthlyCreditsGranted > 0 && used != null) {
          result = {
            monthly: { pct: used / credits.monthlyCreditsGranted * 100 }
          };
          // 5 小时/每周：credits 的 used/cap 口径与站点显示不一致（实测 3.3% vs 10%），
          // 故 pct 仅在可算时携带，resetAt 为服务器权威值始终携带；
          // render 侧按 pct=null 调用 → 只重写倒计时文案，不接管站点数字/格子
          var fh = w.fiveHour, fwp = wp(fh);
          if (fwp != null || (fh && fh.resetAt)) {
            result.five = { pct: fwp, resetAt: fh && fh.resetAt ? new Date(fh.resetAt) : null };
          }
          var wko = w.weekly, kwp = wp(wko);
          if (kwp != null || (wko && wko.resetAt)) {
            result.weekly = { pct: kwp, resetAt: wko && wko.resetAt ? new Date(wko.resetAt) : null };
          }
        }
        done();
      });
    });
  }

  function calibrate() {
    fetchAll(function (err, data) {
      if (!err && data) { state.sync = data; render(); }
      // 失败时保留上一次结果或 DOM 值，不打断本轮渲染
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

  // 用同步值重写限额卡。pct 传 null 时跳过数字/格子（不动站点口径），仅重写重置倒计时文案
  function patchLimit(L, pct, resetAt) {
    if (!L || !L.item) return;
    var pb = L.item.querySelector('[role="progressbar"]');
    if (!pb) return;
    if (pct != null && isFinite(pct)) {
      var p2 = Math.max(0, Math.min(100, pct));
      if (L.pct) L.pct.textContent = Math.floor(p2) + '%';         // 与站点取整口径一致
      pb.setAttribute('aria-valuenow', String(Math.floor(p2)));
      var cells = [];
      for (var i = 0; i < pb.children.length; i++) {
        var c = pb.children[i];
        if (!(c.getAttribute && c.getAttribute('data-ccx-marker'))) cells.push(c);
      }
      var lit = Math.round(p2 * cells.length / 100);
      for (i = 0; i < cells.length; i++) {
        var target = i < lit ? CFG.CELL_LIT : CFG.CELL_OFF;
        if (cells[i].className !== target) cells[i].className = target;
      }
    }
    if (resetAt && L.p) {
      var txt = fmtResetIn(resetAt.getTime() - Date.now());
      if (txt) L.p.textContent = txt;
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

    // 用量：优先服务器同步值，回退站点进度条
    var used = state.sync && state.sync.monthly ? state.sync.monthly.pct : readUsedPercent(mL.item);
    if (!isFinite(used)) { pad.textContent = ''; return; }
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

    // ── 补丁每月限额卡（同步值生效时直接重写站点显示）──
    if (state.sync && state.sync.monthly) patchLimit(mL, used, null);

    // ── 红字标签 + 进度条警示线 ──
    var pb = mL.item.querySelector('[role="progressbar"]');
    var rowEl = mL.row;
    if (pb && rowEl) {
      var capPct = Math.max(0, Math.min(100, todayCap));
      if (!capEl) capEl = document.createElement('span');
      if (capEl.parentElement !== rowEl || capEl !== rowEl.children[1]) {
        rowEl.insertBefore(capEl, rowEl.children[1] || null);
      }
      capEl.setAttribute('data-ccx-cap', '1');
      capEl.setAttribute('style', S.cap);
      capEl.textContent = capLine + '： ' + fmtPct(todayCap) + '%';

      pb.style.position = 'relative';
      if (!capMarker) capMarker = document.createElement('div');
      if (capMarker.parentElement !== pb) pb.appendChild(capMarker);
      capMarker.setAttribute('data-ccx-marker', '1');
      capMarker.setAttribute('style', S.mk + 'left:calc(' + capPct + '% - 1px);');
    }

    // ── 补丁 5 小时 / 每周限额卡：仅接管重置倒计时文案（pct=null）──
    // 这两张卡的 credits.used/cap 口径与站点显示不一致，不接管数字/格子；缺失则整卡不动
    if (state.sync) {
      if (state.sync.five) patchLimit(findLimitItem(CFG.FIVE_RE), null, state.sync.five.resetAt);
      if (state.sync.weekly) patchLimit(findLimitItem(CFG.WEEK_RE), null, state.sync.weekly.resetAt);
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

    pad.innerHTML =
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
        (state.sync ? '；额度已同步服务器' : '；额度与页面进度一致（可能滞后，稍后自动同步）') +
      '</p>';
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

  // 每分钟对齐刷新（倒计时精确到分钟；同步值存在时顺带重贴站点卡片补丁）
  function minuteLoop() {
    var now = new Date();
    var next = now.getTime() - now.getMilliseconds() - now.getSeconds() * 1000 + 60000;
    setTimeout(function () { render(); minuteLoop(); }, next - now.getTime());
  }

  ['pushState', 'replaceState'].forEach(function (k) {
    var orig = history[k];
    history[k] = function () { var r = orig.apply(this, arguments); scheduleCheck(); return r; };
  });
  window.addEventListener('popstate', scheduleCheck);

  var checkTimer = null;
  function scheduleCheck() {
    if (checkTimer) return;
    checkTimer = setTimeout(function () {
      checkTimer = null;
      if (!document.getElementById(CFG.PAD_ID)) render();
    }, 200);
  }
  new MutationObserver(scheduleCheck).observe(document.body, { childList: true, subtree: true });

  // 站点「刷新」按钮只重取概览接口，不更新用量限额 → 点击后强制同步两次
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!b || e.target.closest('#' + CFG.PAD_ID)) return;
    var t = (b.textContent || '').trim();
    if (t.length <= 12 && /刷新|refresh/i.test(t)) {
      setTimeout(calibrate, 400);
      setTimeout(calibrate, 1600);
    }
  }, true);

  // 启动：先按 DOM 渲染兜底，再异步同步服务器
  render();
  calibrate();
  setInterval(calibrate, CFG.CALIBRATE_MS);
  minuteLoop();
})();
