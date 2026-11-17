// Gemini Interactions API (v1) multimodal receipt, screenshot, and A4 multi-receipt parser
// Uses current models: gemini-4-hydrogen (default) or gemini-3.5-flash-lite

import { todayISO } from "./config.js";

const INTERACTIONS_ENDPOINT = "https://generativelanguage.googleapis.com/v1/interactions";

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

async function callGeminiInteractions({ apiKey, model, prompt, receipt, schema }) {
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

  const body = {
    model,
    store: false,
    input: [
      {
        type: "user_input",
        content: [{ type: "text", text: prompt }, mediaBlock],
      },
    ],
    response_format: {
      type: "text",
      mime_type: "application/json",
      schema,
    },
  };

  const res = await fetch(INTERACTIONS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": trimmedKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const errJson = await res.json();
      detail = errJson?.error?.message || JSON.stringify(errJson);
    } catch {
      detail = await res.text();
    }
    throw new Error(`Gemini API error (${res.status}): ${detail}`);
  }

  const interaction = await res.json();
  const outputText = extractOutputText(interaction);
  if (!outputText) {
    throw new Error("Gemini returned an empty response. Please try scanning again.");
  }

  try {
    return JSON.parse(outputText);
  } catch {
    throw new Error("Could not parse structured JSON from Gemini response.");
  }
}

export async function analyzeReceiptWithGemini({
  receipt,
  apiKey,
  model = "gemini-4-hydrogen",
  categories,
  paymentMethods,
  baseCurrency = "MYR",
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

  const parsed = await callGeminiInteractions({
    apiKey,
    model,
    prompt,
    receipt,
    schema,
  });

  return normalizeParsedItem(parsed, {
    categoryList,
    paymentMethods,
    baseCurrency,
    today,
  });
}

export async function analyzeMultiReceiptsWithGemini({
  receipt,
  apiKey,
  model = "gemini-4-hydrogen",
  categories,
  paymentMethods,
  baseCurrency = "MYR",
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

  const parsed = await callGeminiInteractions({
    apiKey,
    model,
    prompt,
    receipt,
    schema,
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
