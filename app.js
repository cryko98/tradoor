/* ============================================================================
   TRADOOR — front end
   Paints the live board, the book and everything the agent says while it works.
   Editable bits live in CONFIG.
============================================================================ */
(function () {
'use strict';

/* --------------------------------------------------------------- CONFIG ----
   X_URL     every X link. Empty leaves them inert and marked "Coming soon".
   BUY_URL   every Buy button. Empty makes them scroll to the token section.
   CONTRACT  fills the contract box and the copy buttons.
--------------------------------------------------------------------------- */
var CONFIG = {
  X_URL:    "",
  BUY_URL:  "",
  CONTRACT: ""
};

var REFRESH_MS = 20000;

var M = window.TradoorMarket;
var A = window.TradoorAgent;
var $ = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

/* ------------------------------------------------------------------ helpers */
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function hhmmss(ts) {
  var d = new Date(ts);
  return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
}
function since(ms) {
  var s = Math.max(0, Math.floor(ms / 1000));
  return pad((s / 3600) | 0) + ':' + pad(((s / 60) | 0) % 60) + ':' + pad(s % 60);
}
function sol(v, d) { return (v || 0).toFixed(d === undefined ? 3 : d); }
function pctStr(v, d) { return (v >= 0 ? '+' : '') + (v * 100).toFixed(d === undefined ? 1 : d) + '%'; }
function cls(v) { return v > 0 ? 'up' : v < 0 ? 'down' : ''; }
function short(a, n) { n = n || 4; return a ? a.slice(0, n) + '…' + a.slice(-n) : '—'; }
function ageStr(h) {
  if (h === null || h === undefined) return '—';
  if (h < 1) return Math.round(h * 60) + 'm';
  if (h < 48) return h.toFixed(1) + 'h';
  return Math.round(h / 24) + 'd';
}
function hueOf(addr) {
  var h = 0;
  for (var i = 0; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) % 360;
  return h;
}
function el(tag, className, text) {
  var e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
function markFor(p, size) {
  var wrap = el('span', 'coin-mark');
  if (size) { wrap.style.width = wrap.style.height = size + 'px'; }
  if (p.image) {
    var img = document.createElement('img');
    img.src = p.image; img.alt = ''; img.loading = 'lazy';
    img.onerror = function () { img.remove(); wrap.textContent = p.symbol.slice(0, 2); };
    wrap.appendChild(img);
  } else {
    wrap.textContent = p.symbol.slice(0, 2);
  }
  wrap.style.background = 'hsl(' + hueOf(p.address || p.symbol) + ',58%,52%)';
  return wrap;
}

/* ------------------------------------------------------------------- toast */
var toastEl, toastTimer;
function toast(msg) {
  toastEl = toastEl || $('#toast');
  toastEl.textContent = msg;
  toastEl.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.classList.remove('is-on'); }, 1700);
}
function copy(text, label) {
  var done = function () { toast((label || 'Copied') + ' · ' + short(text, 6)); };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, done);
  else {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta); done();
  }
}

/* ------------------------------------------------------------------ canvas */
function fit(canvas) {
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return null;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  var ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx: ctx, w: w, h: h };
}
function hexA(hex, a) {
  var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}
