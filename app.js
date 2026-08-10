const API = window.APPS_SCRIPT_URL;

// ---------- State ----------
let accountsCache = [];
let categoriesCache = [];
let investmentsCache = [];
let loansCache = [];
let allTxnsCache = []; // all transactions, all accounts -- loaded lazily for Activity/Category tabs
let networthData = { total: 0, accounts_total: 0, investments_total: 0, loans_total: 0 };
let currentGroup = null;
let currentDetailAccount = null; // account object from accountsCache
let currentDetailTxns = [];
let activitySelectedYm = null;
let currentCategoryDetail = null;
let currentCategoryDetailYm = null;

// Fixed account-group (bucket) order + colors, same as before. Any bucket
// name not in here (a group created on the fly) gets a color from the extra
// palette, assigned deterministically by order of first appearance.
const ACCOUNT_GROUP_ORDER = ["Pramod Savings", "Shruthi Savings", "Pramod Credit", "Shruthi Credit", "Others"];
const ACCOUNT_GROUP_COLOR = {
  "Pramod Savings": "#4a86e8",
  "Shruthi Savings": "#8e63ce",
  "Pramod Credit": "#f2994a",
  "Shruthi Credit": "#e07798",
  "Others": "#9aa0ac",
};
const EXTRA_GROUP_PALETTE = ["#2bb673", "#c2410c", "#0891b2", "#a21caf", "#65a30d", "#0284c7", "#d4327c"];

// Category-group icon/color -- keyed by the real Categories sheet's Group
// column (Monthly, Investments, Business, Insurance, Subscriptions,
// Donations, Income, Other), not by individual category. Per-category icons
// aren't signed off yet, so every category borrows its group's icon.
const CATEGORY_GROUP_STYLE = {
  Monthly: { color: "#4a86e8", icon: "🛒" },
  Investments: { color: "#16a765", icon: "📈" },
  Business: { color: "#8e63ce", icon: "💼" },
  Insurance: { color: "#2da2bb", icon: "🛡️" },
  Subscriptions: { color: "#f2994a", icon: "🔁" },
  Donations: { color: "#f691b3", icon: "❤" },
  Income: { color: "#12a86a", icon: "💰" },
  Other: { color: "#9aa0ac", icon: "▫" },
  Uncategorized: { color: "#c2c5cc", icon: "❔" },
  Transfer: { color: "#6b7280", icon: "🔁" },
};
const ACCOUNT_COLOR = { bank: "#4a86e8", wallet: "#16a765", card: "#8e63ce" };

// Investment categories -- a starting set, not exhaustive; "Other" always covers the rest.
const INVESTMENT_ICON = {
  "Gold": { emoji: "🪙", color: "#d97706" },
  "Real Estate": { emoji: "🏠", color: "#7c3aed" },
  "PF": { emoji: "🏛️", color: "#0891b2" },
  "NPS": { emoji: "📈", color: "#059669" },
  "Stocks": { emoji: "📊", color: "#2563eb" },
  "Mutual Funds": { emoji: "💹", color: "#dc2626" },
  "Other": { emoji: "💼", color: "#6b7280" },
};
const INVESTMENT_CATEGORIES = Object.keys(INVESTMENT_ICON);
function investIcon(category) { return INVESTMENT_ICON[category] || INVESTMENT_ICON["Other"]; }

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------- Small helpers ----------
function fmt(n) {
  const v = Number(n || 0);
  const neg = v < 0;
  const abs = Math.abs(Math.round(v));
  return (neg ? "-₹" : "₹") + abs.toLocaleString("en-IN");
}
function fmtShort(n) {
  if (n >= 100000) return "₹" + (n / 100000).toFixed(1) + "L";
  if (n >= 1000) return "₹" + (n / 1000).toFixed(1) + "k";
  return "₹" + Math.round(n);
}
function initials(name) {
  return (name || "?").trim().slice(0, 2).toUpperCase();
}
function todayIso() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function monthKey(dateStr) { return (dateStr || "").slice(0, 7); }
function monthShortLabel(ym) { return MONTH_NAMES[Number(ym.split("-")[1]) - 1]; }
function monthLabelFromYm(ym) {
  const parts = ym.split("-");
  return MONTH_NAMES[Number(parts[1]) - 1] + " " + parts[0];
}
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}
function catIcon(categoryName) {
  const group = categoryGroup(categoryName);
  return CATEGORY_GROUP_STYLE[group] || CATEGORY_GROUP_STYLE.Other;
}
function categoryGroup(name) {
  if (!name) return "Uncategorized";
  if (name === "Transfer") return "Transfer";
  const c = categoriesCache.find((c) => c.name === name);
  return (c && c.group_name) || "Other";
}
function accountGroupList() {
  const seen = new Set(ACCOUNT_GROUP_ORDER);
  const extras = [];
  accountsCache.forEach((a) => {
    const b = a.bucket || "Others";
    if (!seen.has(b)) { seen.add(b); extras.push(b); }
  });
  return [...ACCOUNT_GROUP_ORDER, ...extras];
}
let extraGroupColorIdx = 0;
const assignedExtraColors = {};
function accountGroupColor(name) {
  if (ACCOUNT_GROUP_COLOR[name]) return ACCOUNT_GROUP_COLOR[name];
  if (!assignedExtraColors[name]) {
    assignedExtraColors[name] = EXTRA_GROUP_PALETTE[extraGroupColorIdx % EXTRA_GROUP_PALETTE.length];
    extraGroupColorIdx++;
  }
  return assignedExtraColors[name];
}

// ---------- API ----------
// ---------- Access PIN ----------
// The exec URL alone isn't protection once this is reachable over the public
// internet -- every request carries a PIN that Code.js checks. Asked once per
// device, then cached in localStorage. A stale/wrong PIN clears itself and
// re-prompts rather than failing silently.
const PIN_KEY = "expenses_pin";
function getStoredPin() {
  try { return localStorage.getItem(PIN_KEY) || ""; } catch (err) { return ""; }
}
function setStoredPin(pin) {
  try { localStorage.setItem(PIN_KEY, pin); } catch (err) { /* ignore */ }
}
function ensurePin() {
  let pin = getStoredPin();
  if (!pin) {
    pin = (prompt("Enter access PIN") || "").trim();
    if (pin) setStoredPin(pin);
  }
  return pin;
}

async function apiGet(action, params = {}) {
  if (!API || API.indexOf("PASTE_YOUR") !== -1) {
    toast("Set APPS_SCRIPT_URL in config.js first");
    throw new Error("not configured");
  }
  const pin = ensurePin();
  const qs = new URLSearchParams({ action, pin, ...params });
  const res = await fetch(`${API}?${qs.toString()}`);
  const data = await res.json();
  if (data.error === "unauthorized") return handleUnauthorized(() => apiGet(action, params));
  if (data.error) throw new Error(data.error);
  return data;
}
async function apiPost(action, payload = {}) {
  const pin = ensurePin();
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" }, // avoids CORS preflight against Apps Script
    body: JSON.stringify({ action, pin, ...payload }),
  });
  const data = await res.json();
  if (data.error === "unauthorized") return handleUnauthorized(() => apiPost(action, payload));
  if (data.error) throw new Error(data.error);
  return data;
}
let unauthorizedRetried = false;
function handleUnauthorized(retry) {
  setStoredPin("");
  if (unauthorizedRetried) { unauthorizedRetried = false; throw new Error("Wrong PIN"); }
  unauthorizedRetried = true;
  toast("Wrong PIN, try again");
  return retry().finally(() => { unauthorizedRetried = false; });
}

