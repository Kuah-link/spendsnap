// Google Workspace / Google Account OAuth (drive.file) + Drive Monthly Folders + 4-Tab Ledger Sheet (with Bukku Export)

import { base64ToBlob, buildReceiptFilename } from "./image-utils.js";
import {
  loadSettings,
  saveSettings,
  formatTimestampLocal,
  APP_VERSION,
  EMBEDDED_USAGE_WEBHOOK_URL,
} from "./config.js";

const SCOPES = "https://www.googleapis.com/auth/drive.file email profile";
const TOKEN_STORAGE_KEY = "spendsnap_oauth_token_v1";
const FOLDER_CACHE_KEY = "spendsnap_folder_cache_v1";
const LAST_USAGE_PING_KEY = "spendsnap_last_usage_ping_v1";
export const CURRENT_DASHBOARD_SCHEMA_VERSION = 5;

let tokenClient = null;
let pendingTokenResolve = null;
let pendingTokenReject = null;

// ---------------- OAuth Token Management ----------------

export function getValidAccessToken() {
  try {
    const raw = JSON.parse(localStorage.getItem(TOKEN_STORAGE_KEY) || "null");
    if (!raw || !raw.accessToken) return null;
    // 90-second buffer before expiry
    if (Date.now() > raw.expiresAt - 90_000) return null;
    return raw.accessToken;
  } catch {
    return null;
  }
}

export function getTokenStatus() {
  const settings = loadSettings();
  if (!settings.googleClientId) {
    return { state: "unconfigured", email: "" };
  }
  const token = getValidAccessToken();
  if (token) {
    return { state: "connected", email: settings.userEmail || "Connected" };
  }
  if (settings.userEmail) {
    return { state: "expired", email: settings.userEmail };
  }
  return { state: "signed_out", email: "" };
}

export function signOutGoogle() {
  const token = getValidAccessToken();
  if (token && window.google?.accounts?.oauth2) {
    try {
      window.google.accounts.oauth2.revoke(token, () => {});
    } catch {
      // ignore
    }
  }
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(FOLDER_CACHE_KEY);
  saveSettings({
    userEmail: "",
    userName: "",
    driveRootFolderId: "",
    driveReceiptsFolderId: "",
    spreadsheetId: "",
    spreadsheetUrl: "",
    dashboardSchemaVersion: 1,
  });
}

export function requestGoogleSignIn({ interactive = true } = {}) {
  const settings = loadSettings();
  const clientId = String(settings.googleClientId || "").trim();
  if (!clientId) {
    return Promise.reject(
      new Error("Missing Google OAuth Client ID. Open Settings to paste your Client ID.")
    );
  }
  if (!window.google?.accounts?.oauth2) {
    return Promise.reject(
      new Error("Google Sign-In library not loaded. Check your internet connection and reload.")
    );
  }

  return new Promise((resolve, reject) => {
    pendingTokenResolve = resolve;
    pendingTokenReject = reject;

    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: async (resp) => {
        if (resp.error) {
          pendingTokenReject?.(
            new Error(`Google Sign-In error: ${resp.error_description || resp.error}`)
          );
          pendingTokenResolve = null;
          pendingTokenReject = null;
          return;
        }
        const expiresInSec = Number(resp.expires_in || 3599);
        const tokenData = {
          accessToken: resp.access_token,
          expiresAt: Date.now() + expiresInSec * 1000,
        };
        localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(tokenData));

        try {
          const profile = await fetchUserProfile(resp.access_token);
          const prevSettings = loadSettings();
          // If switching Google accounts on same device, clear cached Drive IDs
          if (
            profile.email &&
            prevSettings.userEmail &&
            prevSettings.userEmail.toLowerCase() !== profile.email.toLowerCase()
          ) {
            localStorage.removeItem(FOLDER_CACHE_KEY);
            saveSettings({
              userEmail: profile.email,
              userName: profile.name || "",
              bukkuEmployeeName: profile.name || "",
              driveRootFolderId: "",
              driveReceiptsFolderId: "",
              spreadsheetId: "",
              spreadsheetUrl: "",
              dashboardSchemaVersion: 1,
            });
          } else if (profile.email) {
            saveSettings({
              userEmail: profile.email,
              userName: profile.name || prevSettings.userName || "",
              ...(!prevSettings.bukkuEmployeeName && profile.name
                ? { bukkuEmployeeName: profile.name }
                : {}),
            });
          }
          pingActiveUserRoster({ force: interactive });
          await ensureWorkspaceProvisioned(resp.access_token);
          pendingTokenResolve?.(resp.access_token);
        } catch (err) {
          pendingTokenReject?.(err);
        } finally {
          pendingTokenResolve = null;
          pendingTokenReject = null;
        }
      },
      error_callback: (err) => {
        pendingTokenReject?.(
          new Error(err?.message || "Google Sign-In popup closed or blocked.")
        );
        pendingTokenResolve = null;
        pendingTokenReject = null;
      },
    });

    const reqOpts = {};
    if (settings.userEmail) {
      reqOpts.login_hint = settings.userEmail;
    }
    if (!interactive && settings.userEmail) {
      reqOpts.prompt = "";
    }
    tokenClient.requestAccessToken(reqOpts);
  });
}

async function fetchUserProfile(accessToken) {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return { email: "" };
  return res.json();
}

function detectDeviceSummary() {
  const ua = String(navigator.userAgent || "");
  let device = "Desktop";
  if (/iPhone|iPad|iPod/i.test(ua)) {
    device = "iPhone / iPad (iOS)";
  } else if (/Android/i.test(ua)) {
    device = "Android";
  }
  const isStandalone =
    window.matchMedia?.("(display-mode: standalone)")?.matches ||
    window.navigator.standalone === true;
  return {
    device,
    installMode: isStandalone ? "Home-Screen PWA" : "Browser Tab",
  };
}

export function pingActiveUserRoster({ force = false } = {}) {
  try {
    const webhookUrl = String(EMBEDDED_USAGE_WEBHOOK_URL || "").trim();
    if (!webhookUrl) return;

    const settings = loadSettings();
    if (settings.shareUsagePing === false) return;
    const email = String(settings.userEmail || "").trim();
    if (!email) return;

    const now = Date.now();
    if (!force) {
      try {
        const last = JSON.parse(localStorage.getItem(LAST_USAGE_PING_KEY) || "null");
        if (
          last &&
          last.email === email.toLowerCase() &&
          now - Number(last.ts || 0) < 12 * 60 * 60 * 1000
        ) {
          return;
        }
      } catch {
        // ignore
      }
    }

    localStorage.setItem(
      LAST_USAGE_PING_KEY,
      JSON.stringify({ email: email.toLowerCase(), ts: now })
    );

    const { device, installMode } = detectDeviceSummary();
    const payload = {
      app: "spendsnap",
      email,
      name: String(settings.userName || settings.bukkuEmployeeName || "").trim(),
      device,
      installMode,
      appVersion: APP_VERSION,
    };

    // Write-only text/plain POST avoids CORS preflight on Google Apps Script Web Apps
    fetch(webhookUrl, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Non-fatal: never interrupt user workflow
  }
}

// ---------------- Google Drive & Sheets Provisioning ----------------

async function googleApiFetch(url, accessToken, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    let msg = "";
    try {
      const j = await res.json();
      msg = j?.error?.message || JSON.stringify(j);
    } catch {
      msg = await res.text();
    }
    throw new Error(`Google API (${res.status}): ${msg}`);
  }
  return res.json();
}

