// Gemini Interactions API (v1) multimodal receipt & online screenshot parser
// Uses current models: gemini-4-hydrogen (default) or gemini-3.5-flash-lite

import { todayISO } from "./config.js";

const INTERACTIONS_ENDPOINT = "https://generativelanguage.googleapis.com/v1/interactions";

export async function analyzeReceiptWithGemini({
  receipt,
  apiKey,
  model = "gemini-4-hydrogen",
  categories,
  paymentMethods,
  baseCurrency = "MYR",
}) {
  const trimmedKey = String(apiKey || "").trim();
  if (!trimmedKey) {
    throw new Error("Missing Gemini API Key. Open Settings (top right) to paste your Gemini API key.");
  }

  const categoryList = categories.length ? categories : ["Meals", "Others"];
  const methodNames = paymentMethods.map((m) => m.name);
  const methodHintsText = paymentMethods
    .map((m) => `- "${m.name}"${m.hint ? ` (match hints / last-4 digits: ${m.hint})` : ""}`)
    .join("\n");

  const schema = {
    type: "object",
    properties: {
      date: {
        type: "string",
        description:
          "Transaction date in strict YYYY-MM-DD format. Note: Malaysian & Commonwealth receipts use DD/MM/YYYY (day first, then month).",
      },
      description: {
        type: "string",
        description:
          "Concise Merchant Name + brief item or service summary (e.g., 'Shell — RON95 Petrol', 'Village Grocer — Groceries', 'GrabFood — Dinner', 'Shopee — USB Cable').",
      },
      amount: {
        type: "number",
        description:
          "Final total amount paid (after SST, service tax, discounts, or 5-sen cash rounding).",
      },
      currency: {
        type: "string",
        description:
          "3-letter ISO 4217 currency code on the receipt. 'RM' or no symbol on a Malaysian receipt means 'MYR'.",
      },
      category: {
        type: "string",
        enum: categoryList,
        description: "Best matching spending category from the user's allowed list.",
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
          "Optional brief useful note (e.g. online order/reference number if online screenshot, or leave empty string).",
      },
    },
    required: [
      "date",
      "description",
      "amount",
      "currency",
      "category",
      "payment_method",
      "card_last4",
      "remarks",
    ],
  };

  const today = todayISO();
  const prompt = `Analyze this receipt, payment slip, or online transaction screenshot/PDF and extract the spending details.

Context & Rules:
1. Today's date is ${today}. Default local country is Malaysia (${baseCurrency}, symbol RM).
2. Date parsing: Malaysian receipts print dates as DD/MM/YYYY or DD-MM-YY (day first!). Convert carefully to YYYY-MM-DD. If no date is visible, use ${today}.
3. Amount: Extract the GRAND TOTAL / final amount charged (after 6%/8% SST, 10% service charge, vouchers, or Malaysia 5-sen rounding).
4. Category guide:
   - Restaurants, cafes, hawker, food delivery (GrabFood/Foodpanda), drinks -> "Meals" (if present)
   - Supermarkets, Jaya Grocer, Lotus's, AEON, 99 Speedmart, fresh market -> "Groceries" (if present)
   - Petrol (Shell, Petronas, Caltex), Touch 'n Go toll/parking, Grab ride, car service/tyres -> "Transportation & Vehicles" (if present)
   - Kids school, toys, tuition, pediatric, children's clothes -> "Daughter" (if present)
   - Otherwise choose the closest allowed category.
5. Payment Method matching — choose from these user methods when clues appear:
${methodHintsText}
   - If the receipt is from a Shell station and paid by Visa/credit card, prefer "RHB Shell" if available.
   - If card last-4 digits on the slip match a method's hint, select that exact card.
   - If nothing indicates how it was paid, return "UNKNOWN".`;

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
    input: [{ type: "text", text: prompt }, mediaBlock],
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

  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    throw new Error("Could not parse structured JSON from Gemini response.");
  }

  // Deterministic card_last4 override if user configured last-4 digits in Settings hints
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

  // Validate date format YYYY-MM-DD
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(parsed.date || "")
    ? parsed.date
    : today;

  return {
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