// ---------- Loaders (cache + DOM select population) ----------
async function loadAccounts() {
  accountsCache = await apiGet("accounts");
  fillAccountSelects();
}
async function loadCategories() {
  categoriesCache = await apiGet("categories");
  fillCategorySelect();
}
async function loadInvestments() { investmentsCache = await apiGet("investments"); }
async function loadLoans() { loansCache = await apiGet("loans"); }
async function loadNetworth() { networthData = await apiGet("networth"); }
async function loadAllTxns() { allTxnsCache = await apiGet("transactions", { limit: 5000 }); }

function fillAccountSelects() {
  ["txn-account", "txn-from-account", "txn-to-account"].forEach((id) => {
    const sel = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = "";
    accountsCache.forEach((a) => {
      const opt = document.createElement("option");
      opt.value = a.name; opt.textContent = a.name;
      sel.appendChild(opt);
    });
    if (prev && accountsCache.some((a) => a.name === prev)) sel.value = prev;
  });
}
function fillCategorySelect() {
  const sel = document.getElementById("txn-category");
  sel.innerHTML = '<option value="">Uncategorized</option>';
  let lastGroup = null, og = null;
  allCategories().forEach((c) => {
    if (c.group_name !== lastGroup) {
      og = document.createElement("optgroup");
      og.label = c.group_name;
      sel.appendChild(og);
      lastGroup = c.group_name;
    }
    const opt = document.createElement("option");
    opt.value = c.name; opt.textContent = c.name;
    og.appendChild(opt);
  });
}

// ---------- Nav / view switching ----------
// Drill-down screens that render their own dark header. The global hero is
// hidden on these so there aren't two stacked gradient blocks.
const DETAIL_VIEWS = [
  "view-group-detail", "view-account-detail", "view-category-detail",
  "view-investments-detail", "view-loans-detail",
];

// fromHistory=true means we're responding to a back gesture, so don't push a
// new entry (that would trap the user in a loop).
function showView(id, fromHistory) {
  const activeNow = document.querySelector(".view.active");
  const alreadyHere = activeNow && activeNow.id === id;

  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === id));
  document.body.classList.toggle("detail-mode", DETAIL_VIEWS.indexOf(id) !== -1);

  // An installed PWA has no browser chrome, so without history entries there is
  // nothing for swipe-back / Android back to pop. Skip the push when we're
  // already on this view, otherwise a refresh re-render stacks duplicates.
  if (!fromHistory && !alreadyHere) {
    try { history.pushState({ view: id }, ""); } catch (err) { /* non-fatal */ }
  }

  window.scrollTo(0, 0);
  updateNetWorthHero();
  if (id === "view-transactions") {
    loadAllTxns().then(() => renderActivity()).catch((err) => toast("Couldn't load activity: " + err.message));
  }
  if (id === "view-summary") {
    Promise.all([loadNetworth(), loadInvestments(), loadLoans()])
      .then(renderSummary)
      .catch((err) => toast("Couldn't load summary: " + err.message));
  }
}

// The top hero is context-sensitive: on Summary (and its Investments/Loans
// drill-downs) it shows true net worth; everywhere else it shows accounts only.
const NETWORTH_VIEWS = ["view-summary", "view-investments-detail", "view-loans-detail"];
function updateNetWorthHero() {
  const activeEl = document.querySelector(".view.active");
  const activeId = activeEl ? activeEl.id : "view-accounts";
  const showNetWorth = NETWORTH_VIEWS.indexOf(activeId) !== -1;
  document.getElementById("hero-label").textContent = showNetWorth ? "Net worth" : "Total balance";
  if (showNetWorth) {
    document.getElementById("networth").textContent = fmt(networthData.total);
    document.getElementById("hero-sub").textContent =
      accountsCache.length + " accounts · " + investmentsCache.length + " investments · " + loansCache.length + " loan" + (loansCache.length === 1 ? "" : "s");
  } else {
    document.getElementById("networth").textContent = fmt(networthData.accounts_total);
    document.getElementById("hero-sub").textContent = accountsCache.length + " account" + (accountsCache.length === 1 ? "" : "s");
  }
}

// ---------- Level 1: group hero cards ----------
function renderGroups() {
  updateNetWorthHero();
  const byGroup = {};
  accountsCache.forEach((a) => { const b = a.bucket || "Others"; (byGroup[b] = byGroup[b] || []).push(a); });

  const list = document.getElementById("group-list");
  list.innerHTML = "";
  accountGroupList().forEach((g) => {
    const accs = byGroup[g] || [];
    if (!accs.length && !ACCOUNT_GROUP_ORDER.includes(g)) return; // don't show empty ad-hoc groups
    const sum = accs.reduce((s, a) => s + a.balance, 0);
    const card = document.createElement("button");
    card.className = "group-hero-card";
    card.onclick = () => openGroupDetail(g);
    card.innerHTML = `
      <div class="group-dot" style="background:${accountGroupColor(g)}"></div>
      <div class="body">
        <div class="g-label">${g}</div>
        <div class="g-amount ${sum < 0 ? "neg" : ""}">${fmt(sum)}</div>
        <div class="g-sub">${accs.length} account${accs.length === 1 ? "" : "s"}</div>
      </div>
      <div class="chev">›</div>
    `;
    list.appendChild(card);
  });

  if (!accountsCache.length) {
    list.innerHTML = '<div class="empty-state">No accounts yet — tap + to add one</div>';
  }

  const ghost = document.createElement("button");
  ghost.type = "button";
  ghost.className = "ghost-card";
  ghost.innerHTML = '<span class="plus">+</span><span>New group</span>';
  ghost.onclick = openNewGroupModal;
  list.appendChild(ghost);
}

// ---------- Level 2: one group's accounts ----------
function openGroupDetail(g) {
  currentGroup = g;
  const accs = accountsCache.filter((a) => (a.bucket || "Others") === g);
  const sum = accs.reduce((s, a) => s + a.balance, 0);
  document.getElementById("group-detail-name").textContent = g;
  const amtEl = document.getElementById("group-detail-amount");
  amtEl.textContent = fmt(sum);
  amtEl.className = "amount" + (sum < 0 ? " neg" : "");

  const list = document.getElementById("group-accounts-list");
  list.innerHTML = "";
  if (!accs.length) {
    list.innerHTML = '<div class="empty-state">No accounts in this group yet.</div>';
  }
  accs.forEach((a) => {
    const row = document.createElement("div");
    row.className = "card";
    const left = document.createElement("div");
    left.className = "left";
    left.innerHTML = `
      <div class="avatar" style="background:${ACCOUNT_COLOR[a.type] || "#9aa0ac"}">${initials(a.name)}</div>
      <div class="text"><div class="name">${a.name}</div><div class="sub">${a.type}</div></div>
    `;
    left.onclick = () => openAccountDetail(a);
    const amt = document.createElement("div");
    amt.className = "amount " + (a.balance < 0 ? "neg" : "pos");
    amt.textContent = fmt(a.balance);
    const editBtn = document.createElement("button");
    editBtn.className = "edit-icon";
    editBtn.textContent = "✎";
    editBtn.onclick = (e) => { e.stopPropagation(); openEditAccountModal(a.name); };
    row.appendChild(left); row.appendChild(amt); row.appendChild(editBtn);
    list.appendChild(row);
  });

  const ghost = document.createElement("button");
  ghost.type = "button";
  ghost.className = "ghost-card";
  ghost.innerHTML = `<span class="plus">+</span><span>New account in ${g}</span>`;
  ghost.onclick = () => openNewAccountModal(g);
  list.appendChild(ghost);

  document.getElementById("account-detail-back").onclick = () => showView("view-group-detail");
  showView("view-group-detail");
}