async function findDriveItem(accessToken, { name, mimeType, parentId }) {
  const escapedName = name.replace(/'/g, "\\'");
  const clauses = [
    `name = '${escapedName}'`,
    `mimeType = '${mimeType}'`,
    "trashed = false",
  ];
  if (parentId) {
    clauses.push(`'${parentId}' in parents`);
  }
  const q = encodeURIComponent(clauses.join(" and "));
  const data = await googleApiFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,webViewLink)&pageSize=5`,
    accessToken
  );
  return data.files?.[0] || null;
}

async function verifyDriveItemExists(accessToken, fileId) {
  if (!fileId) return false;
  try {
    const data = await googleApiFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        fileId
      )}?fields=id,trashed`,
      accessToken
    );
    return Boolean(data?.id && !data.trashed);
  } catch {
    return false;
  }
}

async function createDriveFolder(accessToken, { name, parentId }) {
  const metadata = {
    name,
    mimeType: "application/vnd.google-apps.folder",
  };
  if (parentId) metadata.parents = [parentId];
  return googleApiFetch(
    "https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink",
    accessToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metadata),
    }
  );
}

async function findOrCreateFolder(accessToken, { name, parentId }) {
  const existing = await findDriveItem(accessToken, {
    name,
    mimeType: "application/vnd.google-apps.folder",
    parentId,
  });
  if (existing) return existing;
  return createDriveFolder(accessToken, { name, parentId });
}

export async function ensureWorkspaceProvisioned(explicitToken) {
  const accessToken = explicitToken || getValidAccessToken();
  if (!accessToken) {
    throw new Error("Not signed in to Google.");
  }

  let settings = loadSettings();
  let rootFolderId = settings.driveRootFolderId;
  let receiptsFolderId = settings.driveReceiptsFolderId;
  let spreadsheetId = settings.spreadsheetId;

  // Verify or find/create Root Folder: "Expense Tracker"
  if (!(await verifyDriveItemExists(accessToken, rootFolderId))) {
    const rootFolder = await findOrCreateFolder(accessToken, {
      name: "Expense Tracker",
    });
    rootFolderId = rootFolder.id;
  }

  // Verify or find/create Receipts Subfolder: "Receipts"
  if (!(await verifyDriveItemExists(accessToken, receiptsFolderId))) {
    const receiptsFolder = await findOrCreateFolder(accessToken, {
      name: "Receipts",
      parentId: rootFolderId,
    });
    receiptsFolderId = receiptsFolder.id;
  }

  // Verify or find/create Master Ledger Spreadsheet: "Expense Ledger"
  let spreadsheetUrl = settings.spreadsheetUrl;
  let createdNewSheet = false;
  if (!(await verifyDriveItemExists(accessToken, spreadsheetId))) {
    const existingSheet = await findDriveItem(accessToken, {
      name: "Expense Ledger",
      mimeType: "application/vnd.google-apps.spreadsheet",
      parentId: rootFolderId,
    });
    if (existingSheet) {
      spreadsheetId = existingSheet.id;
      spreadsheetUrl =
        existingSheet.webViewLink ||
        `https://docs.google.com/spreadsheets/d/${existingSheet.id}/edit`;
    } else {
      const created = await createFormattedLedgerSpreadsheet(accessToken, {
        parentFolderId: rootFolderId,
        categories: settings.categories,
        paymentMethods: settings.paymentMethods,
        bukkuEmployeeName: settings.bukkuEmployeeName || "",
      });
      spreadsheetId = created.spreadsheetId;
      spreadsheetUrl = created.spreadsheetUrl;
      createdNewSheet = true;
    }
  }

  settings = saveSettings({
    driveRootFolderId: rootFolderId,
    driveReceiptsFolderId: receiptsFolderId,
    spreadsheetId,
    spreadsheetUrl,
    ...(createdNewSheet
      ? { dashboardSchemaVersion: CURRENT_DASHBOARD_SCHEMA_VERSION }
      : {}),
  });

  // Auto-upgrade existing Sheet Settings (v3 65xx Expense Codes) & Dashboard formulas
  const needsSchemaUpgrade =
    !createdNewSheet &&
    (settings.dashboardSchemaVersion || 1) < CURRENT_DASHBOARD_SCHEMA_VERSION;

  if (needsSchemaUpgrade) {
    try {
      await repairDashboardTab(accessToken);
      settings = loadSettings();
    } catch {
      // Non-fatal if offline or custom sheet
    }
  } else if (!createdNewSheet) {
    // If connecting to an already-upgraded sheet on a new device, pull saved Categories & Cards
    try {
      await pullSettingsFromSheet(accessToken);
      settings = loadSettings();
    } catch {
      // Non-fatal if user renamed Settings tab
    }
  }

  return settings;
}

// ---------------- 3-Tab Ledger Sheet Builder & Upgrader ----------------

const SETTINGS_MONTH_HELPER_VALUES = [
  ["Available Months (Auto)"],
  [
    '=UNIQUE({TEXT(TODAY(),"yyyy-mm"); IFERROR(FILTER(Transactions!C:C, Transactions!C:C<>"", Transactions!C:C<>"Year-Month"), TEXT(TODAY(),"yyyy-mm"))})',
  ],
];

