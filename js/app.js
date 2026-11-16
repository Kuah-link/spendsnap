import {
  CURRENCIES,
  GEMINI_MODELS,
  DEFAULT_PAYMENT_METHODS,
  COLLEAGUE_PAYMENT_METHODS,
  loadSettings,
  saveSettings,
  saveLocalTransaction,
  getAllLocalTransactions,
  deleteLocalTransaction,
  todayISO,
  formatTimestampLocal,
} from "./config.js";
import { processReceiptFile } from "./image-utils.js";
import { getRateToBase, appendForeignCurrencyRemark } from "./currency.js";
import { analyzeReceiptWithGemini } from "./gemini.js";
import {
  getTokenStatus,
  getValidAccessToken,
  requestGoogleSignIn,
  signOutGoogle,
  syncTransactionToGoogle,
  pushSettingsToSheet,
  pullSettingsFromSheet,
  fetchRecentSheetSummary,
} from "./google-sync.js";

// ---------------- App State ----------------
let settings = loadSettings();
let selectedCategory = settings.categories[0] || "Meals";
let selectedPaymentMethod =
  settings.defaultPaymentMethod ||
  settings.paymentMethods[0]?.name ||
  "QR / eWallet";
let cardsDrawerOpen = false;
let currentReceipt = null; // { base64, mimeType, isPdf, extension, sizeBytes, previewDataUrl, originalName }
let currentFxRate = 1;
let cloudHistoryCache = [];
let deferredInstallPrompt = null;

// ---------------- DOM Elements ----------------
const el = (id) => document.getElementById(id);

const googleStatusBtn = el("googleStatusBtn");
const googleStatusText = el("googleStatusText");
const openSheetHeaderBtn = el("openSheetHeaderBtn");
const monthFolderHint = el("monthFolderHint");
const pendingBadge = el("pendingBadge");

const cameraInput = el("cameraInput");
const uploadInput = el("uploadInput");
const receiptStrip = el("receiptStrip");
const receiptThumbWrap = el("receiptThumbWrap");
const receiptThumbImg = el("receiptThumbImg");
const receiptPdfBadge = el("receiptPdfBadge");
const geminiStatusLine = el("geminiStatusLine");
const receiptFileInfo = el("receiptFileInfo");

const expenseForm = el("expenseForm");
const currencySelect = el("currencySelect");
const amountInput = el("amountInput");
const myrEquivalentBadge = el("myrEquivalentBadge");
const fxStrip = el("fxStrip");
const fxLabel = el("fxLabel");
const fxRateInput = el("fxRateInput");
const dateInput = el("dateInput");
const descriptionInput = el("descriptionInput");
const categoryChips = el("categoryChips");
const quickPaymentChips = el("quickPaymentChips");
const cardPaymentChips = el("cardPaymentChips");
const toggleCardsDrawerBtn = el("toggleCardsDrawerBtn");
const cardsDrawerBtnText = el("cardsDrawerBtnText");
const cardsDrawerChevron = el("cardsDrawerChevron");
const selectedPaymentLabel = el("selectedPaymentLabel");
const remarksInput = el("remarksInput");
const saveExpenseBtn = el("saveExpenseBtn");

// ---------------- Initialization ----------------

function init() {
  registerServiceWorker();
  setupInstallBanner();
  populateCurrencySelect();
  populateModelSelect();

  dateInput.value = todayISO();
  updateFolderHint();

  renderCategoryChips();
  renderPaymentChips();
  refreshHeaderStatus();
  refreshPendingCountAndHistory();

  bindEvents();

  // Periodically update token expiry indicator
  setInterval(refreshHeaderStatus, 30_000);

  // Check home-screen shortcut query (?mode=manual or ?mode=snap)
  const mode = new URLSearchParams(window.location.search).get("mode");
  if (mode === "manual") {
    selectedPaymentMethod = "Cash";
    renderPaymentChips();
    amountInput.focus();
  } else if (mode === "snap") {
    el("snapReceiptBtn").focus();
    try {
      cameraInput.click();
    } catch {
      // Browser requires explicit tap
    }
  }
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

function setupInstallBanner() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    el("installBanner").classList.remove("hidden");
  });

  el("installAppBtn").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    el("installBanner").classList.add("hidden");
  });
}

