// Default configuration, presets, and local storage / IndexedDB helpers

export const DEFAULT_CATEGORIES = [
  "6519 - Travel Expense",
  "6518 - Meal & Entertainment",
  "6512 - Telephone & Internet",
  "6516 - Office Expense",
  "6514 - Accounting & Other Professional Fees",
  "6507 - General Expense",
  "6522 - Subscription",
  "6517 - Printing & Stationery",
  "6511 - Water & Electricity",
  "6520 - Daily Commute Expense",
  "6513 - Legal Fees",
];

export const PERSONAL_CATEGORIES = [
  "Meals",
  "Groceries",
  "Transportation & Vehicles",
  "Daughter",
  "Wife",
  "Myself",
  "Others",
];

export const DEFAULT_PAYMENT_METHODS = [
  { name: "Cash", group: "quick", hint: "CASH, TUNAI" },
  {
    name: "QR / eWallet",
    group: "quick",
    hint: "DuitNow QR, Touch n Go, TnG, GrabPay, MAE, ShopeePay",
  },
  {
    name: "Online Banking",
    group: "quick",
    hint: "FPX, DuitNow Transfer, Maybank2u, IBG, JomPAY",
  },
  { name: "RHB Shell", group: "card", hint: "RHB Shell Visa, Shell station" },
  {
    name: "SC Simply Cash",
    group: "card",
    hint: "Standard Chartered Simply Cash",
  },
  {
    name: "Maybank Platinum Visa",
    group: "card",
    hint: "Maybank Platinum Visa",
  },
  { name: "Amex", group: "card", hint: "AMEX, American Express" },
  { name: "Ikhwan", group: "card", hint: "Maybank Ikhwan" },
  { name: "Visa Signature", group: "card", hint: "Visa Signature" },
  {
    name: "Public Bank Visa Signature",
    group: "card",
    hint: "Public Bank, PBB Visa Signature",
  },
  { name: "Bank Muamalat", group: "card", hint: "Bank Muamalat" },
];

export const COLLEAGUE_PAYMENT_METHODS = [
  { name: "Cash", group: "quick", hint: "CASH, TUNAI" },
  {
    name: "QR / eWallet",
    group: "quick",
    hint: "DuitNow QR, Touch n Go, TnG, GrabPay, ShopeePay",
  },
  { name: "Credit Card", group: "quick", hint: "VISA, MASTERCARD, AMEX" },
  {
    name: "Online Banking",
    group: "quick",
    hint: "FPX, DuitNow Transfer, Online Banking, IBG",
  },
];

export const CURRENCIES = [
  { code: "MYR", symbol: "RM", name: "Malaysian Ringgit" },
  { code: "SGD", symbol: "S$", name: "Singapore Dollar" },
  { code: "THB", symbol: "฿", name: "Thai Baht" },
  { code: "JPY", symbol: "¥", name: "Japanese Yen" },
  { code: "IDR", symbol: "Rp", name: "Indonesian Rupiah" },
  { code: "CNY", symbol: "¥", name: "Chinese Yuan" },
  { code: "TWD", symbol: "NT$", name: "Taiwan Dollar" },
  { code: "KRW", symbol: "₩", name: "Korean Won" },
  { code: "VND", symbol: "₫", name: "Vietnamese Dong" },
  { code: "HKD", symbol: "HK$", name: "Hong Kong Dollar" },
  { code: "USD", symbol: "US$", name: "US Dollar" },
  { code: "EUR", symbol: "€", name: "Euro" },
  { code: "GBP", symbol: "£", name: "British Pound" },
  { code: "AUD", symbol: "A$", name: "Australian Dollar" },
];

export const GEMINI_MODELS = [
  {
    id: "gemini-4-hydrogen",
    label: "Gemini 4 Hydrogen (Recommended — Fast & Accurate)",
  },
  {
    id: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash-Lite (Ultra-Fast & Lowest Cost)",
  },
];

// Embedded OAuth Client ID (locked to Authorized JavaScript Origins in Google Cloud)
export const EMBEDDED_GOOGLE_CLIENT_ID =
  "792845419810-3ntqu8ueshr2di8m1eqcgpf7p6iofrl2.apps.googleusercontent.com";

// App release tag & optional write-only Apps Script webhook for active-tester roster
// (sends ONLY name, email, device & appVersion — never financial entries, receipts, or keys)
export const APP_VERSION = "spendsnap-v9";
export const EMBEDDED_USAGE_WEBHOOK_URL = "";

const SETTINGS_KEY = "spendsnap_settings_v1";

export function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    saved = {};
  }

  // Support pre-filling OAuth Client ID via invite link (?cid=...)
  const params = new URLSearchParams(window.location.search);
  const urlCid = params.get("cid");
  if (urlCid && !saved.googleClientId) {
    saved.googleClientId = urlCid.trim();
  }

  // Migrate v1 categories to v2 65xx Expense Codes once
  let categories =
    Array.isArray(saved.categories) && saved.categories.length > 0
      ? saved.categories
      : [...DEFAULT_CATEGORIES];
  let categoriesSchemaVersion = saved.categoriesSchemaVersion || 1;
  if (categoriesSchemaVersion < 2) {
    categories = [...DEFAULT_CATEGORIES];
    categoriesSchemaVersion = 2;
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          ...saved,
          categories,
          categoriesSchemaVersion,
        })
      );
    } catch {
      // ignore
    }
  }

  return {
    geminiApiKey: saved.geminiApiKey || "",
    geminiModel: saved.geminiModel || "gemini-4-hydrogen",
    googleClientId: saved.googleClientId || EMBEDDED_GOOGLE_CLIENT_ID || "",
    baseCurrency: saved.baseCurrency || "MYR",
    categories,
    categoriesSchemaVersion,
    paymentMethods:
      Array.isArray(saved.paymentMethods) && saved.paymentMethods.length > 0
        ? saved.paymentMethods
        : DEFAULT_PAYMENT_METHODS.map((m) => ({ ...m })),
    defaultPaymentMethod: saved.defaultPaymentMethod || "QR / eWallet",
    bukkuEmployeeName: saved.bukkuEmployeeName || "",
    userEmail: saved.userEmail || "",
    userName: saved.userName || "",
    shareUsagePing: saved.shareUsagePing !== false,
    driveRootFolderId: saved.driveRootFolderId || "",
    driveReceiptsFolderId: saved.driveReceiptsFolderId || "",
    spreadsheetId: saved.spreadsheetId || "",
    spreadsheetUrl: saved.spreadsheetUrl || "",
    dashboardSchemaVersion: saved.dashboardSchemaVersion || 1,
  };
}

export function saveSettings(partial) {
  const current = loadSettings();
  const merged = { ...current, ...partial };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
  return merged;
}

// ---------------- IndexedDB Local Queue & History ----------------
const DB_NAME = "spendsnap_db";
const DB_VERSION = 1;
const STORE_TXNS = "transactions";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_TXNS)) {
        const store = db.createObjectStore(STORE_TXNS, { keyPath: "localId" });
        store.createIndex("status", "status", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveLocalTransaction(txn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_TXNS, "readwrite");
    tx.objectStore(STORE_TXNS).put(txn);
    tx.oncomplete = () => resolve(txn);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllLocalTransactions() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_TXNS, "readonly");
    const req = tx.objectStore(STORE_TXNS).getAll();
    req.onsuccess = () => {
      const items = req.result || [];
      items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteLocalTransaction(localId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_TXNS, "readwrite");
    tx.objectStore(STORE_TXNS).delete(localId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function todayISO() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function formatTimestampLocal(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds()
  )}`;
}