function buildDashboardRows() {
  const now = new Date();
  const currentYear = String(now.getFullYear());
  const currentYearMonth = `${currentYear}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // Whole-column shift-proof references (never shift when rows are appended/inserted/deleted)
  const normMonth = 'IF(ISNUMBER($B$3), TEXT($B$3,"yyyy-mm"), TRIM(TO_TEXT($B$3)))';
  const normYearPrefix = 'TRIM(TO_TEXT($E$3))&"-*"';

  const dashboardRows = [
    ["SPENDSNAP — EXPENSE LEDGER DASHBOARD", "", "", "", "", "", ""],
    ["", "", "", "", "", "", ""],
    [
      "Selected Month (YYYY-MM):",
      `'${currentYearMonth}`,
      "",
      "Selected Year:",
      currentYear,
      "",
      "",
    ],
    ["", "", "", "", "", "", ""],
    [
      "Month Spend (MYR)",
      `=SUMIFS(Transactions!$F:$F, Transactions!$C:$C, ${normMonth})`,
      "Month Txns",
      `=COUNTIFS(Transactions!$C:$C, ${normMonth})`,
      "Full Year Spend (MYR)",
      `=SUMIFS(Transactions!$F:$F, Transactions!$C:$C, ${normYearPrefix})`,
      "",
    ],
    ["", "", "", "", "", "", ""],
    [
      "Expense Code / Category",
      "Selected Month (MYR)",
      "Full Year (MYR)",
      "",
      "Payment Method / Card",
      "Selected Month (MYR)",
      "Full Year (MYR)",
    ],
  ];

  for (let i = 0; i < 15; i++) {
    const r = 8 + i; // Dashboard row number (1-indexed)
    const sr = 2 + i; // Settings row number (1-indexed)
    dashboardRows.push([
      `=IF(Settings!A${sr}="","",Settings!A${sr})`,
      `=IF(A${r}="","",SUMIFS(Transactions!$F:$F, Transactions!$E:$E, A${r}, Transactions!$C:$C, ${normMonth}))`,
      `=IF(A${r}="","",SUMIFS(Transactions!$F:$F, Transactions!$E:$E, A${r}, Transactions!$C:$C, ${normYearPrefix}))`,
      "",
      `=IF(Settings!C${sr}="","",Settings!C${sr})`,
      `=IF(E${r}="","",SUMIFS(Transactions!$F:$F, Transactions!$G:$G, E${r}, Transactions!$C:$C, ${normMonth}))`,
      `=IF(E${r}="","",SUMIFS(Transactions!$F:$F, Transactions!$G:$G, E${r}, Transactions!$C:$C, ${normYearPrefix}))`,
    ]);
  }

  dashboardRows.push(
    ["", "", "", "", "", "", ""],
    [
      "Annual Month-by-Month Trend",
      "",
      "",
      "",
      "Transactions in Selected Month",
      "",
      "",
    ],
    [
      `=IFERROR(QUERY(Transactions!B:G, "select C, count(F), sum(F) where C starts with '"&TRIM(TO_TEXT(E3))&"-' group by C order by C asc label C 'Year-Month', count(F) 'Txns', sum(F) 'Total (MYR)'", 1), "No transactions for this year yet")`,
      "",
      "",
      "",
      `=IFERROR(QUERY(Transactions!B:I, "select B, D, E, F, G, H, I where C = '"&IF(ISNUMBER(B3),TEXT(B3,"yyyy-mm"),TRIM(TO_TEXT(B3)))&"' order by B desc", 1), "No transactions for selected month yet")`,
      "",
      "",
    ]
  );

  return dashboardRows;
}

function buildBukkuExportRows() {
  const now = new Date();
  const currentYear = String(now.getFullYear());
  const currentYearMonth = `${currentYear}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // Dynamic whole-column formula mirroring Transactions into Bukku's exact B:K Expense Claim columns:
  // Col B: Employee | Col C: Reference No. | Col D: Date (DD/MM/YYYY) | Col E: Due Date (DD/MM/YYYY)
  // Col F: Currency | Col G: Rate | Col H: Account (4-digit 65xx) | Col I: Item Description | Col J: Amount | Col K: Tax
  const bukkuSpillFormula = [
    "=ARRAYFORMULA(IFERROR(LET(",
    'sel, IF(ISNUMBER($C$3), TEXT($C$3, "yyyy-mm"), UPPER(TRIM(TO_TEXT($C$3)))),',
    'emp, IF($F$3 <> "", $F$3, Settings!$G$2),',
    'rawYm, IF(ISNUMBER(Transactions!$C:$C), TEXT(Transactions!$C:$C, "yyyy-mm"), TRIM(TO_TEXT(Transactions!$C:$C))),',
    'isoDt, IF(ISNUMBER(Transactions!$B:$B), TEXT(Transactions!$B:$B, "yyyy-mm-dd"), LEFT(TRIM(TO_TEXT(Transactions!$B:$B)), 10)),',
    'keep, (Transactions!$B:$B <> "") * (Transactions!$B:$B <> "Date") * IF((sel = "ALL") + (sel = ""), 1, rawYm = sel),',
    "tbl, SORT(FILTER({isoDt, Transactions!$D:$D, Transactions!$E:$E, Transactions!$F:$F, Transactions!$G:$G, Transactions!$H:$H, ROW(Transactions!$B:$B)}, keep), 1, TRUE, 7, TRUE),",
    "dtIso, INDEX(tbl, 0, 1),",
    "descCol, INDEX(tbl, 0, 2),",
    "catCol, TO_TEXT(INDEX(tbl, 0, 3)),",
    "amtCol, INDEX(tbl, 0, 4),",
    "pmCol, INDEX(tbl, 0, 5),",
    "remCol, INDEX(tbl, 0, 6),",
    "seqCol, SEQUENCE(ROWS(dtIso), 1, 1, 1),",
    'empCol, IF(LEN(dtIso) >= 0, emp, ""),',
    'blankCol, IF(LEN(dtIso) >= 0, "", ""),',
    'dtBukku, REGEXREPLACE(dtIso, "^([0-9]{4})-([0-9]{2})-([0-9]{2})$", "$3/$2/$1"),',
    'acctCol, IF(REGEXMATCH(catCol, "^[0-9]{4}"), VALUE(REGEXEXTRACT(catCol, "^[0-9]{4}")), catCol),',
    "{seqCol, empCol, blankCol, dtBukku, dtBukku, blankCol, blankCol, acctCol, descCol, amtCol, blankCol, blankCol, pmCol, remCol}",
    '), ""))',
  ].join(" ");

  return [
    [
      "#",
      "SPENDSNAP — BUKKU EXPENSE CLAIM COPY-PASTE EXPORT",
      "", "", "", "", "", "", "", "", "", "", "", "",
    ],
    [
      "#",
      "Copy-Paste Guide: 1) Select Month in C3 & check Employee Name in F3.  2) Highlight B6:K... (all filled rows) -> Copy (Ctrl+C) -> Paste Values into cell B23 of Bukku's purchase-expense-claim-template-my.xlsx.",
      "", "", "", "", "", "", "", "", "", "", "", "",
    ],
    [
      "#",
      "Month (YYYY-MM or ALL):",
      `'${currentYearMonth}`,
      "",
      "Employee Name:",
      "=Settings!G2",
      "",
      "Rows:",
      "=COUNTA(D6:D1000)",
      "=SUM(J6:J1000)",
      "(MYR Total)",
      "", "", "",
    ],
    ["#", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    [
      "#",
      "Employee (1) *",
      "Reference No.",
      "Date (D) *",
      "Due Date (D) (2)",
      "Currency (3)",
      "Rate (4)",
      "Account (5) *",
      "Item Description *",
      "Amount *",
      "Tax (6)",
      "",
      "Payment / Card (Ref)",
      "Remarks (Ref)",
    ],
    [bukkuSpillFormula, "", "", "", "", "", "", "", "", "", "", "", "", ""],
  ];
}