function populateCurrencySelect() {
  currencySelect.innerHTML = CURRENCIES.map(
    (c) => `<option value="${c.code}">${c.code} (${c.symbol})</option>`
  ).join("");
  currencySelect.value = settings.baseCurrency || "MYR";
}

function populateModelSelect() {
  el("geminiModelSelect").innerHTML = GEMINI_MODELS.map(
    (m) => `<option value="${m.id}">${m.label}</option>`
  ).join("");
}

// ---------------- Rendering Chips & Status ----------------

function updateFolderHint() {
  const d = dateInput.value || todayISO();
  const ym = d.slice(0, 7);
  const y = d.slice(0, 4);
  monthFolderHint.textContent = `Auto-folder: Receipts/${y}/${ym}`;
}

function refreshHeaderStatus() {
  settings = loadSettings();
  const status = getTokenStatus();

  googleStatusBtn.classList.remove(
    "status-unconfigured",
    "status-connected",
    "status-expired"
  );

  if (status.state === "connected") {
    googleStatusBtn.classList.add("status-connected");
    const shortUser = status.email.split("@")[0] || "Synced";
    googleStatusText.textContent = shortUser;
  } else if (status.state === "expired") {
    googleStatusBtn.classList.add("status-expired");
    googleStatusText.textContent = "Tap to Reconnect";
  } else if (status.state === "signed_out") {
    googleStatusBtn.classList.add("status-unconfigured");
    googleStatusText.textContent = "Sign In Google";
  } else {
    googleStatusBtn.classList.add("status-unconfigured");
    googleStatusText.textContent = "Setup Sync";
  }

  if (settings.spreadsheetUrl) {
    openSheetHeaderBtn.href = settings.spreadsheetUrl;
    openSheetHeaderBtn.classList.remove("hidden");
    el("openFullSheetBtn").href = settings.spreadsheetUrl;
    el("openFullSheetBtn").classList.remove("hidden");
  } else {
    openSheetHeaderBtn.classList.add("hidden");
    el("openFullSheetBtn").classList.add("hidden");
  }

  saveExpenseBtn.textContent = getValidAccessToken()
    ? "Save to Google Sheet"
    : "Save Transaction (Queues Locally)";
}

function renderCategoryChips() {
  if (!settings.categories.includes(selectedCategory)) {
    selectedCategory = settings.categories[0] || "Others";
  }
  categoryChips.innerHTML = "";
  for (const cat of settings.categories) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip" + (cat === selectedCategory ? " selected" : "");
    btn.textContent = cat;
    btn.addEventListener("click", () => {
      selectedCategory = cat;
      renderCategoryChips();
    });
    categoryChips.appendChild(btn);
  }
}

function renderPaymentChips() {
  const methods = settings.paymentMethods;
  if (!methods.some((m) => m.name === selectedPaymentMethod)) {
    selectedPaymentMethod = methods[0]?.name || "Cash";
  }

  const quickMethods = methods.filter((m) => m.group === "quick");
  const cardMethods = methods.filter((m) => m.group !== "quick");

  // If no quick methods exist, show all in quick bar
  const topList = quickMethods.length > 0 ? quickMethods : methods;
  const drawerList = quickMethods.length > 0 ? cardMethods : [];

  quickPaymentChips.innerHTML = "";
  for (const m of topList) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip" + (m.name === selectedPaymentMethod ? " selected" : "");
    btn.textContent = m.name;
    btn.addEventListener("click", () => {
      selectedPaymentMethod = m.name;
      saveSettings({ defaultPaymentMethod: m.name });
      renderPaymentChips();
    });
    quickPaymentChips.appendChild(btn);
  }

  selectedPaymentLabel.textContent = selectedPaymentMethod;

  if (drawerList.length === 0) {
    toggleCardsDrawerBtn.classList.add("hidden");
    cardPaymentChips.classList.add("hidden");
    return;
  }

  toggleCardsDrawerBtn.classList.remove("hidden");
  const selectedIsCard = drawerList.some((m) => m.name === selectedPaymentMethod);

  cardsDrawerBtnText.textContent = selectedIsCard
    ? `Credit Cards (${drawerList.length}) — ${selectedPaymentMethod}`
    : `Credit Cards (${drawerList.length})`;
  cardsDrawerChevron.textContent = cardsDrawerOpen ? "▴" : "▾";
  cardPaymentChips.classList.toggle("hidden", !cardsDrawerOpen);

  cardPaymentChips.innerHTML = "";
  for (const m of drawerList) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip" + (m.name === selectedPaymentMethod ? " selected" : "");
    btn.textContent = m.name;
    btn.addEventListener("click", () => {
      selectedPaymentMethod = m.name;
      saveSettings({ defaultPaymentMethod: m.name });
      renderPaymentChips();
    });
    cardPaymentChips.appendChild(btn);
  }
}

