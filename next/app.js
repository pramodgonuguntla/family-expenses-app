/* Family Expenses — redesigned app (Sep 2026)
 *
 * How it stays fast and safe:
 *  - Everything the app shows comes from a copy kept on the phone (localStorage),
 *    so it opens instantly. A fresh copy is fetched from the Sheet in the
 *    background and swapped in.
 *  - Saves go into a small outbox on the phone and appear straight away. The
 *    outbox waits 5 seconds (the Undo window), then sends each change to the
 *    Sheet in order. If the phone is offline it keeps retrying. Each change
 *    carries a one-off client_ref so a retry can never write the same row twice.
 */
(function () {
  "use strict";

  var API = window.APPS_SCRIPT_URL;
  var PIN_KEY = "expenses_pin";          // same key as the old app, so no re-entry
  var CACHE_KEY = "fe2_cache";
  var QUEUE_KEY = "fe2_queue";
  var PREF_KEY = "fe2_prefs";
  var UNDO_MS = 5000;

  var GROUP_ORDER = ["Pramod Savings", "Shruthi Savings", "Others", "Pramod Credit", "Shruthi Credit"];
  var GROUP_COLOR = { "Pramod Savings": "#4A86E8", "Shruthi Savings": "#8E63CE", "Others": "#9AA0AC", "Pramod Credit": "#F2994A", "Shruthi Credit": "#E07798" };
  var EXTRA_COLORS = ["#2BB673", "#C2410C", "#0891B2", "#A21CAF", "#65A30D"];
  var INV_ORDER = ["Real Estate", "Equity", "Stocks", "Mutual Funds", "ESOP", "PF", "PPF", "NPS", "FD", "RD", "Gold", "Other"];
  var INV_COLOR = { "Real Estate": "#7C3AED", "Equity": "#2563EB", "Stocks": "#2563EB", "Mutual Funds": "#DC2626", "ESOP": "#DB2777", "PF": "#0891B2", "PPF": "#0D9488", "NPS": "#059669", "FD": "#0284C7", "RD": "#0EA5E9", "Gold": "#D97706", "Other": "#6B7280" };
  var OWNERS = ["Pramod", "Shruthi", "Hanu", "Joint"];
  var CAT_GROUPS = ["Monthly", "Investments", "Business", "Insurance", "Subscriptions", "Donations", "Income", "Other"];
  var NOT_PICKABLE = { "Transfer": 1, "Opening": 1, "To Be Solved": 1, "Uncategorized": 1, "": 1 };
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var MONTH_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  // ---------------------------------------------------------------- state
  var D = load(CACHE_KEY, null);       // server data: accounts, categories, investments, loans, transactions
  var Q = load(QUEUE_KEY, []);         // outbox of pending changes
  var P = load(PREF_KEY, { who: "PG", lastAccount: null });
  var sync = { busy: false, offline: false, error: null, refreshing: false, flushes: 0 };
  var ui = {
    spendYm: null, spendMode: "spend", spendAll: false,
    catSort: "date", catSum: false, catYm: null,
    acctTab: "bank", expanded: {}, openMonths: {},
    fixOpen: null, rec: { acct: null, value: "", result: null },
    add: null
  };
  var memo = null;                     // derived data, rebuilt when D or Q change
  Q.forEach(function (o) { o.inflight = false; });
  var inApp = false;                   // true once we've navigated inside the app (so Back is safe)

  function load(k, dflt) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked: app still works this session */ } }
  function saveQ() { save(QUEUE_KEY, Q); memo = null; }
  function savePrefs() { save(PREF_KEY, P); }

  // ---------------------------------------------------------------- helpers
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function inr(n) { return Math.round(Math.abs(n)).toLocaleString("en-IN"); }
  function fmt(n) { n = Number(n) || 0; return (n < 0 ? "−₹" : "₹") + inr(n); }
  function fmtSigned(n) { n = Number(n) || 0; return (n > 0 ? "+₹" : n < 0 ? "−₹" : "₹") + inr(n); }
  function fmtK(n) { n = Math.abs(n); if (n >= 1e7) return (n / 1e7).toFixed(2) + " Cr"; if (n >= 1e5) return (n / 1e5).toFixed(1) + "L"; if (n >= 1000) return Math.round(n / 1000) + "k"; return String(Math.round(n)); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function todayIso() { var d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function ymOf(iso) { return String(iso || "").slice(0, 7); }
  function curYm() { return todayIso().slice(0, 7); }
  function addYm(ym, n) { var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + n; y += Math.floor(m / 12); m = ((m % 12) + 12) % 12; return y + "-" + pad(m + 1); }
  function ymShort(ym) { return MON[+ym.slice(5, 7) - 1]; }
  function ymLong(ym) { return MONTH_FULL[+ym.slice(5, 7) - 1] + " " + ym.slice(0, 4); }
  function dayMon(iso) { if (!iso) return ""; return +iso.slice(8, 10) + " " + MON[+iso.slice(5, 7) - 1]; }
  function relDay(iso) {
    if (!iso) return "";
    var t = todayIso(); if (iso === t) return "Today";
    var y = new Date(); y.setDate(y.getDate() - 1);
    if (iso === y.getFullYear() + "-" + pad(y.getMonth() + 1) + "-" + pad(y.getDate())) return "Yesterday";
    return dayMon(iso);
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function initials(n) { return String(n || "?").replace(/[^A-Za-z0-9 ]/g, "").trim().slice(0, 2).toUpperCase() || "?"; }
  function catOf(t) { var c = String(t.category || "").trim(); return c || "Uncategorized"; }
  function isUncat(t) { var c = String(t.category || "").trim(); return !c || c === "Uncategorized"; }
  var extraColorIdx = {};
  function groupColor(g) {
    if (GROUP_COLOR[g]) return GROUP_COLOR[g];
    if (!(g in extraColorIdx)) extraColorIdx[g] = Object.keys(extraColorIdx).length;
    return EXTRA_COLORS[extraColorIdx[g] % EXTRA_COLORS.length];
  }
  function icon(name) {
    var p = {
      back: '<path d="M15 6l-6 6 6 6"/>', close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
      search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
      trash: '<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
      plus: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8"/><path d="M8 12h8"/>',
      down: '<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>', check: '<path d="M20 6L9 17l-5-5"/>'
    }[name];
    return '<svg viewBox="0 0 24 24">' + p + "</svg>";
  }

  // ---------------------------------------------------------------- derived data
  // Server data with the outbox applied on top, so pending changes show at once.
  function M() {
    if (memo) return memo;
    var txns = (D && D.transactions ? D.transactions : []).map(function (t) { return Object.assign({}, t); });
    var byKey = {};
    txns.forEach(function (t) { byKey[t.account + "#" + t.id] = t; });
    var delta = {};
    function bump(acc, n) { delta[acc] = (delta[acc] || 0) + n; }
    var cats = (D && D.categories ? D.categories.slice() : []);
    Q.forEach(function (op) {
      var p = op.payload;
      if (op.action === "add_transaction") {
        txns.push({ id: "p-" + op.ref, account: p.account, date: p.date, details: p.details, category: p.category, amount: p.amount, balance: null, pending: true, ref: op.ref });
        bump(p.account, p.amount);
      } else if (op.action === "add_transfer") {
        txns.push({ id: "p-" + op.ref + "-a", account: p.from, date: p.date, details: p.details || ("Transfer to " + p.to), category: "Transfer", amount: -Math.abs(p.amount), balance: null, pending: true, ref: op.ref });
        txns.push({ id: "p-" + op.ref + "-b", account: p.to, date: p.date, details: p.details || ("Transfer from " + p.from), category: "Transfer", amount: Math.abs(p.amount), balance: null, pending: true, ref: op.ref });
        bump(p.from, -Math.abs(p.amount)); bump(p.to, Math.abs(p.amount));
      } else if (op.action === "update_transaction") {
        var t = byKey[p.account + "#" + p.id];
        if (t) { bump(p.account, p.amount - t.amount); Object.assign(t, { date: p.date, details: p.details, category: p.category, amount: p.amount, pending: true, balance: null }); }
      } else if (op.action === "delete_transaction") {
        var d = byKey[p.account + "#" + p.id];
        if (d) { bump(p.account, -d.amount); d._gone = true; }
      } else if (op.action === "add_category") {
        if (!cats.some(function (c) { return c.name === p.name; })) cats.push({ name: p.name, group_name: p.group_name });
      }
    });
    txns = txns.filter(function (t) { return !t._gone; });
    txns.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      if (a.pending !== b.pending) return a.pending ? -1 : 1;
      return (typeof b.id === "number" ? b.id : 1e9) - (typeof a.id === "number" ? a.id : 1e9);
    });
    var accounts = (D && D.accounts ? D.accounts : []).map(function (a) {
      return Object.assign({}, a, { balance: (a.balance || 0) + (delta[a.name] || 0) });
    });
    var lastEntry = {};
    txns.forEach(function (t) { if (t.date && (!lastEntry[t.account] || t.date > lastEntry[t.account])) lastEntry[t.account] = t.date; });
    var inv = D && D.investments ? D.investments : [];
    var loans = D && D.loans ? D.loans : [];
    var bank = 0, cards = 0;
    accounts.forEach(function (a) { if (a.type === "card") cards += a.balance; else bank += a.balance; });
    var invTotal = inv.reduce(function (s, i) { return s + (i.value || 0); }, 0);
    var loanTotal = loans.reduce(function (s, l) { return s + (l.outstanding || 0); }, 0);
    memo = {
      txns: txns, accounts: accounts, cats: cats, inv: inv, loans: loans, lastEntry: lastEntry,
      bank: bank, cards: cards, invTotal: invTotal, loanTotal: loanTotal,
      net: bank + cards + invTotal - loanTotal
    };
    return memo;
  }

  // Month totals, same rule as the old Activity tab: every category is summed
  // NET; "spent" is the sum of categories that come out negative.
  function monthStats(ym) {
    var by = {}, cnt = {};
    M().txns.forEach(function (t) {
      if (ymOf(t.date) !== ym) return;
      var c = catOf(t);
      by[c] = (by[c] || 0) + t.amount; cnt[c] = (cnt[c] || 0) + 1;
    });
    var list = Object.keys(by).map(function (c) { return { name: c, net: by[c], count: cnt[c] }; });
    var spend = list.filter(function (c) { return c.net < -0.5; }).sort(function (a, b) { return a.net - b.net; });
    var income = list.filter(function (c) { return c.net > 0.5; }).sort(function (a, b) { return b.net - a.net; });
    return {
      by: by, spend: spend, income: income,
      spent: spend.reduce(function (s, c) { return s - c.net; }, 0),
      earned: income.reduce(function (s, c) { return s + c.net; }, 0)
    };
  }
  function health() {
    var transfer = 0, tbs = 0, tbsSum = 0, uncat = 0, uncatSum = 0;
    M().txns.forEach(function (t) {
      var c = catOf(t);
      if (c === "Transfer") transfer += t.amount;
      if (c === "To Be Solved") { tbs++; tbsSum += t.amount; }
      if (isUncat(t)) { uncat++; uncatSum += t.amount; }
    });
    return { transfer: transfer, tbs: tbs, tbsSum: tbsSum, uncat: uncat, uncatSum: uncatSum };
  }
  function recentCutoff() { var d = new Date(); d.setDate(d.getDate() - 120); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function topCategories(kind, n) {
    var cut = recentCutoff(), c = {};
    M().txns.forEach(function (t) {
      if (t.date < cut) return;
      var name = catOf(t); if (NOT_PICKABLE[name]) return;
      if (kind === "income" ? t.amount <= 0 : t.amount >= 0) return;
      c[name] = (c[name] || 0) + 1;
    });
    var out = Object.keys(c).sort(function (a, b) { return c[b] - c[a]; }).slice(0, n);
    if (out.length < n) {
      M().cats.forEach(function (x) {
        if (out.length >= n || out.indexOf(x.name) !== -1 || NOT_PICKABLE[x.name]) return;
        if ((kind === "income") === (x.group_name === "Income")) out.push(x.name);
      });
    }
    return out;
  }
  function topAccounts(n) {
    var cut = recentCutoff(), c = {};
    M().txns.forEach(function (t) { if (t.date >= cut) c[t.account] = (c[t.account] || 0) + 1; });
    var names = M().accounts.map(function (a) { return a.name; });
    names.sort(function (a, b) { return (c[b] || 0) - (c[a] || 0); });
    return names.slice(0, n);
  }
  function allCategoryNames() {
    var have = {};
    M().cats.forEach(function (c) { have[c.name] = 1; });
    M().txns.forEach(function (t) { var c = catOf(t); if (c) have[c] = 1; });
    return Object.keys(have).sort(function (a, b) { return a.localeCompare(b); });
  }
  function account(name) { return M().accounts.filter(function (a) { return a.name === name; })[0]; }

  // ---------------------------------------------------------------- network
  function pin() { try { return localStorage.getItem(PIN_KEY) || ""; } catch (e) { return ""; } }
  function apiGet(params) {
    var qs = new URLSearchParams(Object.assign({ pin: pin() }, params));
    return fetch(API + "?" + qs.toString()).then(function (r) { return r.json(); }).then(checkAuth);
  }
  function apiPost(action, payload) {
    return fetch(API, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },   // no CORS preflight against Apps Script
      body: JSON.stringify(Object.assign({ action: action, pin: pin() }, payload))
    }).then(function (r) { return r.json(); }).then(checkAuth);
  }
  function checkAuth(data) {
    if (data && (data.error === "unauthorized" || data.error === "pin_not_configured")) {
      if (data.error === "unauthorized") { try { localStorage.removeItem(PIN_KEY); } catch (e) {} }
      var err = new Error(data.error); err.auth = true; throw err;
    }
    return data;
  }

  function refresh(quiet) {
    if (!API || !pin()) return;
    if (sync.refreshing) return;
    sync.refreshing = true; paintSync();
    var startFlushes = sync.flushes;
    apiGet({ action: "bootstrap", txns: 1 }).then(function (d) {
      sync.refreshing = false;
      if (d.error) throw new Error(d.error);
      if (!d.transactions) throw new Error("The Google side is older than this app. Run deploy.sh.");
      // A change was sent while this was loading: the result may predate it.
      if (sync.flushes !== startFlushes) { refresh(true); return; }
      D = { accounts: d.accounts, categories: d.categories || [], investments: d.investments || [], loans: d.loans || [], transactions: d.transactions, at: Date.now() };
      save(CACHE_KEY, D); memo = null;
      sync.offline = false; sync.error = null;
      render();
    }).catch(function (err) {
      sync.refreshing = false;
      if (err.auth) {
        if (err.message === "pin_not_configured") sync.fatal = "The PIN isn't set up on the Google side (Script Properties → ACCESS_PIN).";
        render(); return;
      }
      if (err instanceof TypeError) sync.offline = true; else sync.error = err.message;
      if (!D) render(); else paintSync();
      if (!quiet && err.message && !(err instanceof TypeError)) toast("Couldn't refresh: " + err.message);
    });
  }

  var flushTimer = null;
  function scheduleFlush(ms) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, ms); }
  function flush() {
    if (sync.busy || !Q.length || !pin()) { paintSync(); return; }
    var op = Q[0];
    var wait = op.readyAt - Date.now();
    if (wait > 0) { scheduleFlush(wait + 50); paintSync(); return; }
    sync.busy = true; op.inflight = true; saveQ(); paintSync();
    apiPost(op.action, Object.assign({ client_ref: op.ref }, op.payload)).then(function (res) {
      sync.busy = false; op.inflight = false;
      if (res && res.error === "busy, try again") { saveQ(); scheduleFlush(3000); return; }
      Q.shift(); sync.flushes++; sync.offline = false;
      if (res && res.error) { toast("Couldn't save to the Sheet: " + res.error); }
      else if (op.action === "delete_transaction") shiftAfterDelete(op.payload.account, op.payload.id);
      saveQ();
      if (Q.length) flush(); else { render(); refresh(true); }
    }).catch(function (err) {
      sync.busy = false; op.inflight = false; saveQ();
      if (err.auth) { render(); return; }
      sync.offline = true; paintSync();
      scheduleFlush(15000);
    });
  }
  // The Sheet closes the gap after a delete, so every later row in that
  // account moves up by one. Mirror that locally and in queued changes.
  function shiftAfterDelete(accountName, rowId) {
    if (D && D.transactions) {
      D.transactions = D.transactions.filter(function (t) { return !(t.account === accountName && t.id === rowId); });
      D.transactions.forEach(function (t) { if (t.account === accountName && typeof t.id === "number" && t.id > rowId) t.id--; });
      save(CACHE_KEY, D);
    }
    Q.forEach(function (o) { if (o.payload.account === accountName && typeof o.payload.id === "number" && o.payload.id > rowId) o.payload.id--; });
    memo = null;
  }
  function enqueue(action, payload, undoLabel) {
    var op = { ref: uid(), action: action, payload: payload, readyAt: Date.now() + UNDO_MS };
    Q.push(op); saveQ();
    scheduleFlush(UNDO_MS + 50);
    if (undoLabel) toast(undoLabel, "Undo", function () { undo(op.ref); });
    return op;
  }
  function undo(ref) {
    var i = -1;
    Q.forEach(function (o, k) { if (o.ref === ref) i = k; });
    if (i === -1 || Q[i].inflight) { toast("Already saved to the Sheet"); return; }
    Q.splice(i, 1); saveQ(); render(); toast("Undone");
  }
  window.addEventListener("online", function () { sync.offline = false; flush(); refresh(true); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) { flush(); refresh(true); } });

  // ---------------------------------------------------------------- toast
  var toastTimer = null;
  function toast(msg, actionLabel, onAction) {
    var el = document.getElementById("toast");
    el.innerHTML = "<span>" + esc(msg) + "</span>" + (actionLabel ? '<button type="button" id="toast-act">' + esc(actionLabel) + "</button>" : "");
    el.hidden = false;
    if (actionLabel) document.getElementById("toast-act").onclick = function () { el.hidden = true; onAction(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, actionLabel ? UNDO_MS : 2200);
  }

  // ---------------------------------------------------------------- routing
  function parseRoute() {
    var h = location.hash.replace(/^#\/?/, "");
    var q = {}, qi = h.indexOf("?");
    if (qi !== -1) { new URLSearchParams(h.slice(qi + 1)).forEach(function (v, k) { q[k] = v; }); h = h.slice(0, qi); }
    var parts = h.split("/").map(decodeURIComponent);
    return { name: parts[0] || "home", arg: parts[1], arg2: parts[2], q: q };
  }
  function go(hash) { location.hash = hash; }
  window.addEventListener("hashchange", function () { inApp = true; closeSheet(); ui.add = null; render(); window.scrollTo(0, 0); });

  function render() {
    var view = document.getElementById("view");
    var nav = document.getElementById("nav");
    if (!API) { view.innerHTML = '<div class="loading">config.js is missing the Apps Script URL.</div>'; return; }
    if (!pin()) { nav.hidden = true; view.innerHTML = pinView(); bindPin(); return; }
    if (!D) {
      nav.hidden = true;
      if (sync.fatal) { view.innerHTML = '<div class="loading">' + esc(sync.fatal) + '</div>'; return; }
      if (sync.offline || sync.error) { view.innerHTML = '<div class="loading">Couldn\'t load your data' + (sync.offline ? " — no connection." : ": " + esc(sync.error)) + '<br><br><button type="button" class="btn small" data-act="refresh">Try again</button></div>'; return; }
      view.innerHTML = '<div class="loading">Loading your data for the first time…</div>';
      if (!sync.refreshing) refresh();
      return;
    }
    var r = parseRoute();
    var screens = { home: homeView, spending: spendingView, cat: categoryView, fix: fixView, accounts: accountsView, acct: accountView, reconcile: reconcileView, add: addView, edit: addView };
    var fn = screens[r.name] || homeView;
    var tab = { home: "home", spending: "spending", cat: "spending", fix: "spending", accounts: "accounts", acct: "accounts", reconcile: "home" }[r.name];
    nav.hidden = r.name === "add" || r.name === "edit";
    Array.prototype.forEach.call(nav.querySelectorAll("a"), function (a) { a.classList.toggle("on", a.dataset.tab === tab); });
    view.innerHTML = fn(r);
    paintSync();
  }

  function paintSync() {
    var el = document.getElementById("sync");
    if (!el) return;
    var n = Q.length;
    var cls = "sync", txt = "Synced";
    if (sync.offline && n) { cls += " wait"; txt = "Offline · " + n + " waiting"; }
    else if (sync.offline) { cls += " wait"; txt = "Offline"; }
    else if (n) { cls += " busy"; txt = "Saving " + n + "…"; }
    else if (sync.refreshing) { cls += " busy"; txt = "Updating…"; }
    else if (sync.error) { cls += " wait"; txt = "Tap to retry"; }
    el.className = cls; el.innerHTML = "<i></i>" + esc(txt);
  }

  // ---------------------------------------------------------------- PIN
  function pinView() {
    return '<form class="pin" id="pin-form"><h1>Family Expenses</h1><p class="muted">Enter the access PIN once on this phone.</p>' +
      '<input id="pin-input" type="password" autocomplete="current-password" aria-label="Access PIN" placeholder="PIN" required>' +
      '<button class="btn" type="submit">Continue</button></form>';
  }
  function bindPin() {
    var f = document.getElementById("pin-form");
    f.onsubmit = function (e) {
      e.preventDefault();
      var v = document.getElementById("pin-input").value.trim();
      if (!v) return;
      try { localStorage.setItem(PIN_KEY, v); } catch (err) {}
      render(); refresh(); flush();
    };
  }

  // ---------------------------------------------------------------- home
  function homeView() {
    var m = M(), ym = curYm(), st = monthStats(ym), prev = monthStats(addYm(ym, -1)), h = health();
    var hr = new Date().getHours();
    var greet = hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";
    var now = new Date();
    var dateLine = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][now.getDay()] + ", " + now.getDate() + " " + MONTH_FULL[now.getMonth()];
    var pg = P.who !== "NS";
    var days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    var pct = prev.spent ? Math.round(st.spent / prev.spent * 100) : 0;
    var top = st.spend.slice(0, 4).map(function (c) { return "<span>" + esc(c.name) + "<b>" + fmt(-c.net).replace("−", "") + "</b></span>"; }).join("");
    var recent = m.txns.slice(0, 5).map(txnRow).join("");
    return '' +
      '<div class="greet"><div><div class="d">' + esc(dateLine) + '</div><div class="h">' + greet + ", " + (pg ? "Pramod" : "Shruthi") + '</div></div>' +
      '<div style="display:flex;align-items:center;gap:10px"><button id="sync" class="sync" type="button" data-act="refresh"></button>' +
      '<button type="button" class="badge' + (pg ? "" : " ns") + '" data-act="who" aria-label="Switch name shown">' + (pg ? "PG" : "NS") + "</button></div></div>" +

      '<div class="hero"><div class="l">Net worth</div><div class="big num">' + fmt(m.net) + '</div>' +
      '<div class="tiles">' +
      '<a href="#/accounts"><span>Bank &amp; cash</span><span>' + fmt(m.bank) + "</span></a>" +
      '<a href="#/accounts?tab=inv"><span>Investments</span><span>' + fmt(m.invTotal) + "</span></a>" +
      '<a href="#/accounts"><span>Cards owed</span><span>' + fmt(m.cards) + "</span></a>" +
      '<a href="#/accounts?tab=loans"><span>Loans</span><span>' + fmt(-m.loanTotal) + "</span></a></div></div>" +

      '<a class="card p" href="#/spending" style="display:flex;flex-direction:column;gap:10px;margin-top:12px;color:var(--ink)">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline"><b>' + MONTH_FULL[now.getMonth()] + ' so far</b><span style="font-size:13px;font-weight:600;color:var(--accent)">Details ›</span></div>' +
      '<div style="display:flex;align-items:baseline;gap:8px"><span class="num" style="font-size:30px;font-weight:700">' + fmt(st.spent) + '</span><span class="muted" style="font-size:13px">spent</span></div>' +
      (prev.spent ? '<div class="bar"><i style="width:' + Math.min(100, pct) + '%"></i></div><span class="muted" style="font-size:13px">' + pct + "% of " + MONTH_FULL[now.getMonth() === 0 ? 11 : now.getMonth() - 1] + "'s " + fmt(prev.spent) + " · day " + now.getDate() + " of " + days + "</span>" : "") +
      (top ? '<div class="kv">' + top + "</div>" : "") + "</a>" +

      (h.uncat ? '<div class="label">Needs your attention</div>' +
        '<a class="card row" href="#/fix" style="margin-top:0"><span class="cnt">' + h.uncat + '</span><span class="grow"><span class="t">Entries without a category</span><span class="s">Tap to sort them in one go</span></span><span class="chev">›</span></a>' : "") +

      '<a class="card p" href="#/reconcile" style="display:flex;flex-direction:column;gap:12px;margin-top:12px;color:var(--ink)">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline"><b>Reconcile</b><span style="font-size:13px;font-weight:600;color:var(--accent)">Open ›</span></div>' +
      '<div class="stat3">' +
      '<div class="' + (h.tbs ? "" : "ok") + '"><b>' + h.tbs + "</b><span>To Be Solved</span></div>" +
      '<div class="' + (Math.abs(h.transfer) < 1 ? "ok" : "") + '"><b class="num">' + "₹" + fmtK(h.transfer) + "</b><span>transfers net</span></div>" +
      '<div class="' + (h.uncat ? "" : "ok") + '"><b>' + h.uncat + "</b><span>no category</span></div></div></a>" +

      '<div class="label">Latest entries<a href="#/spending">See all</a></div>' +
      '<div class="card list">' + (recent || '<div class="empty">No entries yet</div>') + "</div>";
  }

  function txnRow(t, opts) {
    opts = opts || {};
    var amtCls = t.amount > 0 ? "pos" : "";
    var sub = opts.noAccount ? catOf(t) : catOf(t) + " · " + t.account;
    sub += " · " + relDay(t.date);
    var right = '<span class="amt ' + amtCls + '">' + fmtSigned(t.amount).replace(/^\+₹/, "+₹") +
      (t.pending ? '<small class="pending">Waiting to sync</small>' : opts.balance ? "<small>Bal " + fmt(t.balance) + "</small>" : "") + "</span>";
    return '<button type="button" class="row" data-act="edit" data-acc="' + esc(t.account) + '" data-id="' + esc(t.id) + '">' +
      '<span class="av' + (t.amount > 0 ? " wallet" : "") + '">' + esc(initials(catOf(t))) + "</span>" +
      '<span class="grow"><span class="t">' + esc(t.details || catOf(t)) + '</span><span class="s">' + esc(sub) + "</span></span>" + right + "</button>";
  }

  // ---------------------------------------------------------------- spending
  function spendingView() {
    var cur = curYm();
    var ym = ui.spendYm || cur;
    var end = ym > addYm(cur, -6) ? cur : addYm(ym, 5);
    var months = []; for (var i = 5; i >= 0; i--) months.push(addYm(end, -i));
    var totals = months.map(function (x) { return monthStats(x).spent; });
    var max = Math.max.apply(null, totals.concat([1]));
    var st = monthStats(ym), prev = monthStats(addYm(ym, -1));
    var h = health();
    var isSpend = ui.spendMode === "spend";
    var list = isSpend ? st.spend : st.income;
    var prevBy = prev.by;
    var shown = ui.spendAll ? list : list.slice(0, 10);
    var top = list.length ? Math.abs(list[0].net) : 1;
    var rows = shown.map(function (c) {
      var a = Math.abs(c.net), p = Math.abs(prevBy[c.name] || 0), d = a - p, dl = "", cls = "";
      if (p && Math.abs(d) >= 1) { dl = (d > 0 ? "▲ " : "▼ ") + "₹" + inr(d); cls = (d > 0) === isSpend ? "up" : "down"; }
      else if (p) dl = "same";
      return '<a class="catrow" href="#/cat/' + encodeURIComponent(c.name) + "?ym=" + ym + '"><span class="top"><span class="n">' + esc(c.name) + '</span><span class="a">₹' + inr(a) + '</span><span class="dl ' + cls + '">' + dl + "</span></span>" +
        '<span class="bar thin"><i style="width:' + Math.max(2, Math.round(a / top * 100)) + "%;background:" + (c.name === "Uncategorized" ? "#D9A441" : isSpend ? "var(--accent)" : "var(--ok)") + '"></i></span></a>';
    }).join("");
    var compare = prev.spent ? ymLong(addYm(ym, -1)).split(" ")[0] + " was " + fmt(prev.spent) + " · " + (st.spent <= prev.spent ? Math.round((1 - st.spent / prev.spent) * 100) + "% lower" : Math.round((st.spent / prev.spent - 1) * 100) + "% higher") : "";
    return '' +
      '<div class="head"><h1>Spending</h1><button type="button" class="pill-btn" data-act="allcats">' + icon("search") + "All categories</button></div>" +
      '<div class="mswitch"><button type="button" data-act="month" data-d="-1" aria-label="Previous month">‹</button><b>' + ymLong(ym) + '</b><button type="button" data-act="month" data-d="1" aria-label="Next month"' + (ym >= cur ? " disabled" : "") + ">›</button></div>" +
      '<div class="card p" style="margin-top:12px;display:flex;flex-direction:column;gap:12px">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-end"><div><div class="muted" style="font-size:13px">Spent</div><div class="num" style="font-size:32px;font-weight:700">' + fmt(st.spent) + "</div></div>" +
      '<div style="text-align:right"><div class="muted" style="font-size:13px">Income</div><div class="num pos" style="font-size:18px;font-weight:700">' + fmtSigned(st.earned) + "</div></div></div>" +
      (compare ? '<span class="muted" style="font-size:13px">' + compare + "</span>" : "") +
      '<div class="bars">' + months.map(function (x, k) {
        return '<button type="button" data-act="pickmonth" data-ym="' + x + '" class="' + (x === ym ? "on" : "") + '" aria-label="' + ymLong(x) + '"><span class="v">' + fmtK(totals[k]) + '</span><span class="b" style="height:' + Math.round(totals[k] / max * 78) + 'px"></span><span class="m">' + ymShort(x) + "</span></button>";
      }).join("") + "</div></div>" +
      '<div class="pad" style="margin-top:14px"><div class="seg"><button type="button" data-act="mode" data-m="spend" class="' + (isSpend ? "on" : "") + '">Spend</button><button type="button" data-act="mode" data-m="income" class="' + (isSpend ? "" : "on") + '">Income</button></div></div>' +
      (isSpend && h.uncat ? '<a class="warnrow" href="#/fix"><span>' + h.uncat + (h.uncat === 1 ? " entry" : " entries") + " without a category</span>Fix ›</a>" : "") +
      '<div class="card list" style="margin-top:12px">' + (rows || '<div class="empty">Nothing recorded in ' + ymLong(ym) + "</div>") +
      (list.length > 10 ? '<button type="button" class="more-btn" data-act="spendall">' + (ui.spendAll ? "Show fewer" : "Show " + (list.length - 10) + " more") + "</button>" : "") + "</div>";
  }

  function allCatsSheet(filter) {
    var ym = curYm(), st = monthStats(ym), f = (filter || "").toLowerCase();
    var last = {};
    M().txns.forEach(function (t) { var c = catOf(t); if (!last[c] || t.date > last[c].date) last[c] = t; });
    var names = allCategoryNames().filter(function (n) { return !f || n.toLowerCase().indexOf(f) !== -1; });
    var rows = names.map(function (n) {
      var v = st.by[n];
      var sub = v ? "This month" : last[n] ? "Nothing this month · last " + dayMon(last[n].date) : "Never used";
      return '<a class="row" href="#/cat/' + encodeURIComponent(n) + '"><span class="grow"><span class="t">' + esc(n) + '</span><span class="s">' + esc(sub) + '</span></span><span class="amt' + (v ? "" : " muted") + '">' + (v ? "₹" + inr(v) : "—") + '</span><span class="chev">›</span></a>';
    }).join("");
    return '<div class="sheet"><div class="sheet-h"><b>All categories</b><button type="button" class="icon-btn" data-act="closesheet" aria-label="Close">' + icon("close") + "</button></div>" +
      '<div class="sheet-body"><input class="search" id="cat-search" type="search" placeholder="Search categories" aria-label="Search categories" value="' + esc(filter || "") + '">' +
      '<span class="muted" style="font-size:12px">Includes categories with nothing this month. Tap one for its month-by-month view.</span>' +
      '<div class="plain-list" id="cat-list">' + (rows || '<div class="empty">No match</div>') + "</div></div></div>";
  }

  // ---------------------------------------------------------------- category detail
  function categoryView(r) {
    var name = r.arg || "";
    var all = M().txns.filter(function (t) { return catOf(t) === name; });
    var cur = curYm();
    var ym = r.q.ym || ui.catYm;
    if (!ym) { ym = cur; if (!all.some(function (t) { return ymOf(t.date) === cur; }) && all.length) ym = ymOf(all[0].date); }
    var end = ym > addYm(cur, -6) ? cur : addYm(ym, 5);
    var months = []; for (var i = 5; i >= 0; i--) months.push(addYm(end, -i));
    var vals = months.map(function (x) { return Math.abs(all.filter(function (t) { return ymOf(t.date) === x; }).reduce(function (s, t) { return s + t.amount; }, 0)); });
    var max = Math.max.apply(null, vals.concat([1]));
    var avg = vals.reduce(function (s, v) { return s + v; }, 0) / 6;
    var list = all.filter(function (t) { return ymOf(t.date) === ym; });
    var net = list.reduce(function (s, t) { return s + t.amount; }, 0);
    var rows;
    if (ui.catSum) {
      var g = {}, order = [];
      list.forEach(function (t) { var k = (t.details || "").trim().toLowerCase() || "(no detail)"; if (!g[k]) { g[k] = { d: (t.details || "").trim() || "(no detail)", n: 0, a: 0 }; order.push(k); } g[k].n++; g[k].a += t.amount; });
      rows = order.map(function (k) { return g[k]; }).sort(function (a, b) { return Math.abs(b.a) - Math.abs(a.a); }).map(function (x) {
        return '<div class="row"><span class="grow"><span class="t">' + esc(x.d) + '</span><span class="s">' + x.n + (x.n === 1 ? " entry" : " entries") + '</span></span><span class="amt">' + fmtSigned(x.a) + "</span></div>";
      }).join("");
    } else {
      if (ui.catSort === "value") list = list.slice().sort(function (a, b) { return Math.abs(b.amount) - Math.abs(a.amount); });
      rows = list.map(function (t) { return txnRow(t); }).join("");
    }
    return '' +
      '<div class="pad" style="padding-top:12px"><a class="back" href="#/spending">' + icon("back") + "Spending</a></div>" +
      '<div style="padding:4px 20px 0"><h1 style="margin:0;font-size:24px">' + esc(name) + '</h1><div class="muted" style="font-size:14px">' + ymLong(ym) + ' · <b class="num" style="color:var(--ink)">' + fmt(Math.abs(net)) + "</b> · " + list.length + (list.length === 1 ? " entry" : " entries") + "</div></div>" +
      '<div class="card p" style="margin-top:14px;display:flex;flex-direction:column;gap:10px"><span class="muted" style="font-size:13px">Last 6 months · average ' + fmt(avg) + "</span>" +
      '<div class="bars" style="height:100px">' + months.map(function (x, k) {
        return '<button type="button" style="height:100px" data-act="catmonth" data-ym="' + x + '" class="' + (x === ym ? "on" : "") + '" aria-label="' + ymLong(x) + '"><span class="v">' + fmtK(vals[k]) + '</span><span class="b" style="height:' + Math.round(vals[k] / max * 60) + 'px"></span><span class="m">' + ymShort(x) + "</span></button>";
      }).join("") + "</div></div>" +
      '<div class="pad" style="margin-top:16px;display:flex;gap:8px;align-items:center"><div class="seg" style="flex:none">' +
      '<button type="button" data-act="catsort" data-s="date" class="' + (!ui.catSum && ui.catSort === "date" ? "on" : "") + '">Date</button>' +
      '<button type="button" data-act="catsort" data-s="value" class="' + (!ui.catSum && ui.catSort === "value" ? "on" : "") + '">Value</button></div><span style="flex:1"></span>' +
      '<button type="button" class="chip' + (ui.catSum ? " on" : "") + '" style="height:44px" data-act="catsum">Σ Sum</button></div>' +
      '<div class="card list" style="margin-top:10px">' + (rows || '<div class="empty">Nothing in ' + ymLong(ym) + "</div>") + "</div>";
  }

  // ---------------------------------------------------------------- fix categories
  function fixView() {
    var list = M().txns.filter(isUncat);
    if (!ui.fixOpen && list[0]) ui.fixOpen = list[0].account + "#" + list[0].id;
    var choices = topCategories("spend", 8);
    var rows = list.map(function (t) {
      var key = t.account + "#" + t.id, open = ui.fixOpen === key;
      return '<div><button type="button" class="row" data-act="fixopen" data-key="' + esc(key) + '"><span class="grow"><span class="t">' + esc(t.details || "(no detail)") + '</span><span class="s">' + esc(dayMon(t.date) + " · " + t.account) + '</span></span><span class="amt">' + fmtSigned(t.amount) + (t.pending ? '<small class="pending">Waiting to sync</small>' : "") + "</span></button>" +
        (open ? '<div class="chips" style="padding:4px 14px 14px">' + choices.map(function (c) { return '<button type="button" class="chip" data-act="fixpick" data-acc="' + esc(t.account) + '" data-id="' + esc(t.id) + '" data-cat="' + esc(c) + '">' + esc(c) + "</button>"; }).join("") +
          '<button type="button" class="chip more" data-act="catpicker" data-for="fix" data-acc="' + esc(t.account) + '" data-id="' + esc(t.id) + '">All…</button></div>' : "") + "</div>";
    }).join("");
    return '' +
      '<div class="pad" style="padding-top:12px;display:flex;justify-content:space-between"><a class="back" href="#/spending">' + icon("back") + 'Back</a><a class="back" href="#/home" style="font-weight:700">Done</a></div>' +
      '<div style="padding:4px 20px 0"><h1 style="margin:0;font-size:24px">Without a category</h1><div class="muted" style="font-size:14px">' + (list.length ? list.length + " left · tap an entry, then a category" : "All sorted") + "</div></div>" +
      '<div class="card list" style="margin-top:14px">' + (rows || '<div class="empty">Nothing to fix</div>') + "</div>";
  }

  // ---------------------------------------------------------------- accounts
  function accountsView(r) {
    if (r.q.tab) { ui.acctTab = r.q.tab; }
    var m = M(), tab = ui.acctTab;
    var add = tab === "bank" ? '<button type="button" class="pill-btn" data-act="newacct">+ Add account</button>' : tab === "inv" ? '<button type="button" class="pill-btn" data-act="newinv">+ Add investment</button>' : "";
    var body = "";
    if (tab === "bank") {
      var groups = {}, order = GROUP_ORDER.slice();
      m.accounts.forEach(function (a) { var g = a.bucket || "Others"; (groups[g] = groups[g] || []).push(a); if (order.indexOf(g) === -1) order.push(g); });
      body = order.filter(function (g) { return groups[g]; }).map(function (g) {
        var accs = groups[g], total = accs.reduce(function (s, a) { return s + a.balance; }, 0);
        accs.sort(function (a, b) { return Math.abs(b.balance) - Math.abs(a.balance); });
        var limit = ui.expanded[g] ? accs.length : 5;
        var rows = accs.slice(0, limit).map(function (a) {
          var le = m.lastEntry[a.name];
          return '<a class="row" href="#/acct/' + encodeURIComponent(a.name) + '"><span class="av' + (a.type === "card" ? " cc" : a.type === "wallet" ? " wallet" : "") + '">' + esc(initials(a.name)) + '</span><span class="grow"><span class="t">' + esc(a.name) + '</span><span class="s">' + (le ? "Last entry " + relDay(le) : "No entries yet") + '</span></span><span class="amt' + (a.balance < 0 ? " neg" : "") + '">' + fmt(a.balance) + '</span><span class="chev">›</span></a>';
        }).join("");
        var more = accs.length > 5 ? '<button type="button" class="more-btn" data-act="expand" data-g="' + esc(g) + '">' + (ui.expanded[g] ? "Show fewer" : "Show " + (accs.length - 5) + " more") + "</button>" : "";
        return '<div class="grp"><div class="grp-h"><i style="background:' + groupColor(g) + '"></i><span>' + esc(g) + '</span><b class="' + (total < 0 ? "neg" : "") + '">' + fmt(total) + '</b></div><div class="card list">' + rows + more + "</div></div>";
      }).join("");
    } else if (tab === "inv") {
      var inv = m.inv.slice().sort(function (a, b) {
        var ia = INV_ORDER.indexOf(a.category), ib = INV_ORDER.indexOf(b.category);
        ia = ia === -1 ? 99 : ia; ib = ib === -1 ? 99 : ib;
        return ia !== ib ? ia - ib : b.value - a.value;
      });
      body = '<div class="card list" style="margin-top:18px">' + (inv.map(function (i) {
        return '<button type="button" class="row" data-act="editinv" data-id="' + i.id + '"><span class="stripe" style="background:' + (INV_COLOR[i.category] || INV_COLOR.Other) + '"></span><span class="grow"><span class="t">' + esc(i.name) + '</span><span class="s">' + esc(i.category + (i.owner ? " · " + i.owner : "")) + '</span></span><span class="amt">' + fmt(i.value) + '</span><span class="chev">›</span></button>';
      }).join("") || '<div class="empty">No investments yet</div>') + "</div>" +
        '<div class="muted" style="font-size:13px;padding:10px 20px">Total ' + fmt(m.invTotal) + "</div>";
    } else {
      body = m.loans.map(function (l) {
        var lp = l.last_payment;
        return '<div class="card loan" style="margin-top:18px"><div style="display:flex;justify-content:space-between;align-items:baseline"><b style="font-size:16px">' + esc(l.name) + '</b><span class="muted" style="font-size:13px">' + (l.entries || 0) + ' entries</span></div>' +
          '<div><div class="muted" style="font-size:12px">Outstanding</div><div class="num neg" style="font-size:28px;font-weight:700">' + fmt(-l.outstanding) + "</div></div>" +
          (l.borrowed ? '<div class="bar"><i style="width:' + Math.max(0, Math.min(100, l.repaid_pct || 0)) + '%"></i></div><span class="muted" style="font-size:13px"><b style="color:var(--ink)">' + (l.repaid_pct || 0) + "% repaid</b> of " + fmt(l.borrowed) + " borrowed</span>" : "") +
          '<div class="two"><div><span>Last payment</span><b>' + (lp ? fmt(lp.amount) : "—") + '</b></div><div><span>Paid on</span><b>' + (lp ? dayMon(lp.date) + " " + lp.date.slice(2, 4) : "—") + "</b></div></div></div>";
      }).join("") || '<div class="empty">No loans in the Loans sheet</div>';
      body += '<div class="muted" style="font-size:13px;padding:10px 20px">Read from the Loans sheet. Add repayments there.</div>';
    }
    return '' +
      '<div class="head" style="align-items:flex-start"><div><h1>Accounts</h1><div class="sub">Net worth <b class="num" style="color:var(--ink)">' + fmt(m.net) + "</b></div></div>" + add + "</div>" +
      '<div class="pad" style="margin-top:14px"><div class="seg">' +
      '<button type="button" data-act="acctab" data-t="bank" class="' + (tab === "bank" ? "on" : "") + '">Bank &amp; cards</button>' +
      '<button type="button" data-act="acctab" data-t="inv" class="' + (tab === "inv" ? "on" : "") + '">Investments</button>' +
      '<button type="button" data-act="acctab" data-t="loans" class="' + (tab === "loans" ? "on" : "") + '">Loans</button></div></div>' + body;
  }

  function accountView(r) {
    var name = r.arg, a = account(name);
    if (!a) return '<div class="pad" style="padding-top:12px"><a class="back" href="#/accounts">' + icon("back") + 'Accounts</a></div><div class="empty">Account not found</div>';
    var txns = M().txns.filter(function (t) { return t.account === name; });
    var ym = curYm(), inM = txns.filter(function (t) { return ymOf(t.date) === ym; });
    var out = inM.filter(function (t) { return t.amount < 0; }).reduce(function (s, t) { return s - t.amount; }, 0);
    var inn = inM.filter(function (t) { return t.amount > 0; }).reduce(function (s, t) { return s + t.amount; }, 0);
    var by = {}, order = [];
    txns.forEach(function (t) { var k = ymOf(t.date); if (!by[k]) { by[k] = []; order.push(k); } by[k].push(t); });
    order.sort().reverse();
    var openKey = function (k, i) { var key = name + "|" + k; return key in ui.openMonths ? ui.openMonths[key] : i === 0; };
    var months = order.map(function (k, i) {
      var list = by[k], net = list.reduce(function (s, t) { return s + t.amount; }, 0), open = openKey(k, i);
      return '<div class="card" style="margin-top:8px;overflow:hidden"><button type="button" class="mhead" data-act="togglemonth" data-key="' + esc(name + "|" + k) + '" data-open="' + (open ? 1 : 0) + '"><span class="muted" style="width:16px;font-size:12px">' + (open ? "▾" : "▸") + '</span><span class="grow"><b>' + ymLong(k) + '</b><span class="muted" style="font-size:12px">' + list.length + (list.length === 1 ? " entry" : " entries") + '</span></span><b class="num' + (net > 0 ? " pos" : "") + '">' + fmtSigned(net) + "</b></button>" +
        (open ? '<div class="list" style="border-top:1px solid var(--line)">' + list.map(function (t) {
          return '<button type="button" class="row" data-act="edit" data-acc="' + esc(t.account) + '" data-id="' + esc(t.id) + '"><span class="day"><b>' + (+String(t.date).slice(8, 10) || "") + "</b><span>" + (t.date ? MON[+t.date.slice(5, 7) - 1] : "") + '</span></span><span class="grow"><span class="t">' + esc(t.details || catOf(t)) + '</span><span class="s" style="color:var(--accent)">' + esc(catOf(t)) + '</span></span><span class="amt' + (t.amount > 0 ? " pos" : "") + '">' + fmtSigned(t.amount) + (t.pending ? '<small class="pending">Waiting to sync</small>' : "<small>Bal " + fmt(t.balance) + "</small>") + "</span></button>";
        }).join("") + "</div>" : "") + "</div>";
    }).join("");
    var typeLabel = { bank: "Bank account", wallet: "Wallet", card: "Credit card" }[a.type] || a.type;
    return '' +
      '<div class="pad" style="padding-top:12px;display:flex;justify-content:space-between;align-items:center"><a class="back" href="#/accounts">' + icon("back") + 'Accounts</a><button type="button" class="pill-btn" data-act="editacct" data-name="' + esc(name) + '">Edit</button></div>' +
      '<div class="card p" style="margin-top:8px;display:flex;flex-direction:column;gap:12px">' +
      '<div style="display:flex;align-items:center;gap:12px"><span class="av' + (a.type === "card" ? " cc" : a.type === "wallet" ? " wallet" : "") + '" style="width:44px;height:44px;font-size:14px">' + esc(initials(name)) + '</span><div><div style="font-size:20px;font-weight:700">' + esc(name) + '</div><div class="muted" style="font-size:13px">' + esc(typeLabel + " · " + (a.bucket || "Others")) + "</div></div></div>" +
      '<div><div class="muted" style="font-size:13px">Balance</div><div class="num' + (a.balance < 0 ? " neg" : "") + '" style="font-size:32px;font-weight:700">' + fmt(a.balance) + "</div></div>" +
      '<div class="two"><div><span>Out in ' + MON[+ym.slice(5, 7) - 1] + "</span><b>" + fmt(out) + '</b></div><div><span>In / credited</span><b class="pos">' + fmtSigned(inn) + "</b></div></div>" +
      '<a class="btn small ghost" href="#/reconcile?acct=' + encodeURIComponent(name) + '" style="align-self:flex-start">Check balance</a></div>' +
      '<div class="label">Entries by month<span style="text-transform:none;letter-spacing:0;font-weight:500;font-size:12px">Balance after each</span></div>' +
      '<div>' + (months || '<div class="empty">No entries yet</div>') + "</div>" +
      '<div class="pad" style="margin-top:16px"><a class="btn ghost" href="#/add?acct=' + encodeURIComponent(name) + '">' + icon("plus") + "Add entry to " + esc(name) + "</a></div>";
  }

  // ---------------------------------------------------------------- reconcile
  function reconcileView(r) {
    var h = health(), m = M(), rec = ui.rec;
    if (r.q.acct && rec.acct !== r.q.acct) { rec.acct = r.q.acct; rec.value = ""; rec.result = null; }
    if (!rec.acct && m.accounts.length) rec.acct = m.accounts[0].name;
    var a = account(rec.acct);
    var isCard = a && a.type === "card";
    var res = "";
    if (rec.result) {
      if (Math.abs(rec.result.diff) < 1) res = '<div class="result ok">✓ Matches the app</div>';
      else res = '<div class="result bad"><span>' + fmt(Math.abs(rec.result.diff)) + " apart — app " + (isCard ? fmt(Math.abs(a.balance)) : fmt(a.balance)) + ", bank " + (isCard ? fmt(Math.abs(rec.result.target)) : fmt(rec.result.target)) + ". An entry may be missing or wrong.</span>" +
        '<div style="display:flex;gap:8px"><a class="btn small ghost" style="flex:1" href="#/acct/' + encodeURIComponent(rec.acct) + '">See entries</a><button type="button" class="btn small warn" style="flex:1" data-act="tbs">Add to To Be Solved</button></div></div>';
    }
    return '' +
      '<div class="pad" style="padding-top:12px"><a class="back" href="#/home">' + icon("back") + "Home</a></div>" +
      '<div style="padding:4px 20px 0"><h1 style="margin:0;font-size:26px">Reconcile</h1><div class="muted" style="font-size:14px">Check the app against your bank, and keep the data clean</div></div>' +
      '<div class="label">Health checks</div><div class="card list">' +
      '<div class="row"><span class="check' + (Math.abs(h.transfer) < 1 ? " ok" : "") + '">' + (Math.abs(h.transfer) < 1 ? "✓" : "!") + '</span><span class="grow"><span class="t">Transfers net to ' + fmt(h.transfer) + '</span><span class="s">' + (Math.abs(h.transfer) < 1 ? "Every transfer out has a matching transfer in" : "Some transfer is missing its other side") + "</span></span></div>" +
      '<a class="row" href="#/cat/To%20Be%20Solved"><span class="check' + (h.tbs ? "" : " ok") + '">' + (h.tbs ? "!" : "✓") + '</span><span class="grow"><span class="t">To Be Solved · ' + h.tbs + (h.tbs === 1 ? " row" : " rows") + '</span><span class="s">' + (h.tbs ? fmt(h.tbsSum) + " of balance gaps not yet explained" : "Nothing unexplained") + "</span></span>" + (h.tbs ? '<span style="font-weight:600">Review</span>' : "") + "</a>" +
      '<a class="row" href="#/fix"><span class="check' + (h.uncat ? "" : " ok") + '">' + (h.uncat ? "!" : "✓") + '</span><span class="grow"><span class="t">' + h.uncat + (h.uncat === 1 ? " entry" : " entries") + ' without a category</span><span class="s">' + (h.uncat ? fmt(h.uncatSum) + " in total" : "All categorised") + "</span></span>" + (h.uncat ? '<span style="font-weight:600">Fix</span>' : "") + "</a></div>" +
      '<div class="label">Check a balance</div><div class="card p" style="display:flex;flex-direction:column;gap:12px">' +
      '<label class="field">Account<select id="rec-acct">' + m.accounts.map(function (x) { return '<option' + (x.name === rec.acct ? " selected" : "") + ">" + esc(x.name) + "</option>"; }).join("") + "</select></label>" +
      (a ? '<div class="muted" style="font-size:13px">App says <b class="num" style="color:var(--ink)">' + (isCard ? fmt(Math.abs(a.balance)) + (a.balance <= 0 ? " owed" : " in credit") : fmt(a.balance)) + "</b></div>" : "") +
      '<label class="field">' + (isCard ? "Amount owed on the card (from the bank app or statement)" : "Balance on the bank app or statement") + '<input id="rec-val" type="text" inputmode="decimal" placeholder="0" value="' + esc(rec.value) + '"></label>' +
      '<button type="button" class="btn" data-act="compare">Compare</button>' + res + "</div>" +
      '<div class="muted" style="font-size:12px;padding:16px 20px">Statements are still imported with the scripts on the Mac.</div>';
  }

  // ---------------------------------------------------------------- add / edit
  function startAdd(r) {
    if (ui.add) return ui.add;
    var s = { kind: "spend", amt: "", details: "", cat: null, acc: null, from: null, to: null, date: todayIso(), edit: null };
    if (r.name === "edit") {
      var t = M().txns.filter(function (x) { return x.account === r.arg && String(x.id) === r.arg2; })[0];
      if (t) {
        s.edit = { account: t.account, id: t.id, pending: !!t.pending, ref: t.ref };
        s.kind = t.amount > 0 ? "income" : "spend";
        if (catOf(t) === "Transfer") s.kind = t.amount > 0 ? "income" : "spend";
        s.amt = String(Math.abs(t.amount)).replace(/\.0+$/, "");
        s.details = t.details || ""; s.cat = catOf(t) === "Uncategorized" ? null : catOf(t);
        s.acc = t.account; s.date = t.date || todayIso();
      }
    }
    var names = M().accounts.map(function (a) { return a.name; });
    if (!s.acc) s.acc = (r.q.acct && names.indexOf(r.q.acct) !== -1) ? r.q.acct : (P.lastAccount && names.indexOf(P.lastAccount) !== -1 ? P.lastAccount : names[0]);
    s.from = s.acc; s.to = names.filter(function (n) { return n !== s.acc; })[0];
    ui.add = s; return s;
  }
  function amtLabel(s) {
    if (!s.amt) return "₹0";
    var p = s.amt.split(".");
    return "₹" + Number(p[0] || 0).toLocaleString("en-IN") + (p.length > 1 ? "." + p[1] : "");
  }
  function saveLabel(s) {
    if (s.edit) return "Save changes";
    var a = amtLabel(s);
    if (s.kind === "transfer") return "Move " + a + (s.from && s.to ? " · " + s.from + " → " + s.to : "");
    return "Save " + a + (s.cat ? " · " + s.cat : "");
  }
  function addView(r) {
    var s = startAdd(r);
    if (r.name === "edit" && !s.edit) return '<div class="add"><div class="add-top"><a class="icon-btn" href="#/home" aria-label="Close">' + icon("close") + '</a></div><div class="empty">That entry has changed or is gone. Go back and open it again.</div></div>';
    var chip = function (on) { return "chip" + (on ? " on" : ""); };
    var kinds = s.edit ? [["spend", "Spend"], ["income", "Income"]] : [["spend", "Spend"], ["income", "Income"], ["transfer", "Transfer"]];
    var cats = topCategories(s.kind === "income" ? "income" : "spend", 8);
    if (s.cat && cats.indexOf(s.cat) === -1) cats.unshift(s.cat);
    var accs = topAccounts(12);
    if (s.acc && accs.indexOf(s.acc) === -1) accs.unshift(s.acc);
    var accChips = function (field, list) {
      return '<div class="chips">' + list.map(function (n) { return '<button type="button" class="' + chip(s[field] === n) + '" data-act="pick" data-f="' + field + '" data-v="' + esc(n) + '">' + esc(n) + "</button>"; }).join("") +
        '<button type="button" class="chip more" data-act="acctpicker" data-f="' + field + '">All…</button></div>';
    };
    var middle = s.kind === "transfer"
      ? '<div class="sec"><span class="k">From</span>' + accChips("from", accs.slice(0, 8)) + '</div><div style="display:flex;justify-content:center;padding-top:8px;color:var(--sub)">' + icon("down") + '</div><div class="sec" style="padding-top:0"><span class="k">To</span>' + accChips("to", accs.slice(0, 8)) + "</div>"
      : '<div class="sec"><span class="k">Category · your most used</span><div class="chips">' + cats.map(function (c) { return '<button type="button" class="' + chip(s.cat === c) + '" data-act="pick" data-f="cat" data-v="' + esc(c) + '">' + esc(c) + "</button>"; }).join("") +
        '<button type="button" class="chip more" data-act="catpicker" data-for="add">All…</button></div></div>' +
        '<div class="sec" style="padding-top:14px"><span class="k">Account · most used</span>' + accChips("acc", accs) + "</div>";
    var d = s.date === todayIso() ? "Today" : dayMon(s.date);
    return '<div class="add">' +
      '<div class="add-top"><button type="button" class="icon-btn" data-act="closeadd" aria-label="Close">' + icon("close") + "</button>" +
      '<div class="seg" style="flex:none">' + kinds.map(function (k) { return '<button type="button" data-act="kind" data-k="' + k[0] + '" class="' + (s.kind === k[0] ? "on" : "") + '">' + k[1] + "</button>"; }).join("") + "</div>" +
      '<label class="datebtn"><span id="date-label">' + d + '</span><input type="date" id="add-date" value="' + s.date + '" aria-label="Date"></label></div>' +
      '<div class="amount"><div class="num" id="amt" style="color:' + (s.kind === "income" ? "var(--ok)" : "var(--ink)") + '">' + amtLabel(s) + "</div>" +
      '<input id="add-details" type="text" placeholder="Details (optional)" aria-label="Details (optional)" value="' + esc(s.details) + '" autocomplete="off"></div>' +
      middle +
      '<div class="keys">' + ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "del"].map(function (k) { return '<button type="button" data-act="key" data-k="' + k + '" aria-label="' + (k === "del" ? "Delete digit" : k) + '">' + (k === "del" ? "⌫" : k) + "</button>"; }).join("") + "</div>" +
      '<div class="add-actions">' + (s.edit ? '<button type="button" class="del-btn" data-act="delete" aria-label="Delete entry">' + icon("trash") + "</button>" : "") +
      '<button type="button" class="btn" id="save-btn" data-act="save">' + esc(saveLabel(s)) + "</button></div></div>";
  }
  function paintAmount() {
    var s = ui.add; if (!s) return;
    var a = document.getElementById("amt"); if (a) a.textContent = amtLabel(s);
    var b = document.getElementById("save-btn"); if (b) b.textContent = saveLabel(s);
  }
  function doSave() {
    var s = ui.add; if (!s) return;
    var amt = Math.abs(parseFloat(s.amt));
    if (!amt) { toast("Enter an amount"); return; }
    var det = (document.getElementById("add-details") || {}).value;
    if (det !== undefined) s.details = det.trim();
    if (s.kind === "transfer") {
      if (!s.from || !s.to || s.from === s.to) { toast("Pick two different accounts"); return; }
      enqueue("add_transfer", { from: s.from, to: s.to, date: s.date, details: s.details || "", amount: amt }, "Transfer saved");
      finishAdd(); return;
    }
    if (!s.acc) { toast("Pick an account"); return; }
    var signed = s.kind === "income" ? amt : -amt;
    var details = s.details || s.cat || (s.kind === "income" ? "Income" : "Expense");
    var payload = { account: s.acc, date: s.date, details: details, category: s.cat || "", amount: signed };
    P.lastAccount = s.acc; savePrefs();
    if (!s.edit) { enqueue("add_transaction", payload, "Saved · " + fmt(amt).replace("−", "") + (s.cat ? " " + s.cat : "")); finishAdd(); return; }
    var e = s.edit;
    if (e.pending) {
      var op = Q.filter(function (o) { return o.ref === e.ref; })[0];
      if (!op || op.inflight || op.action !== "add_transaction") { toast("Still saving that one — try again in a moment"); return; }
      op.payload = payload; saveQ(); toast("Saved"); finishAdd(); return;
    }
    if (e.account !== s.acc) {
      enqueue("delete_transaction", { account: e.account, id: e.id });
      enqueue("add_transaction", payload, "Moved to " + s.acc);
    } else {
      enqueue("update_transaction", Object.assign({ id: e.id }, payload), "Saved");
    }
    finishAdd();
  }
  function doDelete() {
    var s = ui.add; if (!s || !s.edit) return;
    var e = s.edit;
    if (e.pending) {
      var i = -1; Q.forEach(function (o, k) { if (o.ref === e.ref) i = k; });
      if (i === -1 || Q[i].inflight) { toast("Still saving that one — try again in a moment"); return; }
      Q.splice(i, 1); saveQ(); toast("Deleted"); finishAdd(); return;
    }
    enqueue("delete_transaction", { account: e.account, id: e.id }, "Deleted");
    finishAdd();
  }
  function finishAdd() {
    ui.add = null;
    if (inApp) history.back(); else location.replace("#/home");
  }

  // ---------------------------------------------------------------- sheets
  function openSheet(html) { var el = document.getElementById("sheet"); el.innerHTML = html; el.hidden = false; }
  function closeSheet() { var el = document.getElementById("sheet"); el.hidden = true; el.innerHTML = ""; }
  var pickerCtx = null;
  function catPickerSheet(filter) {
    var f = (filter || "").toLowerCase();
    var names = allCategoryNames().filter(function (n) { return !NOT_PICKABLE[n] && (!f || n.toLowerCase().indexOf(f) !== -1); });
    return '<div class="sheet"><div class="sheet-h"><b>Pick a category</b><button type="button" class="icon-btn" data-act="closesheet" aria-label="Close">' + icon("close") + "</button></div>" +
      '<div class="sheet-body"><input class="search" id="picker-search" type="search" placeholder="Search" aria-label="Search categories" value="' + esc(filter || "") + '">' +
      '<div class="plain-list" id="picker-list">' + names.map(function (n) { return '<button type="button" class="row" data-act="pickercat" data-v="' + esc(n) + '"><span class="grow"><span class="t">' + esc(n) + "</span></span></button>"; }).join("") + "</div>" +
      '<div style="display:flex;flex-direction:column;gap:8px;padding-top:8px"><b>New category</b><input class="search" id="newcat-name" placeholder="Name" aria-label="New category name">' +
      '<select class="search" id="newcat-group" aria-label="Group">' + CAT_GROUPS.map(function (g) { return "<option>" + g + "</option>"; }).join("") + "</select>" +
      '<button type="button" class="btn small" data-act="newcat">Add and use it</button></div></div></div>';
  }
  function acctPickerSheet(field) {
    return '<div class="sheet"><div class="sheet-h"><b>Pick an account</b><button type="button" class="icon-btn" data-act="closesheet" aria-label="Close">' + icon("close") + "</button></div>" +
      '<div class="sheet-body"><div class="plain-list">' + M().accounts.map(function (a) { return '<button type="button" class="row" data-act="pickeracct" data-f="' + field + '" data-v="' + esc(a.name) + '"><span class="grow"><span class="t">' + esc(a.name) + '</span><span class="s">' + esc(a.bucket || "") + '</span></span><span class="amt">' + fmt(a.balance) + "</span></button>"; }).join("") + "</div></div></div>";
  }
  function formSheet(title, fields, submitAct, extra) {
    return '<div class="sheet"><div class="sheet-h"><b>' + esc(title) + '</b><button type="button" class="icon-btn" data-act="closesheet" aria-label="Close">' + icon("close") + "</button></div>" +
      '<div class="sheet-body">' + fields + '<button type="button" class="btn" data-act="' + submitAct + '">Save</button>' + (extra || "") +
      '<span class="muted" style="font-size:12px">This saves straight to the Sheet, so it needs a connection.</span></div></div>';
  }
  function sel(id, label, opts, val) { return '<label class="field">' + label + '<select id="' + id + '">' + opts.map(function (o) { return "<option" + (o === val ? " selected" : "") + ">" + esc(o) + "</option>"; }).join("") + "</select></label>"; }
  function inp(id, label, val, type) { return '<label class="field">' + label + '<input id="' + id + '" type="' + (type || "text") + '" value="' + esc(val == null ? "" : val) + '"' + (type === "number" ? ' inputmode="decimal"' : "") + "></label>"; }
  function groupsList() { var g = GROUP_ORDER.slice(); M().accounts.forEach(function (a) { if (a.bucket && g.indexOf(a.bucket) === -1) g.push(a.bucket); }); return g; }
  function direct(action, payload, done) {
    apiPost(action, payload).then(function (res) {
      if (res && res.error) { toast("Couldn't save: " + res.error); return; }
      closeSheet(); toast("Saved"); if (done) done(); refresh(true);
    }).catch(function (err) { toast(err.auth ? "PIN needed again" : "No connection — try again when online"); if (err.auth) render(); });
  }

  // ---------------------------------------------------------------- events
  var actions = {
    refresh: function () { sync.error = null; flush(); refresh(); },
    who: function () { P.who = P.who === "NS" ? "PG" : "NS"; savePrefs(); render(); },
    month: function (el) { var cur = curYm(), ym = addYm(ui.spendYm || cur, +el.dataset.d); if (ym > cur) return; ui.spendYm = ym; ui.spendAll = false; render(); },
    pickmonth: function (el) { ui.spendYm = el.dataset.ym; ui.spendAll = false; render(); },
    mode: function (el) { ui.spendMode = el.dataset.m; ui.spendAll = false; render(); },
    spendall: function () { ui.spendAll = !ui.spendAll; render(); },
    allcats: function () { openSheet(allCatsSheet("")); bindSearch("cat-search", "cat-list", function (v) { return allCatsSheet(v); }); },
    closesheet: function () { closeSheet(); },
    catmonth: function (el) { var r = parseRoute(); history.replaceState(null, "", "#/cat/" + encodeURIComponent(r.arg) + "?ym=" + el.dataset.ym); render(); },
    catsort: function (el) { ui.catSort = el.dataset.s; ui.catSum = false; render(); },
    catsum: function () { ui.catSum = !ui.catSum; render(); },
    fixopen: function (el) { ui.fixOpen = ui.fixOpen === el.dataset.key ? null : el.dataset.key; render(); },
    fixpick: function (el) { setCategory(el.dataset.acc, el.dataset.id, el.dataset.cat); },
    acctab: function (el) { ui.acctTab = el.dataset.t; history.replaceState(null, "", "#/accounts"); render(); },
    expand: function (el) { ui.expanded[el.dataset.g] = !ui.expanded[el.dataset.g]; render(); },
    togglemonth: function (el) { ui.openMonths[el.dataset.key] = el.dataset.open !== "1"; render(); },
    edit: function (el) { go("#/edit/" + encodeURIComponent(el.dataset.acc) + "/" + encodeURIComponent(el.dataset.id)); },
    closeadd: function () { ui.add = null; if (inApp) history.back(); else location.replace("#/home"); },
    kind: function (el) { var s = ui.add; s.kind = el.dataset.k; if (s.kind !== "transfer") { var c = topCategories(s.kind === "income" ? "income" : "spend", 8); if (s.cat && c.indexOf(s.cat) === -1 && !s.edit) s.cat = null; } keepDetails(); render(); },
    pick: function (el) { var s = ui.add; s[el.dataset.f] = el.dataset.v; keepDetails(); render(); },
    key: function (el) {
      var s = ui.add, k = el.dataset.k, a = s.amt;
      if (k === "del") a = a.slice(0, -1);
      else if (k === ".") { if (a.indexOf(".") === -1) a = (a || "0") + "."; }
      else { if (a.indexOf(".") !== -1 && a.split(".")[1].length >= 2) return; if (a.replace(".", "").length >= 10) return; a = (a === "0" ? "" : a) + k; }
      s.amt = a; paintAmount();
    },
    save: function () { doSave(); },
    delete: function () { doDelete(); },
    catpicker: function (el) {
      pickerCtx = { for: el.dataset.for, acc: el.dataset.acc, id: el.dataset.id };
      keepDetails();
      openSheet(catPickerSheet("")); bindSearch("picker-search", "picker-list", function (v) { return catPickerSheet(v); });
    },
    pickercat: function (el) { useCategory(el.dataset.v); },
    newcat: function () {
      var n = (document.getElementById("newcat-name").value || "").trim();
      var g = document.getElementById("newcat-group").value;
      if (!n) { toast("Type a name"); return; }
      if (!allCategoryNames().some(function (x) { return x.toLowerCase() === n.toLowerCase(); })) enqueue("add_category", { name: n, group_name: g });
      useCategory(n);
    },
    acctpicker: function (el) { keepDetails(); openSheet(acctPickerSheet(el.dataset.f)); },
    pickeracct: function (el) { ui.add[el.dataset.f] = el.dataset.v; closeSheet(); render(); },
    compare: function () {
      var rec = ui.rec, a = account(rec.acct);
      rec.value = document.getElementById("rec-val").value;
      var v = parseFloat(String(rec.value).replace(/[₹,\s]/g, ""));
      if (isNaN(v) || !a) { toast("Type the balance first"); return; }
      var target = a.type === "card" ? -Math.abs(v) : v;
      rec.result = { diff: target - a.balance, target: target };
      render();
    },
    tbs: function () {
      var rec = ui.rec; if (!rec.result) return;
      enqueue("add_transaction", { account: rec.acct, date: todayIso(), details: "Balance adjustment", category: "To Be Solved", amount: Math.round(rec.result.diff * 100) / 100 }, "Added to To Be Solved");
      rec.result = null; rec.value = ""; render();
    },
    newacct: function () { openSheet(formSheet("New account", inp("f-name", "Name", "") + sel("f-type", "Type", ["bank", "wallet", "card"], "bank") + sel("f-group", "Group", groupsList(), "Others"), "saveacct")); },
    saveacct: function () {
      var n = document.getElementById("f-name").value.trim(); if (!n) { toast("Type a name"); return; }
      if (account(n)) { toast("That account already exists"); return; }
      direct("add_account", { name: n, type: document.getElementById("f-type").value, bucket: document.getElementById("f-group").value });
    },
    editacct: function (el) {
      var a = account(el.dataset.name); if (!a) return;
      pickerCtx = { acct: a.name };
      openSheet(formSheet("Edit " + a.name, sel("f-type", "Type", ["bank", "wallet", "card"], a.type) + sel("f-group", "Group", groupsList(), a.bucket || "Others"), "updateacct"));
    },
    updateacct: function () { direct("update_account", { name: pickerCtx.acct, type: document.getElementById("f-type").value, bucket: document.getElementById("f-group").value }); },
    newinv: function () { pickerCtx = { inv: null }; openSheet(invForm(null)); },
    editinv: function (el) { var i = M().inv.filter(function (x) { return String(x.id) === el.dataset.id; })[0]; if (!i) return; pickerCtx = { inv: i.id }; openSheet(invForm(i)); },
    saveinv: function () {
      var p = { name: document.getElementById("f-name").value.trim(), owner: document.getElementById("f-owner").value, category: document.getElementById("f-cat").value, value: parseFloat(document.getElementById("f-val").value) || 0 };
      if (!p.name) { toast("Type a name"); return; }
      if (pickerCtx.inv) direct("update_investment", Object.assign({ id: pickerCtx.inv }, p)); else direct("add_investment", p);
    },
    delinv: function () { if (pickerCtx && pickerCtx.inv) direct("delete_investment", { id: pickerCtx.inv }); }
  };
  function invForm(i) {
    return formSheet(i ? "Edit investment" : "New investment",
      inp("f-name", "Name", i ? i.name : "") + sel("f-owner", "Owner", OWNERS.concat(i && i.owner && OWNERS.indexOf(i.owner) === -1 ? [i.owner] : []), i ? i.owner : "Pramod") +
      sel("f-cat", "Category", INV_ORDER.concat(i && INV_ORDER.indexOf(i.category) === -1 ? [i.category] : []), i ? i.category : "Equity") + inp("f-val", "Value (₹)", i ? i.value : "", "number"),
      "saveinv", i ? '<button type="button" class="btn ghost" style="color:var(--neg);border-color:var(--neg)" data-act="delinv">Delete this investment</button>' : "");
  }
  function keepDetails() { var d = document.getElementById("add-details"); if (d && ui.add) ui.add.details = d.value; }
  function useCategory(name) {
    closeSheet();
    if (pickerCtx && pickerCtx.for === "fix") { setCategory(pickerCtx.acc, pickerCtx.id, name); return; }
    if (ui.add) { ui.add.cat = name; render(); }
  }
  function setCategory(acc, id, cat) {
    var t = M().txns.filter(function (x) { return x.account === acc && String(x.id) === String(id); })[0];
    if (!t) return;
    if (t.pending) {
      var op = Q.filter(function (o) { return o.ref === t.ref; })[0];
      if (op && !op.inflight && op.action === "add_transaction") { op.payload.category = cat; saveQ(); }
    } else {
      enqueue("update_transaction", { account: t.account, id: t.id, date: t.date, details: t.details, category: cat, amount: t.amount });
    }
    ui.fixOpen = null;
    var next = M().txns.filter(isUncat)[0];
    if (next) ui.fixOpen = next.account + "#" + next.id;
    render();
  }
  function bindSearch(inputId, listId, builder) {
    var input = document.getElementById(inputId);
    if (!input) return;
    input.addEventListener("input", function () {
      var tmp = document.createElement("div"); tmp.innerHTML = builder(input.value);
      var fresh = tmp.querySelector("#" + listId);
      document.getElementById(listId).innerHTML = fresh ? fresh.innerHTML : "";
    });
  }

  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-act]");
    if (!el) { if (e.target.id === "sheet") closeSheet(); return; }
    var fn = actions[el.dataset.act];
    if (fn) { e.preventDefault(); fn(el); }
  });
  document.addEventListener("change", function (e) {
    if (e.target.id === "add-date" && ui.add) { ui.add.date = e.target.value || todayIso(); keepDetails(); render(); }
    if (e.target.id === "rec-acct") { ui.rec.acct = e.target.value; ui.rec.value = ""; ui.rec.result = null; history.replaceState(null, "", "#/reconcile"); render(); }
  });
  document.addEventListener("input", function (e) { if (e.target.id === "add-details" && ui.add) ui.add.details = e.target.value; });
  // Physical keyboard on the Add screen (desktop): digits, dot, backspace, enter.
  document.addEventListener("keydown", function (e) {
    if (!ui.add || e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    var k = e.key;
    if (/^[0-9.]$/.test(k)) actions.key({ dataset: { k: k } });
    else if (k === "Backspace") actions.key({ dataset: { k: "del" } });
    else if (k === "Enter") doSave();
  });

  // ---------------------------------------------------------------- boot
  render();
  refresh(true);
  if (Q.length) flush();
  if ("serviceWorker" in navigator) window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () {}); });
})();
