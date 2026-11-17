// Receipt image compression (Xiaomi 14 Ultra 50MP -> fast ~250KB JPEG) & PDF reader

const MAX_DIMENSION = 1800;
const JPEG_QUALITY = 0.84;
const MAX_PDF_BYTES = 18 * 1024 * 1024; // 18 MB inline limit safety margin

export async function processReceiptFile(
  file,
  { maxDimension = MAX_DIMENSION, quality = JPEG_QUALITY } = {}
) {
  if (!file) throw new Error("No file selected.");

  if (file.type === "application/pdf" || file.name?.toLowerCase().endsWith(".pdf")) {
    if (file.size > MAX_PDF_BYTES) {
      throw new Error("PDF exceeds 18 MB limit. Please upload a smaller receipt PDF.");
    }
    const base64 = await blobToBase64(file);
    return {
      base64,
      mimeType: "application/pdf",
      isPdf: true,
      extension: "pdf",
      originalName: file.name || "receipt.pdf",
      sizeBytes: file.size,
      previewDataUrl: null,
    };
  }

  const looksLikeImage =
    file.type.startsWith("image/") ||
    /\.(heic|heif|jpg|jpeg|png|webp)$/i.test(file.name || "");
  if (!looksLikeImage) {
    throw new Error("Unsupported file format. Please snap a photo or select an image / PDF.");
  }

  const bitmap = await loadDrawableImage(file);
  const { width, height } = fitDimensions(bitmap.width, bitmap.height, maxDimension);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  // Fill white background in case of transparent PNG screenshot
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);

  if (typeof bitmap.close === "function") {
    bitmap.close();
  }

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Failed to encode receipt image."))),
      "image/jpeg",
      quality
    );
  });

  const base64 = await blobToBase64(blob);
  return {
    base64,
    mimeType: "image/jpeg",
    isPdf: false,
    extension: "jpg",
    originalName: file.name || "receipt.jpg",
    sizeBytes: blob.size,
    previewDataUrl: `data:image/jpeg;base64,${base64}`,
  };
}

function fitDimensions(w, h, maxDim) {
  if (w <= maxDim && h <= maxDim) return { width: w, height: h };
  const scale = maxDim / Math.max(w, h);
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

async function loadDrawableImage(file) {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall back to HTMLImageElement
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode image file."));
    };
    img.src = url;
  });
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = String(reader.result || "");
      const idx = res.indexOf(",");
      resolve(idx >= 0 ? res.slice(idx + 1) : res);
    };
    reader.onerror = () => reject(new Error("Failed to read file."));
    reader.readAsDataURL(blob);
  });
}

export function base64ToBlob(base64, mimeType = "image/jpeg") {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

export function buildReceiptFilename({ date, description, amountMyr, extension = "jpg" }) {
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : "receipt";
  const slug = String(description || "Spend")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "Spend";
  const amt = Number.isFinite(Number(amountMyr))
    ? `RM${Number(amountMyr).toFixed(2)}`
    : "RM0.00";
  return `${safeDate}_${slug}_${amt}.${extension}`;
}