// ---------------- Currency & FX Handling ----------------

async function handleCurrencyChange(preferredCurrency) {
  const code = (preferredCurrency || currencySelect.value || "MYR").toUpperCase();
  if ([...currencySelect.options].some((o) => o.value === code)) {
    currencySelect.value = code;
  } else {
    // Dynamically add uncommon currency if Gemini detected one
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = code;
    currencySelect.appendChild(opt);
    currencySelect.value = code;
  }

  const base = settings.baseCurrency || "MYR";
  if (code === base) {
    currentFxRate = 1;
    fxStrip.classList.add("hidden");
    myrEquivalentBadge.classList.add("hidden");
    return;
  }

  fxStrip.classList.remove("hidden");
  fxLabel.textContent = `1 ${code} in ${base} (fetching...):`;
  const { rate, source } = await getRateToBase(code, base);
  currentFxRate = rate;
  fxRateInput.value = rate;
  fxLabel.textContent = `1 ${code} in ${base} (${source}):`;
  updateMyrEquivalentPreview();
}

function updateMyrEquivalentPreview() {
  const code = currencySelect.value;
  const base = settings.baseCurrency || "MYR";
  if (code === base) {
    myrEquivalentBadge.classList.add("hidden");
    return;
  }
  const amt = Number(amountInput.value || 0);
  const rate = Number(fxRateInput.value || currentFxRate || 1);
  currentFxRate = rate;
  const myr = amt * rate;
  myrEquivalentBadge.textContent = `≈ RM ${myr.toFixed(2)}`;
  myrEquivalentBadge.classList.remove("hidden");
}

// ---------------- Receipt Capture & Gemini Scan ----------------

async function handleFileSelected(file) {
  if (!file) return;
  try {
    receiptStrip.classList.remove("hidden");
    receiptStrip.classList.add("scanning");
    geminiStatusLine.textContent = "Optimizing image...";
    receiptFileInfo.textContent = file.name || "";

    currentReceipt = await processReceiptFile(file);

    if (currentReceipt.isPdf) {
      receiptThumbImg.classList.add("hidden");
      receiptPdfBadge.classList.remove("hidden");
    } else {
      receiptPdfBadge.classList.add("hidden");
      receiptThumbImg.src = currentReceipt.previewDataUrl;
      receiptThumbImg.classList.remove("hidden");
    }

    const kb = Math.max(1, Math.round(currentReceipt.sizeBytes / 1024));
    receiptFileInfo.textContent = `${currentReceipt.originalName} (${kb} KB ready for Drive)`;

    await runGeminiAutoFill();
  } catch (err) {
    receiptStrip.classList.remove("scanning");
    showToast(err.message || "Could not process receipt file.");
  }
}

