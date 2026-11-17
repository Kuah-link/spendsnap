// Gemini Interactions API (v1) multimodal receipt, screenshot, and A4 multi-receipt parser
// Uses current models (gemini-4-hydrogen, gemini-3.5-flash-lite, gemini-3.1-flash-lite, gemini-4-argon)
// with automatic multi-model failover on HTTP 503 (high demand) / 429 (rate limit) spikes.

import { todayISO } from "./config.js";

const INTERACTIONS_ENDPOINT = "https://generativelanguage.googleapis.com/v1/interactions";
const REQUEST_TIMEOUT_MS = 38_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildModelFallbackChain(requestedModel, { isBatch = false } = {}) {
  let primary = String(requestedModel || "gemini-4-hydrogen").trim();
  // Automatically upgrade any deprecated legacy model IDs
  if (!primary || /^gemini-(1\.|2\.)/i.test(primary)) {
    primary = "gemini-4-hydrogen";
  }
  const pool = isBatch
    ? [
        primary,
        "gemini-4-hydrogen",
        "gemini-4-argon",
        "gemini-3.5-flash-lite",
        "gemini-3.1-flash-lite",
      ]
    : [
        primary,
        "gemini-4-hydrogen",
        "gemini-3.5-flash-lite",
        "gemini-3.1-flash-lite",
        "gemini-4-argon",
      ];
  return [...new Set(pool)];
}

function getGenerationConfigForModel(modelId, { isBatch = false } = {}) {
  const m = String(modelId || "");
  if (m.startsWith("gemini-4-")) {
    // Gemini 4 Hydrogen defaults to "high"; "low" (single) / "medium" (A4 batch) cuts latency & quota 3x
    return { thinking_level: isBatch ? "medium" : "low" };
  }
  if (m.includes("3.5-flash-lite") || m.includes("3.1-flash-lite")) {
    return { thinking_level: isBatch ? "low" : "minimal" };
  }
  return undefined;
}

function isRetryableOrOverloadedError(status, detail = "") {
  // 503 = high demand spike, 429 = rate/quota limit, 5xx = server transient, 404 = model unavailable on tier
  if ([404, 408, 429, 500, 502, 503, 504].includes(status)) return true;
  if (/high demand|overloaded|unavailable|exhausted|try again|timeout/i.test(detail)) {
    return true;
  }
  return false;
}

const EXPENSE_CODE_GUIDE = `   - "6519 - Travel Expense": Petrol stations (Shell, Petron, Petronas, Caltex, BHP), car park tickets & mall/building parking (Menara Etiqa, Pavilion, 1Utama, Autopay), Touch 'n Go tolls & parking, flights, hotels & business trip accommodation.
   - "6518 - Meal & Entertainment": Restaurants, cafes, kopitiam, bakeries, food & beverage, client dining, food delivery.
   - "6512 - Telephone & Internet": Telco, mobile phone & broadband bills (TM Net, Unifi, Maxis, CelcomDigi, U Mobile, TIME).
   - "6511 - Water & Electricity": TNB (Tenaga Nasional), Air Selangor, water & electricity utility bills.
   - "6516 - Office Expense": IT gadgets, computer accessories, cables, mouse, adapters (UGreen, Razer, Prolink), office hardware & pantry supplies.
   - "6517 - Printing & Stationery": Bookstores (Popular), printing, photocopying, paper, pens, folders, stationery.
   - "6514 - Accounting & Other Professional Fees": Accounting, audit, tax, secretarial, consultancy fees, as well as vehicle maintenance/service, car insurance & roadtax.
   - "6513 - Legal Fees": SSM renewal, legal fees, stamping, statutory filings.
   - "6522 - Subscription": Software & SaaS subscriptions, Bukku, cloud/app renewals, digital memberships.
   - "6520 - Daily Commute Expense": Grab/e-hailing rides, taxi, LRT/MRT/KTM/bus local commute.
   - "6507 - General Expense": Device/phone/equipment repair, courier/lorry/delivery (The Lorry, Lalamove, Pos Laju), medical/optometry/pharmacy, or general expenses not fitting above.
   - (If personal categories like "Meals" or "Groceries" are in the allowed list instead, pick the closest allowed category.)`;

