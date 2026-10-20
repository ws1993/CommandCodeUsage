// ==UserScript==
// @name         CommandCode 每月限额助手
// @namespace    https://commandcode.ai/ccx-meter
// @version      1.0.0
// @description  增强 commandcode.ai 用量页「每月限额」：重置倒计时（精确到分钟、每分钟自动刷新）、今日安全限额计算、自然日/工作日两种分摊模式
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
    PAD_ID: 'ccx-monthly-pad',                       // 注入面板的元素 id（防重复挂载）
    LABEL_RE: /^(每月限额|monthly limit)$/i,          // 限额项标签识别（中英双语兼容）
    RESET_RE: /(\d{1,2})月(\d{1,2})日|([A-Za-z]{3,})\s+(\d{1,2})/, // “11月15日 重置” / “Resets Nov 15”
    SUBS_API: 'https://api.commandcode.ai/internal/billing/subscriptions?withPending=true',
    CALIBRATE_MS: 5 * 60 * 1000,                     // 每 5 分钟向后端重新校准重置时间戳
    FALLBACK_RESET_HOUR: 0,                          // 拿不到精确时间戳时，重置日默认按本地 0 点
    ACCENT: '#76DEC8'                                // 与站点每月限额配色一致
  };

  var MODES = { natural: '自然日', workday: '工作日' };
  var MONTH_EN = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  /* ============================ 运行时状态 ============================ */
  var state = {
    resetAt: null,        // 重置时刻（Date）；优先 API 精确值，否则 DOM 文本推算
    precise: false        // 是否来自 API 精确时间戳
  };
  var mode = loadMode();  // 计算模式，持久化

  /* ============================ 工具函数 ============================ */

  // GM 存储优先，降级 localStorage
  function store(fn, key, val) {
    var gm = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
    try {
      if (fn === 'get') return gm ? GM_getValue(key, val) : (localStorage.getItem(key) || val);
      if (fn === 'set') { if (gm) { GM_setValue(key, val); } else { localStorage.setItem(key, val); } }
    } catch (e) { /* 隐身/受限环境静默降级 */ }
    return val;
  }
  function loadMode() {
    var m = store('get', 'ccx_mode', 'natural');
    return MODES[m] ? m : 'natural';
  }

  function dayStart(t) { return new Date(t.getFullYear(), t.getMonth(), t.getDate()); }
  function fmtPct(x) { return (Math.round(x * 100) / 100).toString(); }

  // 倒计时美化：X天 X小时 X分（精确到分钟）
  function fmtCountdown(ms) {
    if (ms == null) return '--';
    if (ms <= 0) return '正在重置…';
    var d = Math.floor(ms / 86400000);
    var h = Math.floor(ms % 86400000 / 3600000);
    var m = Math.floor(ms % 3600000 / 60000);
    return d > 0 ? (d + '天 ' + h + '小时 ' + m + '分') : (h + '小时 ' + m + '分');
  }
  function fmtDT(t) {
    return (t.getMonth() + 1) + '月' + t.getDate() + '日 ' +
      String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
  }

  /* ============================ 数据获取 ============================ */

  // 定位「每月限额」限额项根节点（含 label / progressbar / 重置说明 p）
  function findMonthlyItem() {
    var spans = document.querySelectorAll('span');
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i];
      if (s.children.length || !CFG.LABEL_RE.test(s.textContent.trim())) continue;
      var n = s.parentElement; // 向上找包含 progressbar 与重置说明的 flex-col 容器
      while (n && n !== document.body) {
        if (n.querySelector('[role="progressbar"]')) return n;
        n = n.parentElement;
      }
    }
    return null;
  }

  // 读取用量百分比：优先 aria-valuenow（受 aria-valuemax 归一化），失败则从已高亮格估算
  function readUsedPercent(item) {
    var pb = item.querySelector('[role="progressbar"]');
    if (!pb) return NaN;
    var v = parseFloat(pb.getAttribute('aria-valuenow'));
    var max = parseFloat(pb.getAttribute('aria-valuemax'));
    if (isFinite(v) && isFinite(max) && max > 0) return v / max * 100;
    // 估算兜底：已填充的色块格数 / 总格数
    if (pb.firstElementChild) {
      var cells = pb.children, lit = 0;
      for (var i = 0; i < cells.length; i++) {
        if (cells[i].className.indexOf('bg-muted') === -1) lit++;
      }
      if (cells.length) return lit / cells.length * 100;
    }
    return NaN;
  }

  // 从重置说明文本（“11月15日 重置”）推算日期；不足当年则顺延一年
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

  // 订阅接口：返回精确到秒的 currentPeriodEnd（即「每月限额」重置时刻）
  function fetchPeriodEnd(cb) {
    var url = CFG.SUBS_API;
    var parse = function (j) { return (j && j.data && j.data.currentPeriodEnd) || null; };
    if (typeof GM_xmlhttpRequest === 'function') {
      GM_xmlhttpRequest({
        method: 'GET', url: url, timeout: 15000,
        onload: function (r) { try { cb(null, parse(JSON.parse(r.responseText))); } catch (e) { cb(e); } },
        onerror: function () { cb(new Error('network')); },
        ontimeout: function () { cb(new Error('timeout')); }
      });
    } else {
      // 降级：页面上下文同源凭据 fetch（cookie 鉴权）
      fetch(url, { credentials: 'include' })
        .then(function (r) { return r.json(); })
        .then(function (j) { cb(null, parse(j)); })
        .catch(cb);
    }
  }

  function calibrate() {
    fetchPeriodEnd(function (err, iso) {
      if (!err && iso) {
        var t = new Date(iso);
        if (!isNaN(t.getTime())) { state.resetAt = t; state.precise = true; render(); }
      }
      // 失败时保留上一次结果或 DOM 推算值，不打断本轮渲染
    });
  }

  /* ============================ 计算模型 ============================ */

  // 剩余天数：今天（含）到重置日（不含）的日历跨度
  function remainingDays(resetAt, now) {
    return Math.max(1, Math.round((dayStart(resetAt) - dayStart(now)) / 86400000));
  }

  // 工作日统计：同区间内周一~五的天数；todayWorkday 标记今天是否消耗工作日额度
  function workdayStats(resetAt, now) {
    var total = remainingDays(resetAt, now);
    var today = dayStart(now), workdays = 0;
    for (var i = 0; i < total; i++) {
      var w = new Date(today.getTime() + i * 86400000).getDay();
      if (w >= 1 && w <= 5) workdays++;
    }
    return { total: total, workdays: workdays, todayWorkday: now.getDay() >= 1 && now.getDay() <= 5 };
  }

  /* ============================ 面板渲染 ============================ */

  // 行样式沿用站点设计语言（等宽字体、muted 前 #a1a1aa、边框 #222225）
  var S = {
    row: 'display:flex;align-items:baseline;justify-content:space-between;gap:8px;',
    lab: 'font-family:var(--font-mono,ui-monospace,monospace);font-size:13px;' +
         'color:var(--color-muted-foreground,var(--muted-foreground,#a1a1aa));' +
         'text-transform:uppercase;letter-spacing:.05em;margin:0;',
    val: 'font-family:var(--font-mono,ui-monospace,monospace);font-size:13px;' +
         'font-variant-numeric:tabular-nums;color:var(--color-foreground,var(--foreground,#fafafa));',
    note: 'font-family:var(--font-mono,ui-monospace,monospace);font-size:12px;line-height:1.35;' +
          'color:var(--color-muted-foreground,var(--muted-foreground,#a1a1aa));opacity:.75;margin:0;'
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
    var item = findMonthlyItem();
    if (!item) return; // 不在用量页或结构变更，等待观察器重试

    var pad = document.getElementById(CFG.PAD_ID);
    if (!pad) { pad = document.createElement('div'); pad.id = CFG.PAD_ID; pad.addEventListener('click', onPadClick); }
    if (pad.parentElement !== item) item.appendChild(pad); // 挂在重置说明之后（flex-col 自动排布）

    var used = readUsedPercent(item);
    if (!isFinite(used)) { pad.textContent = ''; return; }
    used = Math.max(0, Math.min(100, used));
    var remaining = Math.max(0, 100 - used);

    // 重置时刻：API 精确值 >（缓存）> DOM 文本推算
    if (!state.resetAt) {
      var p = item.querySelector('p');
      var t = p && parseResetText(p.textContent);
      if (t) { state.resetAt = t; state.precise = false; }
    }
    if (!state.resetAt) return; // 两路数据都缺失，本帧不渲染

    var now = new Date();
    var left = state.resetAt.getTime() - now.getTime();
    var wd = workdayStats(state.resetAt, now);
    var totalDays = wd.total;

    // ── 核心计算 ──
    // 每日配额 = 剩余额度 ÷ 剩余天数；今日安全限额 = 已用 + 今日配额（累计口径）
    var perDay, todayAvail, capLine;
    if (mode === 'workday') {
      perDay = remaining / Math.max(1, wd.workdays);
      todayAvail = wd.todayWorkday ? perDay : 0;
      capLine = '今日安全限额' + (wd.todayWorkday ? '' : '（休息日）');
    } else {
      perDay = remaining / totalDays;
      todayAvail = perDay;
      capLine = '今日安全限额';
    }
    var todayCap = Math.min(100, used + todayAvail);

    var modeNote;
    if (mode === 'workday') {
      modeNote = wd.todayWorkday
        ? '今日配额 = 剩余 ' + fmtPct(remaining) + '% ÷ ' + wd.workdays + ' 个工作日'
        : '今日为休息日，不消耗工作日额度（额度维持 ' + fmtPct(used) + '%）';
    } else {
      modeNote = '今日配额 = 剩余 ' + fmtPct(remaining) + '% ÷ ' + totalDays + ' 个自然日';
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
        '<span style="' + val + '">' + (mode === 'workday'
          ? fmtPct(remaining) + '% · ' + wd.workdays + ' 工作日'
          : fmtPct(remaining) + '% · ' + totalDays + ' 天') + '</span>' +
      '</div>' +
      '<div style="' + S.row + '">' +
        '<span style="' + S.lab + '">今日配额</span>' +
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
        modeNote + '；安全限额 = 已用 ' + fmtPct(used) + '% + 今日配额' +
        (state.precise ? '' : '；* 时间由页面文本推算') +
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

  // 每分钟对齐刷新（倒计时精确到分钟）
  function minuteLoop() {
    var now = new Date();
    var next = now.getTime() - now.getMilliseconds() - now.getSeconds() * 1000 + 60000;
    setTimeout(function () { render(); minuteLoop(); }, next - now.getTime());
  }

  // SPA 路由钩子（Next.js App Router 走 pushState / replaceState）
  ['pushState', 'replaceState'].forEach(function (k) {
    var orig = history[k];
    history[k] = function () { var r = orig.apply(this, arguments); scheduleCheck(); return r; };
  });
  window.addEventListener('popstate', scheduleCheck);

  // DOM 观察器：React 重渲染 / 限额数据原地刷新导致面板丢失时自动重挂
  var checkTimer = null;
  function scheduleCheck() {
    if (checkTimer) return;
    checkTimer = setTimeout(function () {
      checkTimer = null;
      // 仅在面板丢失（路由切换 / React 清空容器）时才补挂，
      // 否则 render() 重绘 innerHTML 会再次触发本观察器，形成循环
      if (!document.getElementById(CFG.PAD_ID)) render();
    }, 200);
  }
  new MutationObserver(scheduleCheck).observe(document.body, { childList: true, subtree: true });

  // 启动：先按 DOM 推算立即渲染兜底，再异步用 API 精确值校准
  render();
  calibrate();
  setInterval(calibrate, CFG.CALIBRATE_MS);
  minuteLoop();
})();