async function runGeminiAutoFill() {
  if (!currentReceipt) return;
  settings = loadSettings();

  if (!settings.geminiApiKey) {
    receiptStrip.classList.remove("scanning");
    geminiStatusLine.textContent = "Receipt attached (Add Gemini key in Settings for auto-fill)";
    amountInput.focus();
    return;
  }

  try {
    receiptStrip.classList.add("scanning");
    geminiStatusLine.textContent = "✨ Gemini reading receipt...";

    const result = await analyzeReceiptWithGemini({
      receipt: currentReceipt,
      apiKey: settings.geminiApiKey,
      model: settings.geminiModel,
      categories: settings.categories,
      paymentMethods: settings.paymentMethods,
      baseCurrency: settings.baseCurrency,
    });

    if (result.date) {
      dateInput.value = result.date;
      updateFolderHint();
    }
    if (result.description) {
      descriptionInput.value = result.description;
    }
    if (result.amount > 0) {
      amountInput.value = result.amount.toFixed(2);
    }
    await handleCurrencyChange(result.currency || "MYR");
    updateMyrEquivalentPreview();

    if (result.category) {
      selectedCategory = result.category;
      renderCategoryChips();
    }
    if (result.paymentMethod) {
      selectedPaymentMethod = result.paymentMethod;
      const matchedObj = settings.paymentMethods.find(
        (m) => m.name === result.paymentMethod
      );
      if (matchedObj && matchedObj.group !== "quick") {
        cardsDrawerOpen = true;
      }
      renderPaymentChips();
    }
    if (result.remarks && !remarksInput.value) {
      remarksInput.value = result.remarks;
    }

    const cardTag = result.cardLast4 ? ` (Card *${result.cardLast4})` : "";
    geminiStatusLine.textContent = `✓ Auto-filled by Gemini${cardTag} — verify & save`;
    showToast("Receipt scanned! Check details & tap Save.");
  } catch (err) {
    geminiStatusLine.textContent = "Scan incomplete — fill manually or tap Re-scan";
    showToast(err.message || "Gemini scan failed.");
  } finally {
    receiptStrip.classList.remove("scanning");
  }
}

function clearReceipt() {
  currentReceipt = null;
  cameraInput.value = "";
  uploadInput.value = "";
  receiptStrip.classList.add("hidden");
  receiptStrip.classList.remove("scanning");
}

// ---------------- Saving & Offline Queue Sync ----------------