function buildReceiptItemProperties(categoryList, methodNames) {
  return {
    date: {
      type: "string",
      description:
        "Transaction date in strict YYYY-MM-DD format. Note: Malaysian & Commonwealth receipts use DD/MM/YYYY (day first, then month).",
    },
    description: {
      type: "string",
      description:
        "Concise Merchant Name + brief item or service summary (e.g., 'Shell Seremban — Petrol', 'Menara Etiqa — Parking', 'TM Net — Broadband').",
    },
    amount: {
      type: "number",
      description:
        "Final total amount paid on this receipt (after SST, service tax, discounts, or 5-sen cash rounding).",
    },
    currency: {
      type: "string",
      description:
        "3-letter ISO 4217 currency code on the receipt. 'RM' or no symbol on a Malaysian receipt means 'MYR'.",
    },
    category: {
      type: "string",
      enum: categoryList,
      description: "Best matching Expense Code / Category from the allowed list.",
    },
    payment_method: {
      type: "string",
      enum: [...methodNames, "UNKNOWN"],
      description:
        "Matched payment method from the user's list based on receipt clues (CASH, DuitNow QR/TnG, FPX/Online, AMEX, Shell station card, or card last 4 digits), or 'UNKNOWN' if unclear.",
    },
    card_last4: {
      type: "string",
      description:
        "Last 4 digits of credit/debit card if printed on the slip (e.g. '4821'), otherwise empty string.",
    },
    remarks: {
      type: "string",
      description:
        "Optional brief useful note (e.g. invoice/order ref, car plate, or date range for monthly statements), otherwise empty string.",
    },
  };
}

function normalizeParsedItem(parsed, { categoryList, paymentMethods, baseCurrency, today }) {
  let matchedMethod =
    parsed.payment_method && parsed.payment_method !== "UNKNOWN"
      ? parsed.payment_method
      : "";

  const last4 = String(parsed.card_last4 || "").replace(/\D/g, "");
  if (last4.length === 4) {
    const exactCard = paymentMethods.find((m) =>
      String(m.hint || "").includes(last4)
    );
    if (exactCard) {
      matchedMethod = exactCard.name;
    }
  }

  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(parsed.date || "")
    ? parsed.date
    : today;

  return {
    positionLabel: String(parsed.position_label || "").trim(),
    date: validDate,
    description: String(parsed.description || "").trim(),
    amount: Number.isFinite(Number(parsed.amount)) ? Number(parsed.amount) : 0,
    currency: String(parsed.currency || baseCurrency)
      .toUpperCase()
      .replace(/^RM$/, "MYR")
      .trim(),
    category: categoryList.includes(parsed.category)
      ? parsed.category
      : categoryList[0],
    paymentMethod: matchedMethod,
    cardLast4: last4,
    remarks: String(parsed.remarks || "").trim(),
  };
}