// ---------- Level 3: account month drill-down ----------
async function openAccountDetail(account) {
  currentDetailAccount = account;
  document.getElementById("detail-account-name").textContent = account.name;
  const balEl = document.getElementById("detail-account-balance");
  balEl.textContent = fmt(account.balance);
  balEl.className = "amount" + (account.balance < 0 ? " neg" : "");
  document.getElementById("detail-months-list").innerHTML = '<div class="empty-state">Loading…</div>';
  document.getElementById("account-detail-back").onclick = () => showView(currentGroup ? "view-group-detail" : "view-accounts");
  showView("view-account-detail");

  try {
    currentDetailTxns = await apiGet("transactions", { account: account.name, limit: 5000 });
    renderAccountDetail();
  } catch (err) {
    document.getElementById("detail-months-list").innerHTML = '<div class="empty-state">Couldn\'t load transactions.</div>';
    toast("Load failed: " + err.message);
  }
}

function renderAccountDetail() {
  const byMonth = {};
  currentDetailTxns.forEach((t) => { const key = monthKey(t.date); (byMonth[key] = byMonth[key] || []).push(t); });
  const months = Object.keys(byMonth).sort().reverse();

  const container = document.getElementById("detail-months-list");
  container.innerHTML = "";
  if (!months.length) {
    container.innerHTML = '<div class="empty-state">No transactions for this account yet</div>';
    return;
  }
  months.forEach((key, i) => {
    const txns = byMonth[key].sort((a, b) => (a.date < b.date ? 1 : -1));
    const net = txns.reduce((s, t) => s + t.amount, 0);

    const card = document.createElement("div");
    card.className = "card month-card" + (i === 0 ? " open" : "");
    card.innerHTML = `
      <div class="left" style="gap:10px;">
        <span class="chev">▸</span>
        <div class="text"><div class="name">${monthLabelFromYm(key)}</div><div class="sub">${txns.length} transaction${txns.length === 1 ? "" : "s"}</div></div>
      </div>
      <div class="amount ${net >= 0 ? "pos" : "neg"}">${fmt(net)}</div>
    `;
    const txnWrap = document.createElement("div");
    txnWrap.className = "month-txns" + (i === 0 ? " open" : "");
    txns.forEach((t) => txnWrap.appendChild(renderTxnRow(t, refreshAccountDetailInPlace)));

    card.onclick = () => { card.classList.toggle("open"); txnWrap.classList.toggle("open"); };
    container.appendChild(card);
    container.appendChild(txnWrap);
  });
}

// Re-renders the currently open account-detail view from currentDetailTxns
// without refetching -- used after a category-only change (amount/account
// unchanged, so balances can't have moved).
function refreshAccountDetailInPlace() { renderAccountDetail(); }

// ---------- Shared transaction row renderer ----------
// Clicking the icon opens the quick categorize sheet; clicking the text opens full edit.
function renderTxnRow(t, onChanged) {
  const icon = catIcon(t.category);
  const row = document.createElement("div");
  row.className = "txn-row";
  row.innerHTML = `
    <div class="cat-icon" style="background:${icon.color}22">${icon.icon}</div>
    <div class="text">
      <div class="name">${t.details}</div>
      <div class="sub">${t.category || "Uncategorized"}${t.account ? " · " + t.account : ""} · ${t.date}</div>
    </div>
    <div class="amount ${t.amount >= 0 ? "pos" : "neg"}">${fmt(t.amount)}</div>
  `;
  row.querySelector(".cat-icon").onclick = (e) => { e.stopPropagation(); openCategoryPicker(t, onChanged); };
  row.querySelector(".text").onclick = () => openTxnEdit(t);
  return row;
}

// ---------- Quick category picker (categorize + add new category) ----------
let currentCategoryTxn = null;
let categoryPickerRefresh = null;

// The Categories sheet only exists to record which GROUP a category belongs to
// (that drives colour + section headers). It is not the source of truth for
// what exists -- a category can arrive via import and never be registered,
// which is how the picker ended up offering just one option. So: union the
// registered list with everything actually in use, and park unregistered ones
// under "Other" until they're given a group.
const GROUP_ORDER = ["Monthly", "Investments", "Business", "Insurance", "Subscriptions",
                     "Donations", "Income", "Transfer", "Other"];

function allCategories() {
  const out = categoriesCache.slice();
  const have = {};
  out.forEach((c) => { have[c.name] = true; });
  const extra = [];
  [allTxnsCache, currentDetailTxns].forEach((list) => {
    (list || []).forEach((t) => {
      const n = (t.category || "").trim();
      if (n && n !== "Uncategorized" && !have[n] && extra.indexOf(n) === -1) extra.push(n);
    });
  });
  extra.sort();
  extra.forEach((n) => out.push({ name: n, group_name: "Other" }));
  out.sort((a, b) => {
    const ga = GROUP_ORDER.indexOf(a.group_name), gb = GROUP_ORDER.indexOf(b.group_name);
    const oa = ga === -1 ? GROUP_ORDER.length : ga, ob = gb === -1 ? GROUP_ORDER.length : gb;
    return oa !== ob ? oa - ob : a.name.localeCompare(b.name);
  });
  return out;
}