async function applyDashboardAndLedgerFormatting(
  accessToken,
  spreadsheetId,
  { dashboardSheetId, transactionsSheetId, bukkuSheetId, settingsSheetId }
) {
  const tealHeaderBg = { red: 0.06, green: 0.46, blue: 0.43 };
  const whiteBg = { red: 1, green: 1, blue: 1 };
  const darkText = { foregroundColor: { red: 0.06, green: 0.09, blue: 0.16 }, bold: false };
  const whiteText = { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true };
  const currencyFormat = { type: "NUMBER", pattern: "#,##0.00" };

  const requests = [];

  if (typeof transactionsSheetId === "number") {
    requests.push(
      // Header banner on Transactions (Row 1 only)
      {
        repeatCell: {
          range: {
            sheetId: transactionsSheetId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: 9,
          },
          cell: { userEnteredFormat: { backgroundColor: tealHeaderBg, textFormat: whiteText } },
          fields: "userEnteredFormat(backgroundColor,textFormat)",
        },
      },
      // Ensure data rows 2..2000 on Columns A..H have clean white background & normal dark text.
      // Never apply textFormat overrides to Column I (index 8, Receipt Link) so =HYPERLINK(...)
      // retains Google Sheets' native blue underline & mouse-hover preview popup.
      {
        repeatCell: {
          range: {
            sheetId: transactionsSheetId,
            startRowIndex: 1,
            endRowIndex: 2000,
            startColumnIndex: 0,
            endColumnIndex: 8,
          },
          cell: { userEnteredFormat: { backgroundColor: whiteBg, textFormat: darkText } },
          fields: "userEnteredFormat(backgroundColor,textFormat)",
        },
      },
      // Clear any previous textFormat override on Column I (Receipt Link) while keeping white background
      {
        repeatCell: {
          range: {
            sheetId: transactionsSheetId,
            startRowIndex: 1,
            endRowIndex: 2000,
            startColumnIndex: 8,
            endColumnIndex: 9,
          },
          cell: { userEnteredFormat: { backgroundColor: whiteBg } },
          fields: "userEnteredFormat(backgroundColor,textFormat)",
        },
      },
      // Amount column number format on Transactions (Column F -> index 5)
      {
        repeatCell: {
          range: {
            sheetId: transactionsSheetId,
            startRowIndex: 1,
            endRowIndex: 2000,
            startColumnIndex: 5,
            endColumnIndex: 6,
          },
          cell: { userEnteredFormat: { numberFormat: currencyFormat } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      // Force Year-Month column (Column C -> index 2) to Plain Text
      {
        repeatCell: {
          range: {
            sheetId: transactionsSheetId,
            startRowIndex: 1,
            endRowIndex: 2000,
            startColumnIndex: 2,
            endColumnIndex: 3,
          },
          cell: { userEnteredFormat: { numberFormat: { type: "TEXT" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: transactionsSheetId, dimension: "COLUMNS", startIndex: 3, endIndex: 5 },
          properties: { pixelSize: 245 },
          fields: "pixelSize",
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: transactionsSheetId, dimension: "COLUMNS", startIndex: 8, endIndex: 9 },
          properties: { pixelSize: 120 },
          fields: "pixelSize",
        },
      }
    );
  }

  if (typeof settingsSheetId === "number") {
    requests.push(
      {
        repeatCell: {
          range: {
            sheetId: settingsSheetId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: 7,
          },
          cell: { userEnteredFormat: { backgroundColor: tealHeaderBg, textFormat: whiteText } },
          fields: "userEnteredFormat(backgroundColor,textFormat)",
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: settingsSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
          properties: { pixelSize: 265 },
          fields: "pixelSize",
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: settingsSheetId, dimension: "COLUMNS", startIndex: 6, endIndex: 7 },
          properties: { pixelSize: 195 },
          fields: "pixelSize",
        },
      }
    );
  }

  if (typeof dashboardSheetId === "number") {
    requests.push(
      // Dashboard Title banner + Table headers
      {
        repeatCell: {
          range: {
            sheetId: dashboardSheetId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: 7,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: tealHeaderBg,
              textFormat: { ...whiteText, fontSize: 12 },
            },
          },
          fields: "userEnteredFormat(backgroundColor,textFormat)",
        },
      },
      {
        repeatCell: {
          range: {
            sheetId: dashboardSheetId,
            startRowIndex: 6,
            endRowIndex: 7,
            startColumnIndex: 0,
            endColumnIndex: 7,
          },
          cell: { userEnteredFormat: { backgroundColor: tealHeaderBg, textFormat: whiteText } },
          fields: "userEnteredFormat(backgroundColor,textFormat)",
        },
      },
      // Format B3 (Selected Month) strictly as TEXT + Dropdown from Settings!$F$2:$F$60
      {
        repeatCell: {
          range: {
            sheetId: dashboardSheetId,
            startRowIndex: 2,
            endRowIndex: 3,
            startColumnIndex: 1,
            endColumnIndex: 2,
          },
          cell: {
            userEnteredFormat: {
              numberFormat: { type: "TEXT" },
              textFormat: { bold: true },
            },
          },
          fields: "userEnteredFormat(numberFormat,textFormat.bold)",
        },
      },
      {
        setDataValidation: {
          range: {
            sheetId: dashboardSheetId,
            startRowIndex: 2,
            endRowIndex: 3,
            startColumnIndex: 1,
            endColumnIndex: 2,
          },
          rule: {
            condition: {
              type: "ONE_OF_RANGE",
              values: [{ userEnteredValue: "=Settings!$F$2:$F$60" }],
            },
            showCustomUi: true,
            strict: false,
          },
        },
      },
      // KPI spend cells B5 & F5 currency formatting
      {
        repeatCell: {
          range: {
            sheetId: dashboardSheetId,
            startRowIndex: 4,
            endRowIndex: 5,
            startColumnIndex: 1,
            endColumnIndex: 2,
          },
          cell: {
            userEnteredFormat: { numberFormat: currencyFormat, textFormat: { bold: true } },
          },
          fields: "userEnteredFormat(numberFormat,textFormat.bold)",
        },
      },
      {
        repeatCell: {
          range: {
            sheetId: dashboardSheetId,
            startRowIndex: 4,
            endRowIndex: 5,
            startColumnIndex: 5,
            endColumnIndex: 6,
          },
          cell: {
            userEnteredFormat: { numberFormat: currencyFormat, textFormat: { bold: true } },
          },
          fields: "userEnteredFormat(numberFormat,textFormat.bold)",
        },
      },
      // Format Dashboard breakdown currency columns
      {
        repeatCell: {
          range: {
            sheetId: dashboardSheetId,
            startRowIndex: 7,
            endRowIndex: 22,
            startColumnIndex: 1,
            endColumnIndex: 3,
          },
          cell: { userEnteredFormat: { numberFormat: currencyFormat } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        repeatCell: {
          range: {
            sheetId: dashboardSheetId,
            startRowIndex: 7,
            endRowIndex: 22,
            startColumnIndex: 5,
            endColumnIndex: 7,
          },
          cell: { userEnteredFormat: { numberFormat: currencyFormat } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      // Comfortable column widths on Dashboard (wider Col A for 65xx Expense Codes)
      {
        updateDimensionProperties: {
          range: { sheetId: dashboardSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
          properties: { pixelSize: 265 },
          fields: "pixelSize",
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: dashboardSheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 7 },
          properties: { pixelSize: 175 },
          fields: "pixelSize",
        },
      }
    );
  }

  if (typeof bukkuSheetId === "number") {
    const slateHeaderBg = { red: 0.36, green: 0.43, blue: 0.52 };
    const softInstructionBg = { red: 0.94, green: 0.99, blue: 0.98 };
    const editableInputBg = { red: 0.89, green: 0.98, blue: 0.95 };
    const plainDecimalFmt = { type: "NUMBER", pattern: "0.00" };
    const integerCodeFmt = { type: "NUMBER", pattern: "0" };

    requests.push(
      // Row 1 Banner
      {
        repeatCell: {
          range: {
            sheetId: bukkuSheetId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: 14,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: tealHeaderBg,
              textFormat: { ...whiteText, fontSize: 12 },
            },
          },
          fields: "userEnteredFormat(backgroundColor,textFormat)",
        },
      },
      // Row 2 Copy-Paste Instruction Bar
      {
        repeatCell: {
          range: {
            sheetId: bukkuSheetId,
            startRowIndex: 1,
            endRowIndex: 2,
            startColumnIndex: 0,
            endColumnIndex: 14,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: softInstructionBg,
              textFormat: {
                foregroundColor: { red: 0.06, green: 0.36, blue: 0.33 },
                bold: true,
                fontSize: 9,
              },
            },
          },
          fields: "userEnteredFormat(backgroundColor,textFormat)",
        },
      },
      // Row 3 Month Filter C3 (Plain Text + Month Dropdown) & Employee Name F3
      {
        repeatCell: {
          range: {
            sheetId: bukkuSheetId,
            startRowIndex: 2,
            endRowIndex: 3,
            startColumnIndex: 2,
            endColumnIndex: 3,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: editableInputBg,
              numberFormat: { type: "TEXT" },
              textFormat: { bold: true },
            },
          },
          fields: "userEnteredFormat(backgroundColor,numberFormat,textFormat.bold)",
        },
      },
      {
        setDataValidation: {
          range: {
            sheetId: bukkuSheetId,
            startRowIndex: 2,
            endRowIndex: 3,
            startColumnIndex: 2,
            endColumnIndex: 3,
          },
          rule: {
            condition: {
              type: "ONE_OF_RANGE",
              values: [{ userEnteredValue: "=Settings!$F$2:$F$60" }],
            },
            showCustomUi: true,
            strict: false,
          },
        },
      },
      {
        repeatCell: {
          range: {
            sheetId: bukkuSheetId,
            startRowIndex: 2,
            endRowIndex: 3,
            startColumnIndex: 5,
            endColumnIndex: 6,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: editableInputBg,
              textFormat: { bold: true },
            },
          },
          fields: "userEnteredFormat(backgroundColor,textFormat.bold)",
        },
      },
      {
        repeatCell: {
          range: {
            sheetId: bukkuSheetId,
            startRowIndex: 2,
            endRowIndex: 3,
            startColumnIndex: 9,
            endColumnIndex: 10,
          },
          cell: {
            userEnteredFormat: {
              numberFormat: currencyFormat,
              textFormat: { bold: true },
            },
          },
          fields: "userEnteredFormat(numberFormat,textFormat.bold)",
        },
      },
      // Row 5 Column Headers: Col A (#) muted, Cols B:K (Exact Bukku Copy Block) Teal, Cols M:N (Ref) muted
      {
        repeatCell: {
          range: {
            sheetId: bukkuSheetId,
            startRowIndex: 4,
            endRowIndex: 5,
            startColumnIndex: 0,
            endColumnIndex: 1,
          },
          cell: { userEnteredFormat: { backgroundColor: slateHeaderBg, textFormat: whiteText } },
          fields: "userEnteredFormat(backgroundColor,textFormat)",
        },
      },
      {
        repeatCell: {
          range: {
            sheetId: bukkuSheetId,
            startRowIndex: 4,
            endRowIndex: 5,
            startColumnIndex: 1,
            endColumnIndex: 11,
          },
          cell: { userEnteredFormat: { backgroundColor: tealHeaderBg, textFormat: whiteText } },
          fields: "userEnteredFormat(backgroundColor,textFormat)",
        },
      },
      {
        repeatCell: {
          range: {
            sheetId: bukkuSheetId,
            startRowIndex: 4,
            endRowIndex: 5,
            startColumnIndex: 12,
            endColumnIndex: 14,
          },
          cell: { userEnteredFormat: { backgroundColor: slateHeaderBg, textFormat: whiteText } },
          fields: "userEnteredFormat(backgroundColor,textFormat)",
        },
      },
      // Data Rows 6..1000: Plain Text DD/MM/YYYY on D:E, Integer 65xx on H, Plain 0.00 on J
      {
        repeatCell: {
          range: {
            sheetId: bukkuSheetId,
            startRowIndex: 5,
            endRowIndex: 1000,
            startColumnIndex: 3,
            endColumnIndex: 5,
          },
          cell: { userEnteredFormat: { numberFormat: { type: "TEXT" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        repeatCell: {
          range: {
            sheetId: bukkuSheetId,
            startRowIndex: 5,
            endRowIndex: 1000,
            startColumnIndex: 7,
            endColumnIndex: 8,
          },
          cell: { userEnteredFormat: { numberFormat: integerCodeFmt } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        repeatCell: {
          range: {
            sheetId: bukkuSheetId,
            startRowIndex: 5,
            endRowIndex: 1000,
            startColumnIndex: 9,
            endColumnIndex: 10,
          },
          cell: { userEnteredFormat: { numberFormat: plainDecimalFmt } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      // Column widths matching Bukku template layout
      {
        updateDimensionProperties: {
          range: { sheetId: bukkuSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
          properties: { pixelSize: 44 },
          fields: "pixelSize",
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: bukkuSheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 },
          properties: { pixelSize: 170 },
          fields: "pixelSize",
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: bukkuSheetId, dimension: "COLUMNS", startIndex: 2, endIndex: 5 },
          properties: { pixelSize: 120 },
          fields: "pixelSize",
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: bukkuSheetId, dimension: "COLUMNS", startIndex: 5, endIndex: 8 },
          properties: { pixelSize: 100 },
          fields: "pixelSize",
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: bukkuSheetId, dimension: "COLUMNS", startIndex: 8, endIndex: 9 },
          properties: { pixelSize: 265 },
          fields: "pixelSize",
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: bukkuSheetId, dimension: "COLUMNS", startIndex: 9, endIndex: 11 },
          properties: { pixelSize: 105 },
          fields: "pixelSize",
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: bukkuSheetId, dimension: "COLUMNS", startIndex: 11, endIndex: 12 },
          properties: { pixelSize: 24 },
          fields: "pixelSize",
        },
      },
      {
        updateDimensionProperties: {
          range: { sheetId: bukkuSheetId, dimension: "COLUMNS", startIndex: 12, endIndex: 14 },
          properties: { pixelSize: 185 },
          fields: "pixelSize",
        },
      }
    );
  }

  if (requests.length > 0) {
    await googleApiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests }),
      }
    );
  }
}

export async function repairDashboardTab(explicitToken) {
  const accessToken = explicitToken || getValidAccessToken();
  if (!accessToken) {
    throw new Error("Sign in with Google first.");
  }
  const settings = loadSettings();
  if (!settings.spreadsheetId) {
    throw new Error("No Expense Ledger spreadsheet linked yet.");
  }
  const spreadsheetId = settings.spreadsheetId;

  const meta = await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}?fields=sheets.properties`,
    accessToken
  );

  const byTitle = {};
  const propsByTitle = {};
  for (const s of meta.sheets || []) {
    if (s.properties?.title) {
      byTitle[s.properties.title] = s.properties.sheetId;
      propsByTitle[s.properties.title] = s.properties;
    }
  }

  const structRequests = [];
  if (typeof byTitle["Dashboard"] !== "number") {
    structRequests.push({
      addSheet: {
        properties: {
          title: "Dashboard",
          index: 0,
          gridProperties: { rowCount: 80, columnCount: 12, frozenRowCount: 1 },
        },
      },
    });
  }
  if (typeof byTitle["Bukku Export"] !== "number") {
    structRequests.push({
      addSheet: {
        properties: {
          title: "Bukku Export",
          index: 2,
          gridProperties: { rowCount: 1000, columnCount: 15, frozenRowCount: 5 },
        },
      },
    });
  }

  const settingsCols = propsByTitle["Settings"]?.gridProperties?.columnCount || 0;
  if (typeof byTitle["Settings"] === "number" && settingsCols < 8) {
    structRequests.push({
      appendDimension: {
        sheetId: byTitle["Settings"],
        dimension: "COLUMNS",
        length: 8 - settingsCols,
      },
    });
  }

  if (structRequests.length > 0) {
    const structResp = await googleApiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}:batchUpdate`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests: structRequests }),
      }
    );
    for (const rep of structResp.replies || []) {
      const addedProps = rep?.addSheet?.properties;
      if (addedProps?.title) {
        byTitle[addedProps.title] = addedProps.sheetId;
      }
    }
  }

  const dashboardSheetId = byTitle["Dashboard"];
  const bukkuSheetId = byTitle["Bukku Export"];

  // If upgrading from pre-v3 schema, ensure Settings!A:E has current Expense Codes / Cards
  if ((settings.dashboardSchemaVersion || 1) < 3) {
    await writeSettingsColumns(
      accessToken,
      spreadsheetId,
      settings.categories,
      settings.paymentMethods,
      settings.bukkuEmployeeName
    );
  }

  // Clear old Dashboard & Bukku Export formulas before writing fresh whole-column formulas
  await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values:batchClear`,
    accessToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ranges: ["Dashboard!A1:L60", "'Bukku Export'!A1:O30"],
      }),
    }
  );

  const dashboardRows = buildDashboardRows();
  const bukkuRows = buildBukkuExportRows();
  const batchValueData = [
    {
      range: "Settings!F1:F2",
      values: SETTINGS_MONTH_HELPER_VALUES,
    },
    {
      range: settings.bukkuEmployeeName ? "Settings!G1:G2" : "Settings!G1:G1",
      values: settings.bukkuEmployeeName
        ? [["Bukku Employee Name"], [settings.bukkuEmployeeName]]
        : [["Bukku Employee Name"]],
    },
    {
      range: `Dashboard!A1:G${dashboardRows.length}`,
      values: dashboardRows,
    },
    {
      range: `'Bukku Export'!A1:N${bukkuRows.length}`,
      values: bukkuRows,
    },
  ];

  await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values:batchUpdate`,
    accessToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        valueInputOption: "USER_ENTERED",
        data: batchValueData,
      }),
    }
  );

  await applyDashboardAndLedgerFormatting(accessToken, spreadsheetId, {
    dashboardSheetId,
    transactionsSheetId: byTitle["Transactions"],
    bukkuSheetId,
    settingsSheetId: byTitle["Settings"],
  });

  try {
    await restoreTransactionHyperlinks(accessToken, spreadsheetId);
  } catch {
    // Non-fatal if Transactions tab has custom layout
  }

  saveSettings({ dashboardSchemaVersion: CURRENT_DASHBOARD_SCHEMA_VERSION });
  return true;
}

