// Foreign currency helper for occasional travel (converts to MYR & tags Remarks)

const FX_CACHE_KEY = "spendsnap_fx_cache_v1";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Offline fallback approximate rates -> MYR (1 unit of foreign currency in MYR)
const FALLBACK_TO_MYR = {
  MYR: 1,
  SGD: 3.32,
  THB: 0.128,
  JPY: 0.029,
  IDR: 0.00028,
  CNY: 0.61,
  TWD: 0.138,
  KRW: 0.0032,
  VND: 0.00018,
  HKD: 0.57,
  USD: 4.42,
  EUR: 4.72,
  GBP: 5.62,
  AUD: 2.9,
};

export async function getRateToBase(fromCurrency, baseCurrency = "MYR") {
  const from = String(fromCurrency || baseCurrency).toUpperCase().trim();
  const base = String(baseCurrency || "MYR").toUpperCase().trim();
  if (from === base) return { rate: 1, source: "exact" };

  // Check cache
  try {
    const cache = JSON.parse(localStorage.getItem(FX_CACHE_KEY) || "{}");
    const entry = cache[`${from}_${base}`];
    if (entry && Date.now() - entry.ts < CACHE_TTL_MS && entry.rate > 0) {
      return { rate: entry.rate, source: "cached" };
    }
  } catch {
    // ignore cache error
  }

  // Fetch live rate from open.er-api.com (no key required, CORS enabled)
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`);
    if (res.ok) {
      const data = await res.json();
      const liveRate = data?.rates?.[base];
      if (typeof liveRate === "number" && liveRate > 0) {
        try {
          const cache = JSON.parse(localStorage.getItem(FX_CACHE_KEY) || "{}");
          cache[`${from}_${base}`] = { rate: liveRate, ts: Date.now() };
          localStorage.setItem(FX_CACHE_KEY, JSON.stringify(cache));
        } catch {
          // ignore storage quota
        }
        return { rate: Number(liveRate.toPrecision(5)), source: "live" };
      }
    }
  } catch {
    // network offline -> use fallback
  }

  if (base === "MYR" && FALLBACK_TO_MYR[from]) {
    return { rate: FALLBACK_TO_MYR[from], source: "fallback" };
  }
  return { rate: 1, source: "manual" };
}

export function appendForeignCurrencyRemark(remarks, { currency, originalAmount, rate, baseCurrency = "MYR" }) {
  const cleanRemarks = String(remarks || "")
    .replace(/\s*\[Original:[^\]]+\]/gi, "")
    .trim();

  if (!currency || currency.toUpperCase() === baseCurrency.toUpperCase()) {
    return cleanRemarks;
  }

  const amtNum = Number(originalAmount);
  if (!Number.isFinite(amtNum) || amtNum <= 0) return cleanRemarks;

  const formattedAmt = amtNum % 1 === 0 ? amtNum.toString() : amtNum.toFixed(2);
  const tag = `[Original: ${currency.toUpperCase()} ${formattedAmt} @ ${rate}]`;
  return cleanRemarks ? `${cleanRemarks} ${tag}` : tag;
}