function openCategoryPicker(txn, onChanged) {
  currentCategoryTxn = txn;
  categoryPickerRefresh = onChanged;
  document.getElementById("category-txn-details").textContent = `${txn.details} · ${fmt(txn.amount)}`;

  const list = document.getElementById("category-picker-list");
  list.innerHTML = "";
  const noneBtn = document.createElement("button");
  noneBtn.type = "button";
  noneBtn.className = "picker-item";
  noneBtn.innerHTML = `<span class="picker-dot" style="background:${CATEGORY_GROUP_STYLE.Uncategorized.color}"></span>Uncategorized`;
  noneBtn.onclick = () => assignCategory(null);
  list.appendChild(noneBtn);

  let lastGroup = null;
  allCategories().forEach((c) => {
    if (c.group_name !== lastGroup) {
      const lbl = document.createElement("div");
      lbl.className = "picker-group-label";
      lbl.textContent = c.group_name;
      list.appendChild(lbl);
      lastGroup = c.group_name;
    }
    const style = CATEGORY_GROUP_STYLE[c.group_name] || CATEGORY_GROUP_STYLE.Other;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "picker-item";
    btn.innerHTML = `<span class="picker-dot" style="background:${style.color}"></span>${c.name}`;
    btn.onclick = () => assignCategory(c.name);
    list.appendChild(btn);
  });
  document.getElementById("category-modal").classList.add("open");
}
function closeCategoryPicker() {
  document.getElementById("category-modal").classList.remove("open");
  document.getElementById("new-category-name").value = "";
  currentCategoryTxn = null;
}
async function assignCategory(categoryName) {
  const t = currentCategoryTxn;
  if (!t) return;
  try {
    await apiPost("update_transaction", {
      id: t.id, account: t.account, date: t.date, details: t.details,
      category: categoryName, amount: t.amount,
    });
    t.category = categoryName; // patch cached copies in place, no need to refetch (amount/account unchanged)
    toast(categoryName ? `Tagged as ${categoryName}` : "Marked uncategorized");
    const refresh = categoryPickerRefresh;
    closeCategoryPicker();
    if (refresh) refresh();
  } catch (err) {
    toast("Couldn't save category: " + err.message);
  }
}
async function createAndAssignCategory() {
  const name = document.getElementById("new-category-name").value.trim();
  if (!name) return;
  const group = document.getElementById("new-category-group").value;
  try {
    await apiPost("add_category", { name, group_name: group });
    categoriesCache.push({ name, group_name: group });
    fillCategorySelect();
    await assignCategory(name);
  } catch (err) {
    toast("Couldn't add category: " + err.message);
  }
}

// ---------- Activity: category breakdown + trend ----------
function renderActivity(selectedYm) {
  // Every category is summed NET (credits offset debits), so a refund or a
  // settlement coming back reduces that category instead of vanishing. Nothing
  // is filtered out -- Transfer is included too, and should net to ~0; if it
  // doesn't, that's a real data problem worth seeing rather than hiding.
  const all = allTxnsCache;
  const todayYm = todayIso().slice(0, 7);
  const ym = selectedYm || todayYm;
  activitySelectedYm = ym;

  const monthTxns = all.filter((t) => monthKey(t.date) === ym);

  const byCat = {};
  const countByCat = {};
  monthTxns.forEach((t) => {
    const c = t.category || "Uncategorized";
    byCat[c] = (byCat[c] || 0) + t.amount;
    countByCat[c] = (countByCat[c] || 0) + 1;
  });

  const cats = Object.keys(byCat).map((c) => ({ category: c, net: byCat[c], count: countByCat[c] }));
  const spendCats = cats.filter((c) => c.net < 0).sort((a, b) => a.net - b.net);
  const incomeCats = cats.filter((c) => c.net > 0).sort((a, b) => b.net - a.net);
  const zeroCats = cats.filter((c) => c.net === 0).sort((a, b) => b.count - a.count);

  const totalSpend = spendCats.reduce((s, c) => s + Math.abs(c.net), 0);
  const totalIncome = incomeCats.reduce((s, c) => s + c.net, 0);

  document.getElementById("activity-month-label").textContent = monthLabelFromYm(ym);
  document.getElementById("activity-month-total").textContent = fmt(-totalSpend);
  document.getElementById("activity-month-sub").textContent =
    totalIncome > 0
      ? "net spend · " + fmt(totalIncome) + " income"
      : "net spend" + (ym === todayYm ? " this month" : "");

  // Bar widths scale against the largest magnitude on the screen, so spend and
  // income rows stay visually comparable.
  const maxMag = Math.max.apply(null, cats.map((c) => Math.abs(c.net)).concat([1]));

  function fillList(elId, headId, list, emptyMsg) {
    const el = document.getElementById(elId);
    const head = document.getElementById(headId);
    el.innerHTML = "";
    const show = list.length > 0 || !!emptyMsg;
    head.style.display = show ? "" : "none";
    el.style.display = show ? "" : "none";
    if (!list.length) {
      if (emptyMsg) el.innerHTML = `<div class="empty-state">${emptyMsg}</div>`;
      return;
    }
    list.forEach((c) => {
      const icon = catIcon(c.category);
      const pct = Math.max(6, Math.round((Math.abs(c.net) / maxMag) * 100));
      const row = document.createElement("div");
      row.className = "cat-bar-row";
      row.innerHTML = `
        <div class="top">
          <div class="left"><div class="cat-icon" style="background:${icon.color}22">${icon.icon}</div><div class="name">${c.category}</div></div>
          <div class="amount ${c.net < 0 ? "neg" : "pos"}">${fmt(c.net)}</div>
        </div>
        <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${pct}%; background:${c.net > 0 ? "#12a06a" : icon.color}"></div></div>
      `;
      row.onclick = () => openCategoryDetail(c.category);
      el.appendChild(row);
    });
  }

  fillList("activity-category-list", "activity-spend-head", spendCats, `No spend recorded in ${monthLabelFromYm(ym)}.`);
  fillList("activity-income-list", "activity-income-head", incomeCats, null);
  fillList("activity-zero-list", "activity-zero-head", zeroCats, null);

  renderTrendChart(document.getElementById("activity-trend"), all, ym, (clickedYm) => renderActivity(clickedYm));
}

// Renders a 6-month (oldest -> newest) spend trend bar chart from an
// already transfer-excluded flat txn list. Clicking a bar calls onSelect(ym).
function renderTrendChart(container, txns, selectedYm, onSelect) {
  const d0 = new Date(todayIso() + "T00:00:00");
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(d0.getFullYear(), d0.getMonth() - i, 1);
    months.push(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"));
  }
  // Net per month (credits offset debits), matching the category totals.
  const netByYm = {};
  months.forEach((ym) => { netByYm[ym] = 0; });
  txns.forEach((t) => {
    if (netByYm.hasOwnProperty(monthKey(t.date))) netByYm[monthKey(t.date)] += t.amount;
  });
  const totalsByYm = {};
  months.forEach((ym) => { totalsByYm[ym] = Math.abs(netByYm[ym]); });
  const maxTrend = Math.max.apply(null, months.map((ym) => totalsByYm[ym]).concat([1]));

  // With no spend at all, maxTrend falls back to 1 and every bar clamps to the
  // 3px floor -- six stubs under a tall blank card. Show a message instead.
  const grandTotal = months.reduce((s, ym) => s + totalsByYm[ym], 0);
  container.innerHTML = "";
  container.classList.toggle("is-empty", grandTotal === 0);
  if (grandTotal === 0) {
    container.innerHTML = '<div class="trend-empty">No spend in the last 6 months</div>';
    return;
  }

  months.forEach((ym) => {
    const val = totalsByYm[ym];
    const barPx = Math.max(3, Math.round((val / maxTrend) * 82));
    const isSelected = ym === selectedYm;
    const col = document.createElement("div");
    col.className = "trend-col" + (isSelected ? " selected" : "");
    // Net-positive months (income exceeded spend) read green rather than dark.
    const inflow = netByYm[ym] > 0;
    col.innerHTML = `
      <div class="trend-val">${val ? fmtShort(val) : ""}</div>
      <div class="trend-bar-track"><div class="trend-bar${isSelected ? " current" : ""}${inflow ? " inflow" : ""}" style="height:${barPx}px"></div></div>
      <div class="trend-label">${monthShortLabel(ym)}</div>
    `;
    col.onclick = () => { if (onSelect) onSelect(ym); };
    container.appendChild(col);
  });
}