async function restoreTransactionHyperlinks(accessToken, spreadsheetId) {
  const data = await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/Transactions!I2:I2000?valueRenderOption=FORMULA`,
    accessToken
  );
  const rows = data.values || [];
  if (rows.length === 0) return;

  const hasAnyLink = rows.some((r) => String(r?.[0] || "").trim() !== "");
  if (!hasAnyLink) return;

  const normalized = rows.map((r) => [r?.[0] ?? ""]);
  const range = `Transactions!I2:I${1 + normalized.length}`;

  // Clear values first so Google Sheets freshly re-evaluates =HYPERLINK(...) on the
  // clean unformatted cells and re-attaches native blue underline + mouse-hover preview
  await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${encodeURIComponent(range)}:clear`,
    accessToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }
  );

  await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    accessToken,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: normalized }),
    }
  );
}

async function createFormattedLedgerSpreadsheet(
  accessToken,
  { parentFolderId, categories, paymentMethods, bukkuEmployeeName = "" }
) {
  // 1. Create the 4-sheet spreadsheet via Sheets v4 API
  const createBody = {
    properties: {
      title: "Expense Ledger",
      locale: "en_US",
    },
    sheets: [
      {
        properties: {
          sheetId: 100,
          title: "Dashboard",
          gridProperties: { rowCount: 80, columnCount: 12, frozenRowCount: 1 },
        },
      },
      {
        properties: {
          sheetId: 200,
          title: "Transactions",
          gridProperties: { rowCount: 2000, columnCount: 9, frozenRowCount: 1 },
        },
      },
      {
        properties: {
          sheetId: 250,
          title: "Bukku Export",
          gridProperties: { rowCount: 1000, columnCount: 15, frozenRowCount: 5 },
        },
      },
      {
        properties: {
          sheetId: 300,
          title: "Settings",
          gridProperties: { rowCount: 60, columnCount: 8, frozenRowCount: 1 },
        },
      },
    ],
  };

  const sheetResp = await googleApiFetch(
    "https://sheets.googleapis.com/v4/spreadsheets",
    accessToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createBody),
    }
  );

  const spreadsheetId = sheetResp.spreadsheetId;
  const spreadsheetUrl =
    sheetResp.spreadsheetUrl ||
    `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

  // 2. Move spreadsheet into "Expense Tracker" folder in Drive
  try {
    const fileInfo = await googleApiFetch(
      `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?fields=parents`,
      accessToken
    );
    const prevParents = (fileInfo.parents || []).join(",");
    await googleApiFetch(
      `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?addParents=${encodeURIComponent(
        parentFolderId
      )}&removeParents=${encodeURIComponent(prevParents)}&fields=id,parents`,
      accessToken,
      { method: "PATCH" }
    );
  } catch {
    // Non-fatal if root move fails
  }

  // 3. Populate headers, Settings values (+ month helper & Bukku employee), Dashboard, and Bukku Export
  const maxSettingRows = Math.max(categories.length, paymentMethods.length, 15);
  const settingsRows = [
    [
      "Category",
      "",
      "Payment Method",
      "Group",
      "Match Hints / Last 4 Digits",
      SETTINGS_MONTH_HELPER_VALUES[0][0],
      "Bukku Employee Name",
    ],
  ];
  for (let i = 0; i < maxSettingRows; i++) {
    const cat = categories[i] || "";
    const pm = paymentMethods[i];
    settingsRows.push([
      cat,
      "",
      pm ? pm.name : "",
      pm ? pm.group || "card" : "",
      pm ? pm.hint || "" : "",
      i === 0 ? SETTINGS_MONTH_HELPER_VALUES[1][0] : "",
      i === 0 ? bukkuEmployeeName || "" : "",
    ]);
  }

  const dashboardRows = buildDashboardRows();
  const bukkuRows = buildBukkuExportRows();

  await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
    accessToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        valueInputOption: "USER_ENTERED",
        data: [
          {
            range: "Transactions!A1:I1",
            values: [
              [
                "Timestamp",
                "Date",
                "Year-Month",
                "Description",
                "Category",
                "Amount (MYR)",
                "Payment Method",
                "Remarks",
                "Receipt Link",
              ],
            ],
          },
          {
            range: `Settings!A1:G${settingsRows.length}`,
            values: settingsRows,
          },
          {
            range: `Dashboard!A1:G${dashboardRows.length}`,
            values: dashboardRows,
          },
          {
            range: `'Bukku Export'!A1:N${bukkuRows.length}`,
            values: bukkuRows,
          },
        ],
      }),
    }
  );

  // 4. Visual styling, number formatting, and Month Dropdown data validation
  await applyDashboardAndLedgerFormatting(accessToken, spreadsheetId, {
    dashboardSheetId: 100,
    transactionsSheetId: 200,
    bukkuSheetId: 250,
    settingsSheetId: 300,
  });

  return { spreadsheetId, spreadsheetUrl };
}

// ---------------- Monthly Receipt Upload + Row Append ----------------

async function getMonthlyReceiptFolderId(accessToken, receiptsRootId, yearMonth) {
  const [year] = yearMonth.split("-");
  let cache = {};
  try {
    cache = JSON.parse(localStorage.getItem(FOLDER_CACHE_KEY) || "{}");
  } catch {
    cache = {};
  }

  const cacheKey = `${receiptsRootId}_${yearMonth}`;
  if (cache[cacheKey] && (await verifyDriveItemExists(accessToken, cache[cacheKey]))) {
    return cache[cacheKey];
  }

  const yearFolder = await findOrCreateFolder(accessToken, {
    name: year,
    parentId: receiptsRootId,
  });
  const monthFolder = await findOrCreateFolder(accessToken, {
    name: yearMonth,
    parentId: yearFolder.id,
  });

  cache[cacheKey] = monthFolder.id;
  try {
    localStorage.setItem(FOLDER_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // ignore
  }
  return monthFolder.id;
}

async function uploadReceiptToDrive(accessToken, { parentFolderId, filename, base64, mimeType }) {
  const metadata = {
    name: filename,
    parents: [parentFolderId],
  };

  const boundary = "spendsnap_multipart_" + Date.now();
  const metaPart =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) +
    "\r\n" +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;
  const closingPart = `\r\n--${boundary}--`;

  const fileBlob = base64ToBlob(base64, mimeType);
  const multipartBlob = new Blob([metaPart, fileBlob, closingPart], {
    type: `multipart/related; boundary=${boundary}`,
  });

  const uploaded = await googleApiFetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
    accessToken,
    {
      method: "POST",
      body: multipartBlob,
    }
  );

  return (
    uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`
  );
}