async function handleFormSubmit(e) {
  e.preventDefault();

  const rawAmount = Number(amountInput.value);
  if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
    showToast("Please enter an amount greater than 0.");
    amountInput.focus();
    return;
  }

  const desc = descriptionInput.value.trim();
  if (!desc) {
    showToast("Please enter an item or service description.");
    descriptionInput.focus();
    return;
  }

  const dateVal = dateInput.value || todayISO();
  const currency = currencySelect.value || "MYR";
  const base = settings.baseCurrency || "MYR";
  const rate = currency === base ? 1 : Number(fxRateInput.value || currentFxRate || 1);
  const amountMyr = Number((rawAmount * rate).toFixed(2));
  const finalRemarks = appendForeignCurrencyRemark(remarksInput.value, {
    currency,
    originalAmount: rawAmount,
    rate,
    baseCurrency: base,
  });

  const txn = {
    localId: `txn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    timestamp: formatTimestampLocal(),
    date: dateVal,
    yearMonth: dateVal.slice(0, 7),
    description: desc,
    category: selectedCategory,
    amountMyr,
    originalCurrency: currency,
    originalAmount: rawAmount,
    paymentMethod: selectedPaymentMethod,
    remarks: finalRemarks,
    status: "pending",
    receiptBase64: currentReceipt ? currentReceipt.base64 : null,
    receiptMimeType: currentReceipt ? currentReceipt.mimeType : null,
    receiptExtension: currentReceipt ? currentReceipt.extension : null,
    receiptUrl: "",
  };

  saveExpenseBtn.disabled = true;
  saveExpenseBtn.textContent = currentReceipt
    ? "Uploading receipt & saving..."
    : "Saving transaction...";

  try {
    // Always persist locally first so data can never be lost
    await saveLocalTransaction(txn);

    if (getValidAccessToken()) {
      try {
        const synced = await syncTransactionToGoogle(txn);
        // Strip base64 once safely uploaded to Google Drive to keep phone storage tiny
        await saveLocalTransaction({
          ...txn,
          status: "synced",
          receiptBase64: null,
          receiptUrl: synced.receiptUrl || "",
        });
        refreshHeaderStatus();
        showToast(`Saved RM ${amountMyr.toFixed(2)} to Google Sheet!`);
      } catch (syncErr) {
        showToast(`Saved on phone (Cloud sync pending: ${syncErr.message})`);
      }
    } else {
      showToast(`Saved RM ${amountMyr.toFixed(2)} locally! Connect Google to sync.`);
    }

    // Reset form for next entry (keep date & selected payment method)
    amountInput.value = "";
    descriptionInput.value = "";
    remarksInput.value = "";
    await handleCurrencyChange(settings.baseCurrency || "MYR");
    clearReceipt();
    await refreshPendingCountAndHistory();
  } finally {
    saveExpenseBtn.disabled = false;
    refreshHeaderStatus();
  }
}

async function syncAllPendingTransactions() {
  if (!getValidAccessToken()) {
    try {
      await requestGoogleSignIn({ interactive: true });
      refreshHeaderStatus();
    } catch (err) {
      showToast(err.message);
      return;
    }
  }

  const all = await getAllLocalTransactions();
  const pending = all.filter((t) => t.status === "pending");
  if (pending.length === 0) {
    showToast("All transactions are already synced!");
    return;
  }

  const btn = el("syncPendingNowBtn");
  btn.disabled = true;
  btn.textContent = "Syncing...";

  let okCount = 0;
  // Sync in chronological order so Sheet rows stay ordered
  for (const txn of [...pending].reverse()) {
    try {
      const res = await syncTransactionToGoogle(txn);
      await saveLocalTransaction({
        ...txn,
        status: "synced",
        receiptBase64: null,
        receiptUrl: res.receiptUrl || "",
      });
      okCount++;
    } catch (err) {
      showToast(`Stopped at "${txn.description}": ${err.message}`);
      break;
    }
  }

  btn.disabled = false;
  btn.textContent = "Sync Now";
  refreshHeaderStatus();
  await refreshPendingCountAndHistory();
  if (okCount > 0) {
    showToast(`Synced ${okCount} transaction${okCount > 1 ? "s" : ""} to Google!`);
  }
}

// ---------------- History & Monthly Summary ----------------

async function refreshPendingCountAndHistory() {
  const localTxns = await getAllLocalTransactions();
  const pendingCount = localTxns.filter((t) => t.status === "pending").length;

  pendingBadge.textContent = String(pendingCount);
  pendingBadge.classList.toggle("hidden", pendingCount === 0);

  const pendingCard = el("pendingSyncCard");
  pendingCard.classList.toggle("hidden", pendingCount === 0);
  el("pendingCountTitle").textContent =
    pendingCount === 1
      ? "1 unsynced transaction on phone"
      : `${pendingCount} unsynced transactions on phone`;

  // Merge local pending/synced with cloudHistoryCache (dedupe by timestamp + description + amount)
  const merged = [...localTxns];
  const seenKeys = new Set(
    localTxns.map((t) => `${t.date}|${t.description}|${Number(t.amountMyr).toFixed(2)}`)
  );
  for (const c of cloudHistoryCache) {
    const key = `${c.date}|${c.description}|${Number(c.amountMyr).toFixed(2)}`;
    if (!seenKeys.has(key)) {
      merged.push({ ...c, status: "synced" });
      seenKeys.add(key);
    }
  }

  merged.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  // Populate Month selector
  const currentYm = todayISO().slice(0, 7);
  const months = new Set([currentYm]);
  for (const t of merged) {
    if (t.date && t.date.length >= 7) months.add(t.date.slice(0, 7));
  }
  const sortedMonths = [...months].sort().reverse();
  const monthSelect = el("historyMonthSelect");
  const prevVal = monthSelect.value || currentYm;
  monthSelect.innerHTML =
    sortedMonths.map((m) => `<option value="${m}">${m}</option>`).join("") +
    `<option value="ALL">All Months (Annual)</option>`;
  monthSelect.value = [...monthSelect.options].some((o) => o.value === prevVal)
    ? prevVal
    : currentYm;

  renderHistoryView(merged, monthSelect.value);
}

function renderHistoryView(allTxns, monthFilter) {
  const filtered =
    monthFilter === "ALL"
      ? allTxns
      : allTxns.filter((t) => (t.date || "").startsWith(monthFilter));

  const total = filtered.reduce((acc, t) => acc + Number(t.amountMyr || 0), 0);
  el("historyMonthTotal").textContent = `RM ${total.toFixed(2)}`;

  // Category bars
  const byCat = {};
  for (const t of filtered) {
    const c = t.category || "Others";
    byCat[c] = (byCat[c] || 0) + Number(t.amountMyr || 0);
  }
  const catEntries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const barsContainer = el("categoryBreakdownBars");
  if (catEntries.length === 0) {
    barsContainer.innerHTML = "";
  } else {
    barsContainer.innerHTML = catEntries
      .map(([cat, sum]) => {
        const pct = total > 0 ? Math.min(100, Math.round((sum / total) * 100)) : 0;
        return `
          <div class="bar-row">
            <div class="bar-meta">
              <span>${escapeHtml(cat)}</span>
              <span>RM ${sum.toFixed(2)} (${pct}%)</span>
            </div>
            <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
          </div>`;
      })
      .join("");
  }

  // Transaction list
  const listEl = el("historyList");
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="empty-state">No transactions recorded for ${escapeHtml(
      monthFilter
    )} yet.</div>`;
    return;
  }

  listEl.innerHTML = "";
  for (const t of filtered.slice(0, 80)) {
    const row = document.createElement("div");
    row.className = "txn-item";
    const isPending = t.status === "pending";

    row.innerHTML = `
      <div class="txn-left">
        <div class="txn-desc">${escapeHtml(t.description || "Spend")}</div>
        <div class="txn-tags">
          <span class="txn-tag">${escapeHtml(t.date || "")}</span>
          <span class="txn-tag">${escapeHtml(t.category || "")}</span>
          <span class="txn-tag">${escapeHtml(t.paymentMethod || "")}</span>
          ${isPending ? `<span class="txn-tag pending">Pending Sync</span>` : ""}
        </div>
        ${
          t.remarks
            ? `<div class="receipt-file-info" style="margin-top:4px">${escapeHtml(
                t.remarks
              )}</div>`
            : ""
        }
      </div>
      <div class="txn-right">
        <div class="txn-amount">RM ${Number(t.amountMyr || 0).toFixed(2)}</div>
        ${
          t.receiptUrl
            ? `<a class="txn-link" href="${escapeAttr(
                t.receiptUrl
              )}" target="_blank" rel="noopener">Receipt ↗</a>`
            : ""
        }
      </div>
    `;

    if (isPending && t.localId) {
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "txn-delete-btn";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", async () => {
        await deleteLocalTransaction(t.localId);
        await refreshPendingCountAndHistory();
      });
      row.querySelector(".txn-right").appendChild(delBtn);
    }

    listEl.appendChild(row);
  }
}

// ---------------- Settings Modal ----------------

function openSettingsModal() {
  settings = loadSettings();
  el("geminiKeyInput").value = settings.geminiApiKey || "";
  el("geminiModelSelect").value = settings.geminiModel || "gemini-4-hydrogen";
  el("googleClientIdInput").value = settings.googleClientId || "";
  el("categoriesTextarea").value = settings.categories.join("\n");
  el("paymentMethodsTextarea").value = formatPaymentMethodsText(
    settings.paymentMethods
  );

  updateSettingsGoogleUi();
  el("settingsModal").classList.remove("hidden");
}

function updateSettingsGoogleUi() {
  settings = loadSettings();
  const status = getTokenStatus();
  const signOutBtn = el("settingsGoogleSignOutBtn");
  const connectBtn = el("settingsGoogleConnectBtn");
  const info = el("connectedAccountInfo");

  if (status.state === "connected") {
    connectBtn.textContent = "Reconnect / Switch Account";
    signOutBtn.classList.remove("hidden");
    info.textContent = `✓ Signed in as ${status.email}. Auto-filing into Google Drive "Expense Tracker".`;
  } else if (status.state === "expired") {
    connectBtn.textContent = `Reconnect (${status.email})`;
    signOutBtn.classList.remove("hidden");
    info.textContent = "Session paused (1h token). Tap Reconnect to sync.";
  } else {
    connectBtn.textContent = "Sign in with Google";
    signOutBtn.classList.add("hidden");
    info.textContent = "";
  }
}

function formatPaymentMethodsText(methods) {
  return methods
    .map((m) => `${m.name} | ${m.group || "card"} | ${m.hint || ""}`)
    .join("\n");
}

function parsePaymentMethodsText(text) {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    const parts = line.split("|").map((p) => p.trim());
    const name = parts[0];
    if (!name) continue;
    const rawGroup = (parts[1] || "card").toLowerCase();
    const group = rawGroup === "quick" ? "quick" : "card";
    const hint = parts.slice(2).join(" | ").trim();
    parsed.push({ name, group, hint });
  }
  return parsed;
}

async function saveSettingsFromModal() {
  const cats = el("categoriesTextarea")
    .value.split("\n")
    .map((c) => c.trim())
    .filter(Boolean);
  const methods = parsePaymentMethodsText(el("paymentMethodsTextarea").value);

  settings = saveSettings({
    geminiApiKey: el("geminiKeyInput").value.trim(),
    geminiModel: el("geminiModelSelect").value,
    googleClientId: el("googleClientIdInput").value.trim(),
    categories: cats.length ? cats : ["Meals", "Others"],
    paymentMethods: methods.length ? methods : DEFAULT_PAYMENT_METHODS,
  });

  renderCategoryChips();
  renderPaymentChips();
  refreshHeaderStatus();

  if (getValidAccessToken()) {
    try {
      await pushSettingsToSheet();
    } catch {
      // non-fatal
    }
  }

  el("settingsModal").classList.add("hidden");
  showToast("Settings saved!");
}

// ---------------- Event Listeners ----------------

function bindEvents() {
  // Main Navigation Tabs
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach((b) => {
        b.classList.toggle("active", b === btn);
        b.setAttribute("aria-selected", b === btn ? "true" : "false");
      });
      el("tab-record").classList.toggle("hidden", target !== "record");
      el("tab-history").classList.toggle("hidden", target !== "history");
      if (target === "history") refreshPendingCountAndHistory();
    });
  });

  // 3 Capture Buttons
  el("snapReceiptBtn").addEventListener("click", () => cameraInput.click());
  el("uploadOnlineBtn").addEventListener("click", () => uploadInput.click());
  el("manualCashBtn").addEventListener("click", () => {
    clearReceipt();
    if (settings.paymentMethods.some((m) => m.name === "Cash")) {
      selectedPaymentMethod = "Cash";
      renderPaymentChips();
    }
    amountInput.focus();
  });

  cameraInput.addEventListener("change", (e) =>
    handleFileSelected(e.target.files?.[0])
  );
  uploadInput.addEventListener("change", (e) =>
    handleFileSelected(e.target.files?.[0])
  );

  el("rescanGeminiBtn").addEventListener("click", () => runGeminiAutoFill());
  el("removeReceiptBtn").addEventListener("click", () => clearReceipt());

  // Lightbox preview on receipt thumbnail tap
  receiptThumbWrap.addEventListener("click", () => {
    if (currentReceipt && !currentReceipt.isPdf && currentReceipt.previewDataUrl) {
      el("lightboxImg").src = currentReceipt.previewDataUrl;
      el("lightboxModal").classList.remove("hidden");
    }
  });
  el("closeLightboxBtn").addEventListener("click", () =>
    el("lightboxModal").classList.add("hidden")
  );
  el("lightboxModal").addEventListener("click", (e) => {
    if (e.target === el("lightboxModal")) {
      el("lightboxModal").classList.add("hidden");
    }
  });

  // Form inputs
  dateInput.addEventListener("change", updateFolderHint);
  currencySelect.addEventListener("change", () => handleCurrencyChange());
  amountInput.addEventListener("input", updateMyrEquivalentPreview);
  fxRateInput.addEventListener("input", updateMyrEquivalentPreview);

  toggleCardsDrawerBtn.addEventListener("click", () => {
    cardsDrawerOpen = !cardsDrawerOpen;
    renderPaymentChips();
  });

  expenseForm.addEventListener("submit", handleFormSubmit);

  // Header Google Pill
  googleStatusBtn.addEventListener("click", async () => {
    const status = getTokenStatus();
    if (status.state === "unconfigured") {
      openSettingsModal();
      return;
    }
    if (status.state === "connected") {
      openSettingsModal();
      return;
    }
    try {
      googleStatusText.textContent = "Connecting...";
      await requestGoogleSignIn({ interactive: status.state !== "expired" });
      refreshHeaderStatus();
      showToast("Google Workspace connected!");
      await syncAllPendingTransactions();
    } catch (err) {
      // Fallback to interactive prompt if silent refresh was blocked
      if (status.state === "expired") {
        try {
          await requestGoogleSignIn({ interactive: true });
          refreshHeaderStatus();
          showToast("Reconnected to Google!");
          await syncAllPendingTransactions();
          return;
        } catch (err2) {
          showToast(err2.message);
        }
      } else {
        showToast(err.message);
      }
      refreshHeaderStatus();
    }
  });

  // History Actions
  el("syncPendingNowBtn").addEventListener("click", syncAllPendingTransactions);
  el("historyMonthSelect").addEventListener("change", () =>
    refreshPendingCountAndHistory()
  );
  el("refreshCloudHistoryBtn").addEventListener("click", async () => {
    if (!getValidAccessToken()) {
      showToast("Connect Google first to pull Sheet rows.");
      return;
    }
    try {
      const rows = await fetchRecentSheetSummary();
      if (rows) {
        cloudHistoryCache = rows;
        await refreshPendingCountAndHistory();
        showToast(`Loaded ${rows.length} rows from Google Sheet.`);
      }
    } catch (err) {
      showToast(err.message);
    }
  });

  // Settings Modal
  el("openSettingsBtn").addEventListener("click", openSettingsModal);
  el("closeSettingsBtn").addEventListener("click", () =>
    el("settingsModal").classList.add("hidden")
  );
  el("toggleKeyVisBtn").addEventListener("click", () => {
    const inp = el("geminiKeyInput");
    const isPwd = inp.type === "password";
    inp.type = isPwd ? "text" : "password";
    el("toggleKeyVisBtn").textContent = isPwd ? "Hide" : "Show";
  });

  el("settingsGoogleConnectBtn").addEventListener("click", async () => {
    const cid = el("googleClientIdInput").value.trim();
    if (!cid) {
      showToast("Paste your Google OAuth Client ID first.");
      el("googleClientIdInput").focus();
      return;
    }
    saveSettings({ googleClientId: cid });
    try {
      await requestGoogleSignIn({ interactive: true });
      settings = loadSettings();
      el("categoriesTextarea").value = settings.categories.join("\n");
      el("paymentMethodsTextarea").value = formatPaymentMethodsText(
        settings.paymentMethods
      );
      renderCategoryChips();
      renderPaymentChips();
      updateSettingsGoogleUi();
      refreshHeaderStatus();
      showToast("Connected & provisioned Expense Ledger in Google Drive!");
    } catch (err) {
      showToast(err.message);
    }
  });

  el("settingsGoogleSignOutBtn").addEventListener("click", () => {
    signOutGoogle();
    updateSettingsGoogleUi();
    refreshHeaderStatus();
    showToast("Signed out of Google.");
  });

  el("copyColleagueLinkBtn").addEventListener("click", async () => {
    const cid = el("googleClientIdInput").value.trim() || settings.googleClientId;
    const baseUrl = window.location.origin + window.location.pathname;
    const shareUrl = cid ? `${baseUrl}?cid=${encodeURIComponent(cid)}` : baseUrl;
    try {
      await navigator.clipboard.writeText(shareUrl);
      showToast("Colleague invite link copied to clipboard!");
    } catch {
      showToast(shareUrl);
    }
  });

  el("loadMyCardsPresetBtn").addEventListener("click", () => {
    el("paymentMethodsTextarea").value = formatPaymentMethodsText(
      DEFAULT_PAYMENT_METHODS
    );
    showToast("Loaded your 8-card + Cash/QR/Online preset.");
  });

  el("loadColleaguePresetBtn").addEventListener("click", () => {
    el("paymentMethodsTextarea").value = formatPaymentMethodsText(
      COLLEAGUE_PAYMENT_METHODS
    );
    showToast("Loaded simple preset (Cash, QR, Credit Card, Online).");
  });

  el("pullSheetSettingsBtn").addEventListener("click", async () => {
    if (!getValidAccessToken()) {
      showToast("Sign in with Google first.");
      return;
    }
    try {
      const updated = await pullSettingsFromSheet();
      if (updated) {
        settings = updated;
        el("categoriesTextarea").value = settings.categories.join("\n");
        el("paymentMethodsTextarea").value = formatPaymentMethodsText(
          settings.paymentMethods
        );
        renderCategoryChips();
        renderPaymentChips();
        showToast("Pulled Categories & Cards from Google Sheet!");
      }
    } catch (err) {
      showToast(err.message);
    }
  });

  el("saveSettingsBtn").addEventListener("click", saveSettingsFromModal);
}

// ---------------- Utilities ----------------

let toastTimer = null;
function showToast(message) {
  const t = el("toast");
  t.textContent = message;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3800);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(str) {
  return escapeHtml(str);
}

init();