// ---------- Browse-all-categories menu ----------
// The Activity lists only render categories with activity in the selected
// month, so a category that's quiet this month (Transfer netting 0 in Aug)
// is unreachable. This lists every category regardless, and opens each at
// its most recent month with actual activity.
function latestYmWithActivity(category) {
  let best = null;
  allTxnsCache.forEach((t) => {
    if ((t.category || "Uncategorized") !== category) return;
    const ym = monthKey(t.date);
    if (ym && (!best || ym > best)) best = ym;
  });
  return best;
}

// Every month that has data, newest first. The trend chart only reaches back
// 6 months, so this is the only way to get to anything older.
function monthsWithData() {
  const counts = {};
  allTxnsCache.forEach((t) => {
    const ym = monthKey(t.date);
    if (ym) counts[ym] = (counts[ym] || 0) + 1;
  });
  return Object.keys(counts).sort().reverse().map((ym) => ({ ym, count: counts[ym] }));
}

function renderMonthChips() {
  const row = document.getElementById("month-chip-row");
  row.innerHTML = "";
  const months = monthsWithData();
  if (!months.length) {
    row.innerHTML = '<div class="empty-state" style="padding:8px">No data yet.</div>';
    return;
  }
  const current = activitySelectedYm || todayIso().slice(0, 7);
  months.forEach((m) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "month-chip" + (m.ym === current ? " active" : "");
    btn.innerHTML = `${monthLabelFromYm(m.ym)}<span class="chip-sub">${m.count} txn${m.count === 1 ? "" : "s"}</span>`;
    btn.onclick = () => {
      closeCategoryMenu();
      renderActivity(m.ym);
      showView("view-transactions");
    };
    row.appendChild(btn);
  });
  const active = row.querySelector(".month-chip.active");
  if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest", inline: "center" });
}

function openCategoryMenu() {
  renderMonthChips();
  renderCategoryMenu("");
  const search = document.getElementById("category-menu-search");
  search.value = "";
  search.oninput = () => renderCategoryMenu(search.value);
  document.getElementById("category-menu-modal").classList.add("open");
}
function closeCategoryMenu() {
  document.getElementById("category-menu-modal").classList.remove("open");
}

function renderCategoryMenu(filter) {
  const list = document.getElementById("category-menu-list");
  list.innerHTML = "";
  const q = (filter || "").trim().toLowerCase();

  const counts = {};
  allTxnsCache.forEach((t) => {
    const c = t.category || "Uncategorized";
    counts[c] = (counts[c] || 0) + 1;
  });
  const names = allCategories().map((c) => c.name);
  ["Uncategorized"].concat(Object.keys(counts)).forEach((c) => {
    if (names.indexOf(c) === -1) names.push(c);
  });

  const shown = names.filter((n) => !q || n.toLowerCase().indexOf(q) !== -1);
  if (!shown.length) {
    list.innerHTML = '<div class="empty-state">No matching category.</div>';
    return;
  }
  shown.forEach((name) => {
    const style = CATEGORY_GROUP_STYLE[categoryGroup(name)] || CATEGORY_GROUP_STYLE.Other;
    const n = counts[name] || 0;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "picker-item";
    btn.innerHTML = `<span class="picker-dot" style="background:${style.color}"></span>${name}` +
      `<span class="picker-meta">${n ? n + (n === 1 ? " txn" : " txns") : "none"}</span>`;
    btn.onclick = () => {
      closeCategoryMenu();
      openCategoryDetail(name, latestYmWithActivity(name) || undefined);
    };
    list.appendChild(btn);
  });
}