function drawSpark(canvas, data, color) {
  var f = fit(canvas); if (!f || !data || data.length < 2) return;
  var ctx = f.ctx, w = f.w, h = f.h;
  var min = Math.min.apply(null, data), max = Math.max.apply(null, data);
  var rng = (max - min) || 1;
  ctx.beginPath();
  for (var i = 0; i < data.length; i++) {
    var x = (i / (data.length - 1)) * w;
    var y = h - 2 - ((data[i] - min) / rng) * (h - 4);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.strokeStyle = color; ctx.lineWidth = 1.25; ctx.lineJoin = 'round'; ctx.stroke();
}
function drawArea(canvas, data, opts) {
  var f = fit(canvas); if (!f || !data || data.length < 2) return;
  var ctx = f.ctx, w = f.w, h = f.h;
  opts = opts || {};
  var padT = 12, padB = 16, padR = opts.padR || 52;
  var min = Math.min.apply(null, data), max = Math.max.apply(null, data);
  if (opts.base !== undefined) { min = Math.min(min, opts.base); max = Math.max(max, opts.base); }
  var rng = (max - min) || Math.abs(max) * 0.02 || 1;
  min -= rng * 0.08; max += rng * 0.08; rng = max - min;
  var X = function (i) { return (i / (data.length - 1)) * (w - padR); };
  var Y = function (v) { return padT + (1 - (v - min) / rng) * (h - padT - padB); };
  var color = opts.color || '#5FE4A8';

  ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 1;
  ctx.font = '9px "JetBrains Mono", monospace';
  ctx.fillStyle = 'rgba(139,153,171,.65)'; ctx.textAlign = 'left';
  for (var g = 0; g <= 3; g++) {
    var v = min + (rng * g) / 3, y = Math.round(Y(v)) + .5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillText(opts.fmt ? opts.fmt(v) : v.toFixed(3), w - padR + 6, y + 3);
  }
  if (opts.base !== undefined) {
    var by = Math.round(Y(opts.base)) + .5;
    ctx.setLineDash([3, 3]); ctx.strokeStyle = 'rgba(139,153,171,.42)';
    ctx.beginPath(); ctx.moveTo(0, by); ctx.lineTo(w - padR, by); ctx.stroke();
    ctx.setLineDash([]);
  }
  var grad = ctx.createLinearGradient(0, padT, 0, h - padB);
  grad.addColorStop(0, hexA(color, .30)); grad.addColorStop(1, hexA(color, 0));
  ctx.beginPath(); ctx.moveTo(0, h - padB);
  for (var i = 0; i < data.length; i++) ctx.lineTo(X(i), Y(data[i]));
  ctx.lineTo(w - padR, h - padB); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  ctx.beginPath();
  for (i = 0; i < data.length; i++) { i ? ctx.lineTo(X(i), Y(data[i])) : ctx.moveTo(X(i), Y(data[i])); }
  ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();

  var lx = X(data.length - 1), ly = Y(data[data.length - 1]);
  ctx.beginPath(); ctx.arc(lx, ly, 2.8, 0, 6.2832); ctx.fillStyle = color; ctx.fill();
  ctx.beginPath(); ctx.arc(lx, ly, 6, 0, 6.2832); ctx.fillStyle = hexA(color, .18); ctx.fill();
}

/* ==========================================================================
   RENDERERS
========================================================================== */
var focusAddr = null, sortMode = 'score', lastLogN = 0, streamFirst = true;
var scanRows = {}, tickerCells = [], lastTxSig = null, lastHistLen = -1;

function ranked() { return A.ranked(); }

function sorted() {
  var list = M.pairs.slice();
  if (sortMode === 'score')       list.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
  else if (sortMode === 'ch5m')   list.sort(function (a, b) { return b.ch.m5 - a.ch.m5; });
  else if (sortMode === 'volume') list.sort(function (a, b) { return b.vol.h1 - a.vol.h1; });
  else if (sortMode === 'new')    list.sort(function (a, b) { return (a.ageHours === null ? 1e9 : a.ageHours) - (b.ageHours === null ? 1e9 : b.ageHours); });
  return list;
}
function heldMap() { var m = {}; A.positions.forEach(function (p) { m[p.address] = p; }); return m; }
function watchMap() { var m = {}; A.watch.forEach(function (w) { m[w.p.address] = w; }); return m; }
function priceSeries(addr, windowMs) {
  return M.seriesFor(addr, windowMs).map(function (pt) { return pt.p; });
}

/* -------------------------------------------------------------- scanner --- */
function buildRow(p) {
  var tr = el('tr');
  var cells = {};
  var mk = function (cn) { var td = el('td', cn); tr.appendChild(td); return td; };

  cells.rank = mk('c-rank');

  var tdCoin = mk('c-coin');
  var cell = el('div', 'coin-cell');
  cell.appendChild(markFor(p));
  var box = el('div');
  box.appendChild(el('b', null, p.symbol));
  box.appendChild(el('i', null, p.name));
  cell.appendChild(box);
  tdCoin.appendChild(cell);

  cells.price = mk('num');
  cells.ch5m  = mk('num');
  cells.ch1h  = mk('num');
  cells.mcap  = mk('num');
  cells.liq   = mk('num');
  cells.age   = mk('num');
  cells.vol   = mk('num');

  var tdSpark = mk('c-spark');
  cells.spark = document.createElement('canvas');
  tdSpark.appendChild(cells.spark);

  var tdScore = mk('num c-score');
  var sc = el('span', 'score-cell');
  cells.scoreBar = el('i');
  var bar = el('span', 'score-bar'); bar.appendChild(cells.scoreBar);
  cells.scoreVal = el('b');
  sc.appendChild(bar); sc.appendChild(cells.scoreVal);
  tdScore.appendChild(sc);

  var tdFlag = mk('c-flag');
  cells.flag = el('span', 'flag');
  tdFlag.appendChild(cells.flag);

  tr.addEventListener('click', function () { setFocus(p.address); });
  return { tr: tr, cells: cells };
}

function renderScan() {
  var body = $('#scanBody');
  var list = sorted(), held = heldMap(), watch = watchMap();
  var seen = {};

  list.forEach(function (p, i) {
    var row = scanRows[p.address];
    if (!row) { row = scanRows[p.address] = buildRow(p); }
    seen[p.address] = 1;
    var q = row.cells;

    q.rank.textContent = i + 1;
    q.price.textContent = '$' + A.fmtPrice(p.priceUsd);
    q.ch5m.textContent = A.sgn(p.ch.m5);
    q.ch5m.className = 'num ' + cls(p.ch.m5);
    q.ch1h.textContent = A.sgn(p.ch.h1);
    q.ch1h.className = 'num ' + cls(p.ch.h1);
    q.mcap.textContent = A.fmtUsd(p.marketCap);
    q.liq.textContent = A.fmtUsd(p.liqUsd);
    q.age.textContent = ageStr(p.ageHours);
    q.vol.textContent = A.fmtUsd(p.vol.h1);

    var s = Math.round(p.score || 0);
    q.scoreVal.textContent = s;
    q.scoreBar.style.width = Math.max(2, s) + '%';
    q.scoreBar.style.background = s >= 66 ? '#5FE4A8' : s >= 45 ? '#FFB55C' : '#4A5768';

    var f = q.flag;
    if (held[p.address])        { f.className = 'flag flag--held';  f.textContent = 'holding'; }
    else if (watch[p.address])  { f.className = 'flag flag--watch'; f.textContent = 'watching'; }
    else if (p.liqUsd < A.RULES.MIN_LIQ_USD) { f.className = 'flag flag--rug'; f.textContent = 'thin LP'; }
    else if (p.ageHours !== null && p.ageHours < 1) { f.className = 'flag flag--new'; f.textContent = 'new'; }
    else if (p.ch.m5 > 3)       { f.className = 'flag flag--new';   f.textContent = 'moving'; }
    else                        { f.className = 'flag'; f.textContent = p.ch.h1 >= 0 ? 'steady' : 'bleeding'; }

    row.tr.className = (p.address === focusAddr ? 'is-focus ' : '') + (held[p.address] ? 'is-held' : '');
    drawSpark(q.spark, priceSeries(p.address, 6 * 3600000), p.ch.h1 >= 0 ? '#5FE4A8' : '#FF5F6D');
    body.appendChild(row.tr);
  });

  Object.keys(scanRows).forEach(function (a) {
    if (!seen[a]) { if (scanRows[a].tr.parentNode) scanRows[a].tr.remove(); delete scanRows[a]; }
  });

  var ago = Math.round((Date.now() - M.updatedAt) / 1000);
  $('#scanFoot').textContent = list.length + ' Solana pairs · DEX Screener · updated ' +
    (ago < 5 ? 'just now' : ago + 's ago') + ' · ' + A.scans + ' scans this session';
}

/* --------------------------------------------------------------- stream --- */
function renderStream() {
  var box = $('#stream'), logs = A.logs, frag = document.createDocumentFragment(), added = 0;
  for (var i = 0; i < logs.length; i++) {
    if (logs[i].n <= lastLogN) continue;
    lastLogN = logs[i].n;
    var line = el('div', 'stream__line k-' + logs[i].kind);
    line.appendChild(el('span', 'stream__t', hhmmss(logs[i].t)));
    line.appendChild(el('span', 'stream__x', logs[i].text));
    if (streamFirst) line.style.animation = 'none';
    frag.appendChild(line); added++;
  }
  if (!added) return;
  box.appendChild(frag);
  while (box.children.length > 240) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
  streamFirst = false;
}

/* ---------------------------------------------------------------- focus --- */
function setFocus(addr) { focusAddr = addr; renderFocus(); renderScan(); }

function renderFocus() {
  var p = M.byAddress[focusAddr];
  if (!p) {
    var r = ranked();
    p = r.length ? r[0].p : M.pairs[0];
    if (!p) return;
    focusAddr = p.address;
  }
  var s = A.score(p);

  var reg = $('#focusRegime');
  reg.textContent = p.dexId || 'solana';
  reg.className = 'chip';

  var markBox = $('#focusMark');
  markBox.innerHTML = '';
  markBox.appendChild(markFor(p, 34));

  $('#focusSymbol').textContent = '$' + p.symbol;
  var nameEl = $('#focusName');
  nameEl.innerHTML = '';
  nameEl.appendChild(document.createTextNode(p.name + ' · '));
  var link = el('a', null, short(p.address, 5));
  link.href = p.url; link.target = '_blank'; link.rel = 'noopener';
  nameEl.appendChild(link);

  $('#focusPrice').textContent = '$' + A.fmtPrice(p.priceUsd);
  var ch = $('#focusChange');
  ch.textContent = '5m ' + A.sgn(p.ch.m5) + ' · 1h ' + A.sgn(p.ch.h1) + ' · 24h ' + A.sgn(p.ch.h24);
  ch.className = cls(p.ch.m5);

  drawArea($('#focusChart'), priceSeries(p.address, 24 * 3600000), {
    color: p.ch.h24 >= 0 ? '#5FE4A8' : '#FF5F6D',
    fmt: function (v) { return '$' + A.fmtPrice(v); },
    padR: 66
  });

  var f = s.f;
  var rows = [
    ['momentum 5m', f.momentum / 26, f.momentum],
    ['trend 1h', f.trend / 14, f.trend],
    ['volume/LP', f.volume / 18, f.volume],
    ['liquidity', f.liquidity / 13, f.liquidity],
    ['buy pressure', f.pressure / 14, f.pressure],
    ['token quality', f.quality / 15, f.quality]
  ];
  var bars = $('#focusBars');
  bars.innerHTML = '';
  rows.forEach(function (rw) {
    var row = el('div', 'bars__row');
    row.appendChild(el('span', null, rw[0]));
    var track = el('em'), fill = el('i');
    fill.style.width = Math.max(0, Math.min(100, rw[1] * 100)).toFixed(0) + '%';
    track.appendChild(fill); row.appendChild(track);
    row.appendChild(el('b', null, rw[2].toFixed(1)));
    bars.appendChild(row);
  });
  var total = el('div', 'bars__row');
  total.appendChild(el('span', null, 'conviction'));
  var t2 = el('em'), f2 = el('i');
  f2.style.width = s.score + '%';
  f2.style.background = s.score >= 66 ? 'linear-gradient(90deg,#5FE4A8,#8DF3C4)' : '#4A5768';
  t2.appendChild(f2); total.appendChild(t2);
  var tb = el('b', null, s.score.toFixed(1));
  if (s.score >= 66) tb.style.color = '#5FE4A8';
  total.appendChild(tb);
  bars.appendChild(total);

  var meta = $('#focusMeta');
  meta.innerHTML = '';
  [
    ['LP ' + A.fmtUsd(p.liqUsd), p.liqUsd >= A.RULES.MIN_LIQ_USD],
    ['MCAP ' + A.fmtUsd(p.marketCap), true],
    ['vol 24h ' + A.fmtUsd(p.vol.h24), p.vol.h24 > 0],
    ['turnover ×' + s.turnover.toFixed(2), s.turnover > 0.3],
    ['buys ' + p.txns.m5.buys + ' / sells ' + p.txns.m5.sells + ' (5m)', s.pressure >= 0.5],
    ['age ' + ageStr(p.ageHours), p.ageHours === null || p.ageHours > 0.25],
    [p.dexId, true],
    [p.socials.length ? p.socials.length + ' socials' : 'no socials', p.socials.length > 0],
    [p.boosts ? 'boosted ×' + p.boosts : 'no boost', p.boosts > 0]
  ].forEach(function (t) { meta.appendChild(el('span', t[1] ? 'ok' : 'bad', t[0])); });

  var links = el('span', 'ok');
  var a = el('a', null, 'open on DEX Screener ↗');
  a.href = p.url; a.target = '_blank'; a.rel = 'noopener';
  links.appendChild(a);
  meta.appendChild(links);
}

/* ------------------------------------------------------------- portfolio -- */
function renderPortfolio(st) {
  var body = $('#pfBody');
  body.innerHTML = '';

  if (!A.positions.length) {
    var tr = el('tr'), td = el('td', 'pf-empty', 'no open positions — the agent is between ideas');
    td.colSpan = 7; tr.appendChild(td); body.appendChild(tr);
  }

  A.positions.forEach(function (pos) {
    var p = M.byAddress[pos.address];
    var mark = p ? p.priceUsd : pos.lastUsd;
    var value = M.toSol(pos.tokens * mark);
    var pnl = value - pos.costSol;
    var pnlPct = mark / pos.entryUsd - 1;
    var tr = el('tr');

    var tdCoin = el('td', 'c-coin');
    var cell = el('div', 'coin-cell');
    cell.appendChild(markFor(pos));
    var box = el('div');
    box.appendChild(el('b', null, pos.symbol));
    box.appendChild(el('i', null, 'in at ' + hhmmss(pos.entryAt).slice(0, 5) + ' UTC'));
    cell.appendChild(box); tdCoin.appendChild(cell); tr.appendChild(tdCoin);

    tr.appendChild(el('td', 'num', A.fmtAmt(pos.tokens)));
    tr.appendChild(el('td', 'num', '$' + A.fmtPrice(pos.entryUsd)));
    tr.appendChild(el('td', 'num', '$' + A.fmtPrice(mark)));
    tr.appendChild(el('td', 'num', sol(value) + ' SOL'));

    var tdPnl = el('td', 'num ' + cls(pnl));
    tdPnl.textContent = (pnl >= 0 ? '+' : '') + sol(pnl) + ' (' + pctStr(pnlPct) + ')';
    tr.appendChild(tdPnl);

    var tdM = el('td', 'c-stop'), m = el('div', 'mgmt');
    m.appendChild(el('span', pos.tp1 ? 'on' : '', 'TP1'));
    m.appendChild(el('span', pos.trail ? 'on' : '', 'TRAIL'));
    var stop = el('span', '', 'STOP');
    stop.title = 'stop loss at $' + A.fmtPrice(pos.entryUsd * (1 + A.RULES.STOP_PCT / 100));
    m.appendChild(stop);
    tdM.appendChild(m); tr.appendChild(tdM);

    body.appendChild(tr);
  });

  $('#pfChip').textContent = sol(st.equity) + ' SOL';

  var eq = A.equity.map(function (e) { return e[1]; });
  eq.push(st.equity);
  if (eq.length < 2) eq.unshift(A.RULES.START_SOL);
  drawArea($('#equityChart'), eq, {
    color: st.pnl >= 0 ? '#5FE4A8' : '#FF5F6D',
    base: A.RULES.START_SOL,
    fmt: function (v) { return v.toFixed(2); },
    padR: 42
  });
}

/* ------------------------------------------------------------- watchlist -- */
function renderWatch() {
  var box = $('#watchList');
  box.innerHTML = '';
  var w = A.watch;
  $('#watchChip').textContent = w.length + ' tracked';
  if (!w.length) { box.appendChild(el('div', 'empty', 'nothing clears the filter right now')); return; }

  w.forEach(function (it) {
    var p = M.byAddress[it.p.address] || it.p;
    var item = el('div', 'watch__item');
    var top = el('div', 'watch__top');
    top.appendChild(markFor(p));
    top.appendChild(el('b', null, '$' + p.symbol));
    var sc = el('span', 'score-cell');
    var bar = el('span', 'score-bar'), fill = el('i');
    var sv = it.score || p.score || 0;
    fill.style.width = Math.max(2, sv) + '%';
    fill.style.background = sv >= 66 ? '#5FE4A8' : '#FFB55C';
    bar.appendChild(fill); sc.appendChild(bar); sc.appendChild(el('b', null, sv.toFixed(0)));
    top.appendChild(sc);
    item.appendChild(top);

    var stats = el('div', 'watch__stats');
    stats.appendChild(el('span', cls(p.ch.m5), '5m ' + A.sgn(p.ch.m5)));
    stats.appendChild(el('span', null, 'LP ' + A.fmtUsd(p.liqUsd)));
    stats.appendChild(el('span', null, 'vol ' + A.fmtUsd(p.vol.h1)));
    item.appendChild(stats);
    item.appendChild(el('div', 'watch__note', '→ ' + it.note));
    item.addEventListener('click', function () { setFocus(p.address); });
    box.appendChild(item);
  });
}

/* --------------------------------------------------------------- tx feed -- */
function renderTx() {
  var box = $('#txList'), txs = A.txs;
  if (!txs.length) {
    if (!box.children.length) box.appendChild(el('div', 'empty', 'no transactions yet this session'));
    return;
  }
  if (txs[0].sig === lastTxSig) return;
  box.innerHTML = '';

  txs.slice(0, 40).forEach(function (t) {
    var row = el('div', 'tx');
    row.appendChild(el('div', 'tx__side ' + t.side.toLowerCase(), t.side));

    var main = el('div', 'tx__main');
    var head = el('b');
    head.textContent = t.side === 'BUY'
      ? sol(t.sol) + ' SOL → ' + A.fmtAmt(t.tokens) + ' ' + t.symbol
      : A.fmtAmt(t.tokens) + ' ' + t.symbol + ' → ' + sol(t.sol) + ' SOL';
    main.appendChild(head);

    var sigLine = el('div', 'tx__sig');
    sigLine.appendChild(el('code', null, short(t.sig, 8)));
    sigLine.appendChild(el('span', null, 'slot ' + t.slot.toLocaleString('en-US')));
    sigLine.appendChild(el('span', null, t.route));
    sigLine.appendChild(el('span', null, 'impact ' + t.impact.toFixed(2) + '%'));
    sigLine.appendChild(el('span', null, 'fee ' + (t.fee + t.priority).toFixed(6)));
    sigLine.appendChild(el('em', null, t.status));
    var cp = el('button', 'tx__copy', 'copy');
    cp.addEventListener('click', function (e) { e.stopPropagation(); copy(t.sig, 'Signature'); });
    sigLine.appendChild(cp);
    main.appendChild(sigLine);
    row.appendChild(main);

    var right = el('div', 'tx__right');
    if (t.pnl === null) {
      right.appendChild(document.createTextNode(hhmmss(t.t)));
      right.appendChild(el('i', null, '$' + A.fmtPrice(t.priceUsd)));
    } else {
      right.appendChild(el('span', cls(t.pnl), (t.pnl >= 0 ? '+' : '') + sol(t.pnl) + ' SOL'));
      right.appendChild(el('i', null, hhmmss(t.t)));
    }
    row.appendChild(right);
    box.appendChild(row);
  });
  lastTxSig = txs[0].sig;
}

function renderHist() {
  var box = $('#histList'), closed = A.closed;
  $('#histChip').textContent = A.nClosed + ' closed';
  if (closed.length === lastHistLen) return;
  lastHistLen = closed.length;
  box.innerHTML = '';
  if (!closed.length) { box.appendChild(el('div', 'empty', 'nothing closed yet')); return; }

  closed.slice().reverse().slice(0, 40).forEach(function (t) {
    var row = el('div', 'hist__item');
    row.appendChild(markFor(t));
    var mid = el('div');
    mid.appendChild(el('b', null, '$' + t.symbol));
    var mins = t.heldMs / 60000;
    mid.appendChild(el('i', null, t.reason + ' · held ' +
      (mins < 60 ? Math.round(mins) + 'm' : (mins / 60).toFixed(1) + 'h') +
      (t.portion < 1 ? ' · partial' : '')));
    row.appendChild(mid);
    var right = el('div', 'hist__pct ' + cls(t.pnl));
    right.textContent = pctStr(t.pct);
    right.appendChild(el('span', null, (t.pnl >= 0 ? '+' : '') + sol(t.pnl) + ' SOL'));
    row.appendChild(right);
    box.appendChild(row);
  });
}

/* --------------------------------------------------------------- header --- */
function renderHeader(st) {
  $('#sbSession').textContent = A.day + ' · ' + since(Date.now() - A.startedAt);
  $('#sbEquity').textContent = sol(st.equity) + ' SOL';
  var pnlEl = $('#sbPnl');
  pnlEl.textContent = (st.pnl >= 0 ? '+' : '') + sol(st.pnl) + ' (' + pctStr(st.pnlPct) + ')';
  pnlEl.className = cls(st.pnl);
  var realEl = $('#sbReal');
  realEl.textContent = (st.realized >= 0 ? '+' : '') + sol(st.realized) + ' SOL';
  realEl.className = cls(st.realized);
  $('#sbOpen').textContent = st.open + ' / ' + A.RULES.MAX_POS;
  $('#sbWin').textContent = st.closed ? (st.winRate * 100).toFixed(0) + '% (' + st.wins + '/' + st.closed + ')' : '—';
  $('#sbDD').textContent = '−' + (st.maxDD * 100).toFixed(1) + '%';
  $('#sbFees').textContent = st.fees.toFixed(4) + ' SOL';
  $('#sbSol').textContent = M.solUsd ? '$' + M.solUsd.toFixed(2) : '—';
  $('#sbBrain').textContent = st.source === 'model' ? (st.model || 'model') : 'built-in scoring';

  $('#agentState').textContent = st.state;
  $('#agentClock').textContent = since(Date.now() - A.startedAt);
  $('#agentEquity').textContent = sol(st.equity);
  var d = $('#agentDelta');
  d.textContent = (st.pnl >= 0 ? '+' : '') + sol(st.pnl) + ' SOL · ' + pctStr(st.pnlPct, 2);
  d.className = 'agent__delta' + (st.pnl < 0 ? ' is-down' : '');
  $('#agentCash').textContent = sol(st.cash);
  $('#agentOpen').textContent = st.open + ' / ' + A.RULES.MAX_POS;
  $('#agentWin').textContent = st.closed ? (st.winRate * 100).toFixed(0) + '%' : '—';
  $('#navEquity').textContent = sol(st.equity) + ' SOL';

  $('#heroTrades').textContent = st.trades;
  $('#heroScans').textContent = st.scans;
  $('#heroUniverse').textContent = M.pairs.length;

  var eq = A.equity.map(function (e) { return e[1]; });
  eq.push(st.equity);
  if (eq.length > 1) drawSpark($('#equitySpark'), eq.slice(-160), st.pnl >= 0 ? '#5FE4A8' : '#FF5F6D');

  $('#brainPulse').textContent = A.brainState;
  var th = $('#brainThesis');
  if (A.thesis) { th.textContent = '“' + A.thesis + '”'; th.style.display = ''; }
  else th.style.display = 'none';
}

/* --------------------------------------------------------------- ticker --- */
function buildTicker() {
  var track = $('#tickerTrack');
  track.innerHTML = '';
  tickerCells = [];
  var coins = M.pairs.slice(0, 22);
  if (!coins.length) return;
  for (var pass = 0; pass < 2; pass++) {
    coins.forEach(function (p) {
      var s = el('span');
      s.appendChild(el('b', null, '$' + p.symbol));
      var i = el('i');
      s.appendChild(i);
      track.appendChild(s);
      tickerCells.push({ addr: p.address, i: i });
    });
  }
}
function renderTicker() {
  tickerCells.forEach(function (t) {
    var p = M.byAddress[t.addr];
    if (!p) return;
    t.i.textContent = A.sgn(p.ch.h1);
    t.i.className = p.ch.h1 >= 0 ? 'up' : 'down';
  });
}

/* -------------------------------------------------------------- archive --- */
function renderArchive() {
  var row = $('#archiveRow');
  row.innerHTML = '';
  if (!A.archive.length) {
    row.appendChild(el('div', 'empty', 'this is the first session on this device — tomorrow it lands here'));
    return;
  }
  A.archive.slice().reverse().slice(0, 7).forEach(function (a) {
    var d = el('div', 'arch');
    d.appendChild(el('div', 'arch__d', a.date));
    d.appendChild(el('div', 'arch__v', a.close.toFixed(2) + ' SOL'));
    d.appendChild(el('div', 'arch__p ' + cls(a.pnlPct), pctStr(a.pnlPct)));
    d.appendChild(el('div', 'arch__m', a.trades + ' transactions · ' + (a.winRate * 100).toFixed(0) + '% win'));
    row.appendChild(d);
  });
}

/* ==========================================================================
   LOOP
========================================================================== */
function renderAll() {
  if (!M.ready) return;
  var st = A.stats();
  renderHeader(st);
  renderScan();
  renderStream();
  renderFocus();
  renderPortfolio(st);
  renderWatch();
  renderTx();
  renderHist();
  renderTicker();
  renderArchive();
}

function cycle() {
  M.pinned = A.positions.map(function (p) { return p.address; });
  return M.refresh().then(function () {
    A.tick();
    if (!tickerCells.length) buildTicker();
    renderAll();
  }).catch(function (e) {
    A.log('risk', 'FEED  market data unavailable (' + (M.error || e) + ') — retrying', null);
    renderStream();
  });
}

/* ------------------------------------------------------------------- boot */
var BOOT_LINES = [
  'connecting to DEX Screener ················ <b>ok</b>',
  'indexing trending Solana pairs ············ <b>ok</b>',
  'restoring paper wallet · 10.000 SOL ······· <b>ok</b>',
  'waking the model on fal.ai ················ <b>ok</b>',
  'risk module · stop −18% / trail 15% ······· <b>armed</b>'
];

function boot() {
  var bootEl = $('#boot'), logEl = $('#bootLog'), barEl = $('#bootBar'), hintEl = $('#bootHint');
  var typed = 0, progress = 0;

  var typer = setInterval(function () {
    if (typed < BOOT_LINES.length) logEl.innerHTML += BOOT_LINES[typed++] + '\n';
    progress = Math.min(92, progress + 14);
    barEl.style.width = progress + '%';
  }, 160);

  A.init();
  $('#walletAddr').textContent = A.wallet || '—';

  cycle().then(function () {
    clearInterval(typer);
    logEl.innerHTML = BOOT_LINES.join('\n') + '\n' +
      'board live · <b>' + M.pairs.length + ' pairs</b> · agent has the wheel\n';
    barEl.style.width = '100%';
    hintEl.textContent = 'handing over to the agent…';
    buildTicker();
    renderAll();
    setTimeout(function () { bootEl.classList.add('is-done'); }, 420);
  }).catch(function (err) {
    clearInterval(typer);
    logEl.innerHTML += '\n<b>feed unavailable</b> — ' + String(err && err.message || err) + '\n';
    hintEl.textContent = 'retrying…';
    setTimeout(boot, 6000);
  });
}

/* ------------------------------------------------------------------ wiring */
function wire() {
  $$('.buy-link').forEach(function (a) {
    if (CONFIG.BUY_URL) { a.href = CONFIG.BUY_URL; a.target = '_blank'; a.rel = 'noopener'; }
    else a.href = '#token';
  });
  $$('.x-link').forEach(function (a) {
    if (CONFIG.X_URL) a.href = CONFIG.X_URL;
    else {
      a.removeAttribute('href'); a.setAttribute('aria-disabled', 'true');
      a.style.opacity = '.45'; a.style.cursor = 'default'; a.title = 'Coming soon';
    }
  });
  $$('[data-ca]').forEach(function (s) { s.textContent = CONFIG.CONTRACT || 'Coming soon'; });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-copy]') : null;
    if (!btn) return;
    if (btn.id === 'walletBtn') { copy($('#walletAddr').textContent, 'Wallet'); return; }
    if (!CONFIG.CONTRACT) { toast('Contract address coming soon'); return; }
    copy(CONFIG.CONTRACT, 'Contract');
  });

  $$('#scanTabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('#scanTabs button').forEach(function (x) { x.classList.remove('is-on'); });
      b.classList.add('is-on');
      sortMode = b.dataset.sort;
      renderScan();
    });
  });

  var burger = $('#burger'), links = $('#navLinks');
  burger.addEventListener('click', function () {
    var open = links.classList.toggle('is-open');
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  $$('#navLinks a').forEach(function (a) {
    a.addEventListener('click', function () {
      links.classList.remove('is-open');
      burger.setAttribute('aria-expanded', 'false');
    });
  });

  $$('.acc__q').forEach(function (q) {
    q.addEventListener('click', function () {
      var item = q.parentElement, open = item.classList.contains('is-open');
      $$('.acc__item').forEach(function (i) {
        i.classList.remove('is-open');
        $('.acc__q', i).setAttribute('aria-expanded', 'false');
      });
      if (!open) { item.classList.add('is-open'); q.setAttribute('aria-expanded', 'true'); }
    });
  });

  var counters = $$('.count');
  if ('IntersectionObserver' in window && counters.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        io.unobserve(en.target);
        var to = +en.target.dataset.to, t0 = performance.now(), dur = 1100;
        (function step(t) {
          var k = Math.min(1, (t - t0) / dur);
          en.target.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))).toLocaleString('en-US');
          if (k < 1) requestAnimationFrame(step);
        })(t0);
      });
    }, { threshold: .4 });
    counters.forEach(function (c) { io.observe(c); });
  }

  $('#year').textContent = new Date().getFullYear();
  $('#walletAddr').textContent = A.wallet || '—';
  window.addEventListener('resize', function () { renderFocus(); });
}

document.addEventListener('DOMContentLoaded', function () {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  wire();
  boot();
  setInterval(cycle, REFRESH_MS);
  setInterval(function () {
    if (!M.ready) return;
    renderHeader(A.stats());
  }, 1000);
});

})();
