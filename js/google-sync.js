// Google Workspace / Google Account OAuth (drive.file) + Drive Monthly Folders + 3-Tab Ledger Sheet

import { base64ToBlob, buildReceiptFilename } from "./image-utils.js";
import { loadSettings, saveSettings, formatTimestampLocal } from "./config.js";

const SCOPES = "https://www.googleapis.com/auth/drive.file email profile";
const TOKEN_STORAGE_KEY = "spendsnap_oauth_token_v1";
const FOLDER_CACHE_KEY = "spendsnap_folder_cache_v1";
export const CURRENT_DASHBOARD_SCHEMA_VERSION = 2;

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
              driveRootFolderId: "",
              driveReceiptsFolderId: "",
              spreadsheetId: "",
              spreadsheetUrl: "",
              dashboardSchemaVersion: 1,
            });
          } else if (profile.email) {
            saveSettings({ userEmail: profile.email });
          }
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

  // Auto-upgrade existing v1 Sheet Dashboard formulas (shift-proof whole-column SUMIFS/QUERY)
  if (
    !createdNewSheet &&
    (settings.dashboardSchemaVersion || 1) < CURRENT_DASHBOARD_SCHEMA_VERSION
  ) {
    try {
      await repairDashboardTab(accessToken);
      settings = loadSettings();
    } catch {
      // Non-fatal if offline or custom sheet
    }
  }

  // If connecting to an existing sheet on a new device, pull their saved Categories & Cards
  if (!createdNewSheet) {
    try {
      await pullSettingsFromSheet(accessToken);
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
    ["SPENDSNAP — PERSONAL SPENDING DASHBOARD", "", "", "", "", "", ""],
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
      "Category",
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

async function applyDashboardAndLedgerFormatting(
  accessToken,
  spreadsheetId,
  { dashboardSheetId, transactionsSheetId, settingsSheetId }
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
      // Ensure data rows 2..2000 have clean white background & normal dark text
      {
        repeatCell: {
          range: {
            sheetId: transactionsSheetId,
            startRowIndex: 1,
            endRowIndex: 2000,
            startColumnIndex: 0,
            endColumnIndex: 9,
          },
          cell: { userEnteredFormat: { backgroundColor: whiteBg, textFormat: darkText } },
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
          range: { sheetId: transactionsSheetId, dimension: "COLUMNS", startIndex: 3, endIndex: 4 },
          properties: { pixelSize: 240 },
          fields: "pixelSize",
        },
      }
    );
  }

  if (typeof settingsSheetId === "number") {
    requests.push({
      repeatCell: {
        range: {
          sheetId: settingsSheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: 6,
        },
        cell: { userEnteredFormat: { backgroundColor: tealHeaderBg, textFormat: whiteText } },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    });
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
      // Comfortable column widths on Dashboard
      {
        updateDimensionProperties: {
          range: { sheetId: dashboardSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 7 },
          properties: { pixelSize: 175 },
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
  for (const s of meta.sheets || []) {
    if (s.properties?.title) {
      byTitle[s.properties.title] = s.properties.sheetId;
    }
  }

  let dashboardSheetId = byTitle["Dashboard"];
  if (typeof dashboardSheetId !== "number") {
    const added = await googleApiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}:batchUpdate`,
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              addSheet: {
                properties: {
                  title: "Dashboard",
                  index: 0,
                  gridProperties: { rowCount: 80, columnCount: 12, frozenRowCount: 1 },
                },
              },
            },
          ],
        }),
      }
    );
    dashboardSheetId = added.replies?.[0]?.addSheet?.properties?.sheetId;
  }

  // Clear old Dashboard formulas before writing fresh whole-column formulas
  await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/Dashboard!A1:L60:clear`,
    accessToken,
    { method: "POST" }
  );

  const dashboardRows = buildDashboardRows();
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
        data: [
          {
            range: "Settings!F1:F2",
            values: SETTINGS_MONTH_HELPER_VALUES,
          },
          {
            range: `Dashboard!A1:G${dashboardRows.length}`,
            values: dashboardRows,
          },
        ],
      }),
    }
  );

  await applyDashboardAndLedgerFormatting(accessToken, spreadsheetId, {
    dashboardSheetId,
    transactionsSheetId: byTitle["Transactions"],
    settingsSheetId: byTitle["Settings"],
  });

  saveSettings({ dashboardSchemaVersion: CURRENT_DASHBOARD_SCHEMA_VERSION });
  return true;
}

async function createFormattedLedgerSpreadsheet(
  accessToken,
  { parentFolderId, categories, paymentMethods }
) {
  // 1. Create the 3-sheet spreadsheet via Sheets v4 API
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
          sheetId: 300,
          title: "Settings",
          gridProperties: { rowCount: 60, columnCount: 6, frozenRowCount: 1 },
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

  // 3. Populate headers, Settings values (+ month dropdown helper), and Dashboard formulas
  const maxSettingRows = Math.max(categories.length, paymentMethods.length, 15);
  const settingsRows = [
    [
      "Category",
      "",
      "Payment Method",
      "Group",
      "Match Hints / Last 4 Digits",
      SETTINGS_MONTH_HELPER_VALUES[0][0],
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
    ]);
  }

  const dashboardRows = buildDashboardRows();

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
            range: `Settings!A1:F${settingsRows.length}`,
            values: settingsRows,
          },
          {
            range: `Dashboard!A1:G${dashboardRows.length}`,
            values: dashboardRows,
          },
        ],
      }),
    }
  );

  // 4. Visual styling, number formatting, and Month Dropdown data validation
  await applyDashboardAndLedgerFormatting(accessToken, spreadsheetId, {
    dashboardSheetId: 100,
    transactionsSheetId: 200,
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

// ---------------- Two-Way Settings Sync with Sheet ----------------

export async function pushSettingsToSheet() {
  const accessToken = getValidAccessToken();
  if (!accessToken) return false;
  const settings = await ensureWorkspaceProvisioned(accessToken);

  const maxRows = Math.max(settings.categories.length, settings.paymentMethods.length, 20);
  const values = [["Category", "", "Payment Method", "Group", "Match Hints / Last 4 Digits"]];
  for (let i = 0; i < maxRows; i++) {
    const cat = settings.categories[i] || "";
    const pm = settings.paymentMethods[i];
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
      settings.spreadsheetId
    )}/values/Settings!A1:E${values.length}?valueInputOption=USER_ENTERED`,
    accessToken,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    }
  );
  return true;
}

export async function pullSettingsFromSheet(explicitToken) {
  const accessToken = explicitToken || getValidAccessToken();
  const settings = loadSettings();
  if (!accessToken || !settings.spreadsheetId) return null;

  const data = await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      settings.spreadsheetId
    )}/values/Settings!A2:E50`,
    accessToken
  );

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

  const patch = {};
  if (categories.length > 0) patch.categories = categories;
  if (paymentMethods.length > 0) patch.paymentMethods = paymentMethods;
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