// ---------- Category detail sorting ----------
let categorySort = "date";
function setCategorySort(mode) {
  categorySort = mode;
  document.querySelectorAll("#view-category-detail .sort-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.sort === mode));
  if (currentCategoryDetail) openCategoryDetail(currentCategoryDetail, currentCategoryDetailYm);
}

function openCategoryDetail(category, selectedYm) {
  currentCategoryDetail = category;
  const todayYm = todayIso().slice(0, 7);
  const ym = selectedYm || todayYm;
  currentCategoryDetailYm = ym;

  const icon = catIcon(category);
  const catTxns = allTxnsCache.filter((t) => t.category === category);
  // Both signs: credits belong to the category as much as debits do, and the
  // header shows the net so a settlement coming back is visible.
  const monthTxns = catTxns.filter((t) => monthKey(t.date) === ym);
  monthTxns.sort(categorySort === "value"
    ? (a, b) => Math.abs(b.amount) - Math.abs(a.amount)      // biggest first
    : (a, b) => (a.date < b.date ? 1 : -1));                 // newest first
  const net = monthTxns.reduce((s, t) => s + t.amount, 0);

  const iconEl = document.getElementById("category-detail-icon");
  iconEl.style.background = icon.color;
  iconEl.textContent = icon.icon;
  document.getElementById("category-detail-label").textContent = category;
  const amtEl = document.getElementById("category-detail-amount");
  amtEl.textContent = fmt(net);
  amtEl.className = "amount " + (net < 0 ? "neg" : "pos");
  document.getElementById("category-txn-head").textContent = monthLabelFromYm(ym);

  renderTrendChart(document.getElementById("category-trend"), catTxns, ym, (clickedYm) => openCategoryDetail(category, clickedYm));

  const list = document.getElementById("category-txn-list");
  list.innerHTML = "";
  if (!monthTxns.length) list.innerHTML = `<div class="empty-state">No ${category} activity in ${monthLabelFromYm(ym)}.</div>`;
  monthTxns.forEach((t) => list.appendChild(renderTxnRow(t, () => openCategoryDetail(category, ym))));

  showView("view-category-detail");
}

// ---------- Add/Edit/Delete transaction (spend / income / transfer) ----------
let txnMode = null; // 'add' | 'edit'
let txnKind = "spend"; // 'spend' | 'income' | 'transfer'
let editingTxn = null; // original txn object when editing

function setTxnKind(kind) {
  txnKind = kind;
  document.querySelectorAll("#txn-form .toggle-btn").forEach((b) => b.classList.toggle("active", b.dataset.kind === kind));
  const isTransfer = kind === "transfer";
  document.getElementById("txn-account-wrap").style.display = isTransfer ? "none" : "flex";
  document.getElementById("txn-category-wrap").style.display = isTransfer ? "none" : "flex";
  document.getElementById("txn-from-wrap").style.display = isTransfer ? "flex" : "none";
  document.getElementById("txn-to-wrap").style.display = isTransfer ? "flex" : "none";
}

function quickAdd() { openTxnAdd(); }

function openTxnAdd() {
  txnMode = "add";
  editingTxn = null;
  document.getElementById("txn-modal-title").textContent = "Add Transaction";
  document.getElementById("txn-id").value = "";
  document.getElementById("txn-orig-account").value = "";
  document.getElementById("txn-delete-btn").style.display = "none";
  document.getElementById("txn-amount").value = "";
  document.getElementById("txn-details").value = "";
  document.getElementById("txn-note").value = "";
  document.getElementById("txn-date").value = todayIso();
  const defAccount = currentDetailAccount ? currentDetailAccount.name : (accountsCache[0] ? accountsCache[0].name : "");
  document.getElementById("txn-account").value = defAccount;
  document.getElementById("txn-from-account").value = defAccount;
  const other = accountsCache.find((a) => a.name !== defAccount);
  if (other) document.getElementById("txn-to-account").value = other.name;
  document.getElementById("txn-category").value = "";
  setTxnKind("spend");
  document.getElementById("txn-modal").classList.add("open");
}

function openTxnEdit(t) {
  txnMode = "edit";
  editingTxn = t;
  document.getElementById("txn-modal-title").textContent = "Edit Transaction";
  document.getElementById("txn-id").value = t.id;
  document.getElementById("txn-orig-account").value = t.account;
  document.getElementById("txn-delete-btn").style.display = "inline-block";
  document.getElementById("txn-amount").value = Math.abs(t.amount);
  document.getElementById("txn-details").value = t.details;
  document.getElementById("txn-date").value = t.date;
  document.getElementById("txn-account").value = t.account;
  document.getElementById("txn-category").value = t.category || "";
  setTxnKind(t.amount >= 0 ? "income" : "spend");
  document.getElementById("txn-modal").classList.add("open");
}
function closeTxnForm() { document.getElementById("txn-modal").classList.remove("open"); }

document.getElementById("txn-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const amount = Math.abs(parseFloat(document.getElementById("txn-amount").value));
  const details = document.getElementById("txn-details").value.trim();
  const date = document.getElementById("txn-date").value;
  const note = document.getElementById("txn-note").value || null;
  if (!details || !date || isNaN(amount) || amount <= 0) return;

  try {
    if (txnKind === "transfer") {
      const fromAcc = document.getElementById("txn-from-account").value;
      const toAcc = document.getElementById("txn-to-account").value;
      if (!fromAcc || !toAcc || fromAcc === toAcc) { toast("Pick two different accounts"); return; }
      // Two independent rows, category "Transfer" -- nothing links them.
      await apiPost("add_transaction", { account: fromAcc, date, details, category: "Transfer", amount: -amount, note });
      await apiPost("add_transaction", { account: toAcc, date, details, category: "Transfer", amount: amount, note });
      toast("Transfer recorded");
      closeTxnForm();
      await refreshAfterTxnChange(fromAcc);
    } else {
      const account = document.getElementById("txn-account").value;
      const category = document.getElementById("txn-category").value || null;
      const signedAmount = txnKind === "income" ? amount : -amount;
      const id = document.getElementById("txn-id").value;
      const origAccount = document.getElementById("txn-orig-account").value;

      if (id && origAccount && origAccount !== account) {
        // Moved to a different account: `id` is only meaningful within its
        // original account's block, so this must be delete-from-old +
        // add-to-new, never a plain update (which could silently overwrite
        // an unrelated row in the new account's block).
        await apiPost("delete_transaction", { id, account: origAccount });
        await apiPost("add_transaction", { account, date, details, category, amount: signedAmount, note });
      } else if (id) {
        await apiPost("update_transaction", { id, account, date, details, category, amount: signedAmount, note });
      } else {
        await apiPost("add_transaction", { account, date, details, category, amount: signedAmount, note });
      }
      toast(id ? "Saved" : "Transaction added");
      closeTxnForm();
      await refreshAfterTxnChange(account);
    }
  } catch (err) {
    toast("Save failed: " + err.message);
  }
});

async function deleteCurrentTxn() {
  const id = document.getElementById("txn-id").value;
  const account = document.getElementById("txn-orig-account").value;
  if (!id) return;
  if (!confirm("Delete this transaction?")) return;
  try {
    await apiPost("delete_transaction", { id, account });
    toast("Transaction deleted");
    closeTxnForm();
    await refreshAfterTxnChange(account);
  } catch (err) {
    toast("Delete failed: " + err.message);
  }
}

// Central post-mutation refresh: reloads accounts+networth once, then
// re-renders whichever view is currently showing from that fresh data.
async function refreshAfterTxnChange(accountName) {
  await Promise.all([loadAccounts(), loadNetworth()]);
  renderGroups();
  if (document.getElementById("view-group-detail").classList.contains("active") && currentGroup) {
    openGroupDetail(currentGroup);
  }
  if (document.getElementById("view-account-detail").classList.contains("active") && currentDetailAccount) {
    const updated = accountsCache.find((a) => a.name === currentDetailAccount.name) || accountsCache.find((a) => a.name === accountName);
    if (updated) await openAccountDetail(updated);
  }
  if (document.getElementById("view-transactions").classList.contains("active")) {
    await loadAllTxns();
    renderActivity(activitySelectedYm);
  }
  if (document.getElementById("view-category-detail").classList.contains("active") && currentCategoryDetail) {
    await loadAllTxns();
    openCategoryDetail(currentCategoryDetail, currentCategoryDetailYm);
  }
}

// ---------- Shared modal: new group / new+edit account / new+edit investment / new+edit loan ----------
let modalMode = null; // 'new-account' | 'edit-account' | 'new-investment' | 'edit-investment' | 'new-loan' | 'edit-loan'
let modalTargetGroup = null;
let modalTargetAccount = null;
let modalTargetInvestment = null;
let modalTargetLoan = null;

function fillGroupSelect(selected, extraOption) {
  const sel = document.getElementById("field-group");
  sel.innerHTML = "";
  const groups = accountGroupList();
  if (extraOption && !groups.includes(extraOption)) groups.push(extraOption);
  groups.forEach((g) => {
    const opt = document.createElement("option");
    opt.value = g; opt.textContent = g;
    if (g === selected) opt.selected = true;
    sel.appendChild(opt);
  });
}
function fillInvestmentCategorySelect(selected) {
  const sel = document.getElementById("field-category");
  sel.innerHTML = "";
  INVESTMENT_CATEGORIES.forEach((c) => {
    const icon = investIcon(c);
    const opt = document.createElement("option");
    opt.value = c; opt.textContent = icon.emoji + " " + c;
    if (c === selected) opt.selected = true;
    sel.appendChild(opt);
  });
}
function setFieldVisible(id, visible) { document.getElementById(id).style.display = visible ? "flex" : "none"; }
function resetModalFields() {
  setFieldVisible("field-name-wrap", false);
  setFieldVisible("field-type-wrap", false);
  setFieldVisible("field-group-wrap", false);
  setFieldVisible("field-category-wrap", false);
  setFieldVisible("field-value-wrap", false);
  document.getElementById("modal-delete-btn").style.display = "none";
  document.getElementById("field-name-wrap").querySelector("input").placeholder = "";
}

// No backend "groups" table exists -- a group is just whatever's in an
// account's Group field. "New group" collects a name, then immediately opens
// "New account" pre-filled with it; the group only really exists once that
// first account is saved.
function openNewGroupModal() {
  const name = prompt("New group name:");
  if (!name || !name.trim()) return;
  openNewAccountModal(name.trim());
}