async function sendSingleModelInteraction({
  trimmedKey,
  modelId,
  prompt,
  mediaBlock,
  schema,
  isBatch,
}) {
  const generationConfig = getGenerationConfigForModel(modelId, { isBatch });
  const body = {
    model: modelId,
    store: false,
    input: [
      {
        type: "user_input",
        content: [{ type: "text", text: prompt }, mediaBlock],
      },
    ],
    ...(generationConfig ? { generation_config: generationConfig } : {}),
    response_format: {
      type: "text",
      mime_type: "application/json",
      schema,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(INTERACTIONS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": trimmedKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (netErr) {
    const err = new Error(
      netErr?.name === "AbortError"
        ? `${modelId} timed out after 38s`
        : netErr?.message || "Network connection error"
    );
    err.retryable = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const errJson = await res.json();
      detail = errJson?.error?.message || JSON.stringify(errJson);
    } catch {
      detail = await res.text();
    }
    const err = new Error(`Gemini API error (${res.status}): ${detail}`);
    err.status = res.status;
    err.retryable = isRetryableOrOverloadedError(res.status, detail);
    throw err;
  }

  const interaction = await res.json();
  const outputText = extractOutputText(interaction);
  if (!outputText) {
    const err = new Error("Gemini returned an empty response.");
    err.retryable = true;
    throw err;
  }

  try {
    return JSON.parse(outputText);
  } catch {
    const err = new Error("Could not parse structured JSON from Gemini response.");
    err.retryable = true;
    throw err;
  }
}

async function callGeminiInteractions({
  apiKey,
  model,
  prompt,
  receipt,
  schema,
  isBatch = false,
  onStatus,
}) {
  const trimmedKey = String(apiKey || "").trim();
  if (!trimmedKey) {
    throw new Error(
      "Missing Gemini API Key. Open Settings (top right) to paste your Gemini API key."
    );
  }

  const mediaBlock = receipt.isPdf
    ? {
        type: "document",
        data: receipt.base64,
        mime_type: "application/pdf",
      }
    : {
        type: "image",
        data: receipt.base64,
        mime_type: receipt.mimeType || "image/jpeg",
      };

  const chain = buildModelFallbackChain(model, { isBatch });
  let lastError = null;

  // Pass 1: try user's chosen model first, then automatically fail over across independent Gemini models
  for (let i = 0; i < chain.length; i++) {
    const candidateModel = chain[i];
    try {
      const parsed = await sendSingleModelInteraction({
        trimmedKey,
        modelId: candidateModel,
        prompt,
        mediaBlock,
        schema,
        isBatch,
      });
      return { parsed, usedModel: candidateModel, switchedModel: i > 0 };
    } catch (err) {
      lastError = err;
      if (!err.retryable) {
        throw err;
      }
      const nextModel = chain[i + 1];
      if (nextModel) {
        onStatus?.(
          `✨ ${candidateModel} busy — auto-switching to ${nextModel}...`
        );
        await sleep(450 + Math.floor(Math.random() * 350));
      }
    }
  }

  // Pass 2: if every model pool spiked simultaneously, wait ~1.8s with jitter and retry top 2 models
  const retryTop = chain.slice(0, 2);
  for (let r = 0; r < retryTop.length; r++) {
    const retryModel = retryTop[r];
    onStatus?.(`✨ High Gemini traffic — retrying ${retryModel}...`);
    await sleep(1600 + r * 900 + Math.floor(Math.random() * 500));
    try {
      const parsed = await sendSingleModelInteraction({
        trimmedKey,
        modelId: retryModel,
        prompt,
        mediaBlock,
        schema,
        isBatch,
      });
      return {
        parsed,
        usedModel: retryModel,
        switchedModel: retryModel !== chain[0],
      };
    } catch (err) {
      lastError = err;
      if (!err.retryable) throw err;
    }
  }

  throw (
    lastError ||
    new Error("All Gemini models are temporarily experiencing high demand. Tap Re-scan in a few seconds.")
  );
}

export async function analyzeReceiptWithGemini({
  receipt,
  apiKey,
  model = "gemini-4-hydrogen",
  categories,
  paymentMethods,
  baseCurrency = "MYR",
  onStatus,
}) {
  const categoryList = categories.length
    ? categories
    : ["6519 - Travel Expense", "6507 - General Expense"];
  const methodNames = paymentMethods.map((m) => m.name);
  const methodHintsText = paymentMethods
    .map((m) => `- "${m.name}"${m.hint ? ` (match hints / last-4 digits: ${m.hint})` : ""}`)
    .join("\n");

  const itemProps = buildReceiptItemProperties(categoryList, methodNames);
  const schema = {
    type: "object",
    properties: itemProps,
    required: Object.keys(itemProps),
  };

  const today = todayISO();
  const prompt = `Analyze this receipt, payment slip, or online transaction screenshot/PDF and extract the spending details.

Context & Rules:
1. Today's date is ${today}. Default local country is Malaysia (${baseCurrency}, symbol RM).
2. Date parsing: Malaysian receipts print dates as DD/MM/YYYY or DD-MM-YY (day first!). Convert carefully to YYYY-MM-DD. If no date is visible, use ${today}.
3. Amount: Extract the GRAND TOTAL / final amount charged (after 6%/8% SST, 10% service charge, vouchers, or Malaysia 5-sen rounding).
4. Expense Code / Category guide (pick the exact matching string from the allowed enum):
${EXPENSE_CODE_GUIDE}
5. Payment Method matching — choose from these user methods when clues appear:
${methodHintsText}
   - If the receipt is from a Shell station and paid by Visa/credit card, prefer "RHB Shell" if available.
   - If card last-4 digits on the slip match a method's hint, select that exact card.
   - If nothing indicates how it was paid, return "UNKNOWN".`;

  const { parsed, usedModel, switchedModel } = await callGeminiInteractions({
    apiKey,
    model,
    prompt,
    receipt,
    schema,
    isBatch: false,
    onStatus,
  });

  const normalized = normalizeParsedItem(parsed, {
    categoryList,
    paymentMethods,
    baseCurrency,
    today,
  });
  normalized.usedModel = usedModel;
  normalized.switchedModel = switchedModel;
  return normalized;
}

export async function analyzeMultiReceiptsWithGemini({
  receipt,
  apiKey,
  model = "gemini-4-hydrogen",
  categories,
  paymentMethods,
  baseCurrency = "MYR",
  onStatus,
}) {
  const categoryList = categories.length
    ? categories
    : ["6519 - Travel Expense", "6507 - General Expense"];
  const methodNames = paymentMethods.map((m) => m.name);
  const methodHintsText = paymentMethods
    .map((m) => `- "${m.name}"${m.hint ? ` (match hints / last-4 digits: ${m.hint})` : ""}`)
    .join("\n");

  const baseProps = buildReceiptItemProperties(categoryList, methodNames);
  const itemProperties = {
    position_label: {
      type: "string",
      description:
        "Short human-friendly location on the A4 sheet so the user can verify it easily (e.g., '#1 Top-Left', '#2 Top-Right', '#3 Middle-Left', '#4 Bottom').",
    },
    ...baseProps,
  };

  const schema = {
    type: "object",
    properties: {
      receipts: {
        type: "array",
        description:
          "Every distinct receipt or bill found on the A4 sheet/document, ordered top-to-bottom, left-to-right.",
        items: {
          type: "object",
          properties: itemProperties,
          required: Object.keys(itemProperties),
        },
      },
    },
    required: ["receipts"],
  };

  const today = todayISO();
  const prompt = `This image/PDF shows an A4 sheet (or multi-receipt page) with MULTIPLE physical receipts/tickets stuck onto it for monthly accounting documentation.

Carefully inspect the ENTIRE page from top-to-bottom, left-to-right, and extract EVERY distinct receipt into the "receipts" array.

Critical Rules:
1. Do NOT miss small receipts such as parking tickets, toll slips, or faded petrol receipts.
2. Avoid double-counting paired slips: If a credit card terminal slip and a merchant tax invoice are stuck next to/overlapping each other for the EXACT SAME single purchase (matching date/time & total amount), merge them into ONE receipt entry (using the merchant receipt for description and the card slip for payment method / card last-4). Separate purchases (even from the same petrol station on different dates/amounts) MUST be separate entries!
3. Today's date is ${today}. Default currency is Malaysia (${baseCurrency}, RM).
4. Malaysian dates are DD/MM/YYYY or DD-MM-YY (day first, then month!). Convert each receipt's own printed date accurately to YYYY-MM-DD.
5. Extract each receipt's final GRAND TOTAL paid (after SST, service charge, rounding).
6. Expense Code / Category guide (pick from the allowed enum):
${EXPENSE_CODE_GUIDE}
7. Payment Method matching:
${methodHintsText}
   - Return "UNKNOWN" if a receipt does not show how it was paid.`;

  const { parsed, usedModel, switchedModel } = await callGeminiInteractions({
    apiKey,
    model,
    prompt,
    receipt,
    schema,
    isBatch: true,
    onStatus,
  });

  const rawList = Array.isArray(parsed?.receipts) ? parsed.receipts : [];
  return rawList.map((item, idx) => {
    const norm = normalizeParsedItem(item, {
      categoryList,
      paymentMethods,
      baseCurrency,
      today,
    });
    if (!norm.positionLabel) {
      norm.positionLabel = `#${idx + 1}`;
    }
    norm.usedModel = usedModel;
    norm.switchedModel = switchedModel;
    return norm;
  });
}

function extractOutputText(interaction) {
  if (typeof interaction?.output_text === "string" && interaction.output_text) {
    return interaction.output_text;
  }
  const steps = Array.isArray(interaction?.steps) ? interaction.steps : [];
  const trailingTextParts = [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step?.type === "model_output" && Array.isArray(step.content)) {
      const stepTexts = step.content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
      trailingTextParts.unshift(stepTexts);
    } else if (trailingTextParts.length > 0) {
      break;
    }
  }
  return trailingTextParts.join("").trim();
}