export async function syncTransactionToGoogle(txn) {
  const accessToken = getValidAccessToken();
  if (!accessToken) {
    throw new Error("Google session expired. Tap 'Reconnect Google' at the top.");
  }

  const settings = await ensureWorkspaceProvisioned(accessToken);
  const yearMonth = String(txn.date || "").slice(0, 7) || new Date().toISOString().slice(0, 7);

  let receiptUrl = txn.receiptUrl || "";
  if (!receiptUrl && txn.receiptBase64) {
    const monthFolderId = await getMonthlyReceiptFolderId(
      accessToken,
      settings.driveReceiptsFolderId,
      yearMonth
    );
    const filename = buildReceiptFilename({
      date: txn.date,
      description: txn.description,
      amountMyr: txn.amountMyr,
      extension: txn.receiptExtension || "jpg",
    });
    receiptUrl = await uploadReceiptToDrive(accessToken, {
      parentFolderId: monthFolderId,
      filename,
      base64: txn.receiptBase64,
      mimeType: txn.receiptMimeType || "image/jpeg",
    });
  }

  const receiptCell = receiptUrl
    ? `=HYPERLINK("${receiptUrl.replace(/"/g, '""')}", "View Receipt")`
    : "";

  const row = [
    txn.timestamp || formatTimestampLocal(),
    txn.date,
    `'${yearMonth}`, // Force plain text YYYY-MM
    txn.description,
    txn.category,
    Number(Number(txn.amountMyr || 0).toFixed(2)),
    txn.paymentMethod,
    txn.remarks || "",
    receiptCell,
  ];

  await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      settings.spreadsheetId
    )}/values/Transactions!A:I:append?valueInputOption=USER_ENTERED&insertDataOption=OVERWRITE`,
    accessToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [row] }),
    }
  );

  return { receiptUrl, spreadsheetUrl: settings.spreadsheetUrl };
}

export async function syncBatchTransactionsToGoogle({ txns, sharedReceipt }) {
  if (!Array.isArray(txns) || txns.length === 0) {
    throw new Error("No batch transactions to sync.");
  }
  const accessToken = getValidAccessToken();
  if (!accessToken) {
    throw new Error("Google session expired. Tap 'Reconnect Google' at the top.");
  }

  const settings = await ensureWorkspaceProvisioned(accessToken);

  // Determine the primary month (majority YYYY-MM across extracted receipts) for the single A4 Drive file
  const fallbackYm = new Date().toISOString().slice(0, 7);
  const ymCounts = new Map();
  for (const t of txns) {
    const ym = String(t.date || "").slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(ym)) {
      ymCounts.set(ym, (ymCounts.get(ym) || 0) + 1);
    }
  }
  let primaryYearMonth = fallbackYm;
  let bestCount = 0;
  for (const [ym, count] of ymCounts.entries()) {
    if (count > bestCount) {
      bestCount = count;
      primaryYearMonth = ym;
    }
  }

  const primaryDate =
    txns.find((t) => String(t.date || "").startsWith(primaryYearMonth))?.date ||
    txns[0]?.date ||
    `${primaryYearMonth}-01`;
  const totalMyr = txns.reduce((acc, t) => acc + Number(t.amountMyr || 0), 0);

  // Upload the intact A4 sheet ONCE to Drive and link all rows in the batch to it
  let sharedReceiptUrl =
    sharedReceipt?.uploadedUrl || txns.find((t) => t.receiptUrl)?.receiptUrl || "";
  if (!sharedReceiptUrl && sharedReceipt?.base64) {
    const monthFolderId = await getMonthlyReceiptFolderId(
      accessToken,
      settings.driveReceiptsFolderId,
      primaryYearMonth
    );
    const ext =
      String(sharedReceipt.extension || "jpg")
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase() || "jpg";
    const filename = `${primaryDate}_A4-Batch-${txns.length}-Receipts_RM${totalMyr.toFixed(
      2
    )}.${ext}`;
    sharedReceiptUrl = await uploadReceiptToDrive(accessToken, {
      parentFolderId: monthFolderId,
      filename,
      base64: sharedReceipt.base64,
      mimeType: sharedReceipt.mimeType || "image/jpeg",
    });
  }

  const rows = txns.map((txn) => {
    const rowYm = String(txn.date || "").slice(0, 7) || primaryYearMonth;
    const linkUrl = txn.receiptUrl || sharedReceiptUrl;
    const linkLabel = sharedReceipt ? "View A4 Sheet" : "View Receipt";
    const receiptCell = linkUrl
      ? `=HYPERLINK("${linkUrl.replace(/"/g, '""')}", "${linkLabel}")`
      : "";
    return [
      txn.timestamp || formatTimestampLocal(),
      txn.date,
      `'${rowYm}`, // Force plain text YYYY-MM
      txn.description,
      txn.category,
      Number(Number(txn.amountMyr || 0).toFixed(2)),
      txn.paymentMethod,
      txn.remarks || "",
      receiptCell,
    ];
  });

  await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      settings.spreadsheetId
    )}/values/Transactions!A:I:append?valueInputOption=USER_ENTERED&insertDataOption=OVERWRITE`,
    accessToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: rows }),
    }
  );

  return { receiptUrl: sharedReceiptUrl, spreadsheetUrl: settings.spreadsheetUrl };
}

// ---------------- Two-Way Settings Sync with Sheet ----------------

async function writeSettingsColumns(
  accessToken,
  spreadsheetId,
  categories,
  paymentMethods,
  bukkuEmployeeName
) {
  const maxRows = Math.max(categories.length, paymentMethods.length, 20);
  const values = [["Category", "", "Payment Method", "Group", "Match Hints / Last 4 Digits"]];
  for (let i = 0; i < maxRows; i++) {
    const cat = categories[i] || "";
    const pm = paymentMethods[i];
    values.push([
      cat,
      "",
      pm ? pm.name : "",
      pm ? pm.group || "card" : "",
      pm ? pm.hint || "" : "",
    ]);
  }

  await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/Settings!A1:E${values.length}?valueInputOption=USER_ENTERED`,
    accessToken,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    }
  );

  if (typeof bukkuEmployeeName === "string") {
    try {
      await googleApiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
          spreadsheetId
        )}/values/Settings!G1:G2?valueInputOption=USER_ENTERED`,
        accessToken,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            values: [["Bukku Employee Name"], [bukkuEmployeeName]],
          }),
        }
      );
    } catch {
      // Non-fatal if custom sheet grid has < 7 columns
    }
  }
}

export async function pushSettingsToSheet() {
  const accessToken = getValidAccessToken();
  if (!accessToken) return false;
  const settings = await ensureWorkspaceProvisioned(accessToken);
  await writeSettingsColumns(
    accessToken,
    settings.spreadsheetId,
    settings.categories,
    settings.paymentMethods,
    settings.bukkuEmployeeName || ""
  );
  return true;
}

export async function pullSettingsFromSheet(explicitToken) {
  const accessToken = explicitToken || getValidAccessToken();
  const settings = loadSettings();
  if (!accessToken || !settings.spreadsheetId) return null;

  let data;
  try {
    data = await googleApiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        settings.spreadsheetId
      )}/values/Settings!A2:G50`,
      accessToken
    );
  } catch {
    data = await googleApiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        settings.spreadsheetId
      )}/values/Settings!A2:E50`,
      accessToken
    );
  }

  const rows = data.values || [];
  const categories = [];
  const paymentMethods = [];

  for (const r of rows) {
    const cat = String(r[0] || "").trim();
    if (cat) categories.push(cat);
    const pmName = String(r[2] || "").trim();
    if (pmName) {
      const group = String(r[3] || "").trim().toLowerCase() === "quick" ? "quick" : "card";
      const hint = String(r[4] || "").trim();
      paymentMethods.push({ name: pmName, group, hint });
    }
  }

  const sheetEmployeeName = String(rows[0]?.[6] || "").trim();
  const patch = {};
  if (categories.length > 0) patch.categories = categories;
  if (paymentMethods.length > 0) patch.paymentMethods = paymentMethods;
  if (sheetEmployeeName) patch.bukkuEmployeeName = sheetEmployeeName;
  if (Object.keys(patch).length > 0) {
    return saveSettings(patch);
  }
  return settings;
}

export async function fetchRecentSheetSummary() {
  const accessToken = getValidAccessToken();
  const settings = loadSettings();
  if (!accessToken || !settings.spreadsheetId) return null;

  const data = await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      settings.spreadsheetId
    )}/values/Transactions!A2:I500`,
    accessToken
  );

  const rows = data.values || [];
  return rows
    .map((r, idx) => ({
      sheetRow: idx + 2,
      timestamp: r[0] || "",
      date: r[1] || "",
      yearMonth: r[2] || "",
      description: r[3] || "",
      category: r[4] || "",
      amountMyr: Number(String(r[5] || "0").replace(/[^0-9.-]/g, "")) || 0,
      paymentMethod: r[6] || "",
      remarks: r[7] || "",
    }))
    .reverse();
}