function openNewAccountModal(group) {
  modalMode = "new-account";
  modalTargetGroup = group;
  resetModalFields();
  document.getElementById("modal-title").textContent = "New account";
  document.getElementById("field-name").value = "";
  document.getElementById("field-type").value = "bank";
  setFieldVisible("field-name-wrap", true);
  setFieldVisible("field-type-wrap", true);
  setFieldVisible("field-group-wrap", true);
  fillGroupSelect(group, group);
  document.getElementById("edit-modal").classList.add("open");
}
function openEditAccountModal(name) {
  const a = accountsCache.find((x) => x.name === name);
  if (!a) return;
  modalMode = "edit-account";
  modalTargetAccount = name;
  resetModalFields();
  document.getElementById("modal-title").textContent = "Edit account";
  document.getElementById("field-name").value = a.name;
  document.getElementById("field-name-wrap").style.display = "none"; // account name isn't editable (it's the sheet lookup key)
  document.getElementById("field-type").value = a.type;
  setFieldVisible("field-type-wrap", true);
  setFieldVisible("field-group-wrap", true);
  fillGroupSelect(a.bucket);
  document.getElementById("edit-modal").classList.add("open");
}

function openNewInvestmentModal() {
  modalMode = "new-investment";
  resetModalFields();
  document.getElementById("modal-title").textContent = "New investment";
  document.getElementById("field-name").value = "";
  document.getElementById("field-name-wrap").querySelector("input").placeholder = "e.g. Gold ETF";
  document.getElementById("field-value").value = "";
  document.getElementById("field-value-label").textContent = "Current value";
  setFieldVisible("field-name-wrap", true);
  setFieldVisible("field-category-wrap", true);
  setFieldVisible("field-value-wrap", true);
  fillInvestmentCategorySelect("Other");
  document.getElementById("edit-modal").classList.add("open");
}
function openEditInvestmentModal(name) {
  const inv = investmentsCache.find((x) => x.name === name);
  if (!inv) return;
  modalMode = "edit-investment";
  modalTargetInvestment = inv.id;
  resetModalFields();
  document.getElementById("modal-title").textContent = "Edit investment";
  document.getElementById("field-name").value = inv.name;
  document.getElementById("field-value").value = inv.value;
  document.getElementById("field-value-label").textContent = "Current value";
  setFieldVisible("field-name-wrap", true);
  setFieldVisible("field-category-wrap", true);
  setFieldVisible("field-value-wrap", true);
  fillInvestmentCategorySelect(inv.category);
  document.getElementById("modal-delete-btn").style.display = "block";
  document.getElementById("edit-modal").classList.add("open");
}

function openNewLoanModal() {
  modalMode = "new-loan";
  resetModalFields();
  document.getElementById("modal-title").textContent = "New loan";
  document.getElementById("field-name").value = "";
  document.getElementById("field-name-wrap").querySelector("input").placeholder = "e.g. Car Loan";
  document.getElementById("field-value").value = "";
  document.getElementById("field-value-label").textContent = "Outstanding amount";
  setFieldVisible("field-name-wrap", true);
  setFieldVisible("field-value-wrap", true);
  document.getElementById("edit-modal").classList.add("open");
}
function openEditLoanModal(name) {
  const loan = loansCache.find((x) => x.name === name);
  if (!loan) return;
  modalMode = "edit-loan";
  modalTargetLoan = loan.id;
  resetModalFields();
  document.getElementById("modal-title").textContent = "Edit loan";
  document.getElementById("field-name").value = loan.name;
  document.getElementById("field-value").value = loan.outstanding;
  document.getElementById("field-value-label").textContent = "Outstanding amount";
  setFieldVisible("field-name-wrap", true);
  setFieldVisible("field-value-wrap", true);
  document.getElementById("modal-delete-btn").style.display = "block";
  document.getElementById("edit-modal").classList.add("open");
}

function closeModal() {
  document.getElementById("edit-modal").classList.remove("open");
  document.getElementById("field-name-wrap").style.display = "flex";
}

async function deleteCurrentKpiItem() {
  try {
    if (modalMode === "edit-investment" && modalTargetInvestment != null) {
      await apiPost("delete_investment", { id: modalTargetInvestment });
      toast("Investment deleted");
      closeModal();
      await Promise.all([loadInvestments(), loadNetworth()]);
      updateNetWorthHero();
      openInvestmentsDetail();
    } else if (modalMode === "edit-loan" && modalTargetLoan != null) {
      await apiPost("delete_loan", { id: modalTargetLoan });
      toast("Loan deleted");
      closeModal();
      await Promise.all([loadLoans(), loadNetworth()]);
      updateNetWorthHero();
      openLoansDetail();
    }
  } catch (err) {
    toast("Delete failed: " + err.message);
  }
}

document.getElementById("modal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("field-name").value.trim();
  if (!name && modalMode !== "edit-account") return;

  try {
    if (modalMode === "new-account") {
      const type = document.getElementById("field-type").value;
      const group = document.getElementById("field-group").value;
      await apiPost("add_account", { name, type, bucket: group });
      toast("Account added: " + name);
      await Promise.all([loadAccounts(), loadNetworth()]);
      renderGroups();
      closeModal();
      openGroupDetail(group);
      return;
    }
    if (modalMode === "edit-account") {
      const type = document.getElementById("field-type").value;
      const group = document.getElementById("field-group").value;
      await apiPost("update_account", { name: modalTargetAccount, type, bucket: group });
      toast("Saved");
      await Promise.all([loadAccounts(), loadNetworth()]);
      renderGroups();
      closeModal();
      openGroupDetail(group);
      return;
    }
    if (modalMode === "new-investment") {
      const category = document.getElementById("field-category").value;
      const value = Number(document.getElementById("field-value").value) || 0;
      await apiPost("add_investment", { name, category, value });
      toast("Investment added: " + name);
      closeModal();
      await Promise.all([loadInvestments(), loadNetworth()]);
      updateNetWorthHero();
      openInvestmentsDetail();
      return;
    }
    if (modalMode === "edit-investment") {
      const category = document.getElementById("field-category").value;
      const value = Number(document.getElementById("field-value").value) || 0;
      await apiPost("update_investment", { id: modalTargetInvestment, name, category, value });
      toast("Saved");
      closeModal();
      await Promise.all([loadInvestments(), loadNetworth()]);
      updateNetWorthHero();
      openInvestmentsDetail();
      return;
    }
    if (modalMode === "new-loan") {
      const outstanding = Number(document.getElementById("field-value").value) || 0;
      await apiPost("add_loan", { name, outstanding });
      toast("Loan added: " + name);
      closeModal();
      await Promise.all([loadLoans(), loadNetworth()]);
      updateNetWorthHero();
      openLoansDetail();
      return;
    }
    if (modalMode === "edit-loan") {
      const outstanding = Number(document.getElementById("field-value").value) || 0;
      await apiPost("update_loan", { id: modalTargetLoan, name, outstanding });
      toast("Saved");
      closeModal();
      await Promise.all([loadLoans(), loadNetworth()]);
      updateNetWorthHero();
      openLoansDetail();
      return;
    }
  } catch (err) {
    toast("Save failed: " + err.message);
  }
});

// ---------- Summary: net worth (Accounts / Investments / Loans) ----------
function renderSummary() {
  const list = document.getElementById("summary-hero-list");
  list.innerHTML = "";
  const cards = [
    { label: "Accounts", dot: "#14161f", amount: networthData.accounts_total, sub: accountsCache.length + " account" + (accountsCache.length === 1 ? "" : "s"), onclick: () => showView("view-accounts") },
    { label: "Investments", dot: "#12a86a", amount: networthData.investments_total, sub: investmentsCache.length + " item" + (investmentsCache.length === 1 ? "" : "s"), onclick: openInvestmentsDetail },
    { label: "Loans", dot: "#e0433d", amount: -networthData.loans_total, sub: loansCache.length + " loan" + (loansCache.length === 1 ? "" : "s"), onclick: openLoansDetail },
  ];
  cards.forEach((c) => {
    const card = document.createElement("button");
    card.className = "group-hero-card";
    card.onclick = c.onclick;
    card.innerHTML = `
      <div class="group-dot" style="background:${c.dot}"></div>
      <div class="body">
        <div class="g-label">${c.label}</div>
        <div class="g-amount ${c.amount < 0 ? "neg" : ""}">${fmt(c.amount)}</div>
        <div class="g-sub">${c.sub}</div>
      </div>
      <div class="chev">›</div>
    `;
    list.appendChild(card);
  });
  updateNetWorthHero();
}

function openInvestmentsDetail() {
  const total = investmentsCache.reduce((s, i) => s + i.value, 0);
  const amtEl = document.getElementById("investments-detail-amount");
  amtEl.textContent = fmt(total);
  amtEl.className = "amount";

  const list = document.getElementById("investments-list");
  list.innerHTML = "";
  if (!investmentsCache.length) list.innerHTML = '<div class="empty-state">No investments added yet.</div>';
  investmentsCache.forEach((inv) => {
    const icon = investIcon(inv.category);
    const row = document.createElement("div");
    row.className = "card";
    const left = document.createElement("div");
    left.className = "left";
    left.style.cursor = "default";
    left.innerHTML = `<div class="avatar" style="background:${icon.color}">${icon.emoji}</div><div class="text"><div class="name">${inv.name}</div><div class="sub">${inv.category}</div></div>`;
    const amt = document.createElement("div");
    amt.className = "amount pos";
    amt.textContent = fmt(inv.value);
    const editBtn = document.createElement("button");
    editBtn.className = "edit-icon";
    editBtn.textContent = "✎";
    editBtn.onclick = () => openEditInvestmentModal(inv.name);
    row.appendChild(left); row.appendChild(amt); row.appendChild(editBtn);
    list.appendChild(row);
  });

  const ghost = document.createElement("button");
  ghost.type = "button";
  ghost.className = "ghost-card";
  ghost.innerHTML = '<span class="plus">+</span><span>New investment</span>';
  ghost.onclick = openNewInvestmentModal;
  list.appendChild(ghost);

  showView("view-investments-detail");
}

function openLoansDetail() {
  const total = loansCache.reduce((s, l) => s + l.outstanding, 0);
  document.getElementById("loans-detail-amount").textContent = fmt(-total);

  const list = document.getElementById("loans-list");
  list.innerHTML = "";
  if (!loansCache.length) list.innerHTML = '<div class="empty-state">No loans added yet.</div>';
  loansCache.forEach((loan) => {
    const row = document.createElement("div");
    row.className = "card";
    const left = document.createElement("div");
    left.className = "left";
    left.style.cursor = "default";
    left.innerHTML = `<div class="avatar" style="background:#e0433d">🏦</div><div class="text"><div class="name">${loan.name}</div><div class="sub">Outstanding</div></div>`;
    const amt = document.createElement("div");
    amt.className = "amount neg";
    amt.textContent = fmt(-loan.outstanding);
    const editBtn = document.createElement("button");
    editBtn.className = "edit-icon";
    editBtn.textContent = "✎";
    editBtn.onclick = () => openEditLoanModal(loan.name);
    row.appendChild(left); row.appendChild(amt); row.appendChild(editBtn);
    list.appendChild(row);
  });

  const ghost = document.createElement("button");
  ghost.type = "button";
  ghost.className = "ghost-card";
  ghost.innerHTML = '<span class="plus">+</span><span>New loan</span>';
  ghost.onclick = openNewLoanModal;
  list.appendChild(ghost);

  showView("view-loans-detail");
}

// ---------- Boot ----------
// ---------- Refresh ----------
// Refetches server data and re-renders whichever view is active. Scroll position
// is saved and restored because the re-render path runs showView(), which
// deliberately scrolls to top on real navigation.
async function refreshAll() {
  const btn = document.getElementById("refresh-btn");
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add("spinning");

  const activeEl = document.querySelector(".view.active");
  const activeId = activeEl ? activeEl.id : "view-accounts";
  const scrollY = window.scrollY;

  try {
    await Promise.all([loadAccounts(), loadCategories(), loadInvestments(), loadLoans(), loadNetworth()]);

    if (activeId === "view-transactions" || activeId === "view-category-detail") {
      await loadAllTxns();
    }

    renderGroups();

    if (activeId === "view-group-detail" && currentGroup) {
      openGroupDetail(currentGroup);
    } else if (activeId === "view-account-detail" && currentDetailAccount) {
      // accountsCache holds fresh objects after loadAccounts(), so re-find by name
      const fresh = accountsCache.filter((a) => a.name === currentDetailAccount.name)[0];
      if (fresh) await openAccountDetail(fresh);
    } else if (activeId === "view-transactions") {
      renderActivity();
    } else if (activeId === "view-category-detail" && currentCategoryDetail) {
      openCategoryDetail(currentCategoryDetail, currentCategoryDetailYm);
    } else if (activeId === "view-summary") {
      renderSummary();
    } else if (activeId === "view-investments-detail") {
      openInvestmentsDetail();
    } else if (activeId === "view-loans-detail") {
      openLoansDetail();
    }

    updateNetWorthHero();
    window.scrollTo(0, scrollY);
    toast("Updated");
  } catch (err) {
    console.error(err);
    toast("Refresh failed: " + err.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove("spinning");
  }
}

document.getElementById("refresh-btn").onclick = refreshAll;
document.getElementById("category-menu-btn").onclick = openCategoryMenu;
document.getElementById("category-menu-modal").onclick = (e) => {
  if (e.target.id === "category-menu-modal") closeCategoryMenu();
};

// ---------- Back gesture / hardware back ----------
window.addEventListener("popstate", (e) => {
  const id = (e.state && e.state.view) || "view-accounts";
  if (document.getElementById(id)) showView(id, true);
});
// Seed the stack so the first back press has somewhere to land.
try { history.replaceState({ view: "view-accounts" }, ""); } catch (err) { /* non-fatal */ }

async function boot() {
  try {
    await Promise.all([loadAccounts(), loadCategories(), loadInvestments(), loadLoans(), loadNetworth()]);
    renderGroups();
  } catch (err) {
    console.error(err);
    toast("Load failed: " + err.message);
  }
}
boot();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
