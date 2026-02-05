"use strict";

const { createWorker } = require("tesseract.js");

/**
 * Rasmdan matnni OCR qiladi, keyin jadval qatorlarini parse qiladi.
 * Jadval: Tовар номи (brend + razmer) | Улч бир | Сони | Нархи | Қиймати
 * Qaytarish: Gemini bilan bir xil format (brand, size, quantity, price, total, selling_price)
 *
 * @param {Buffer} imageBuffer - Rasm buffer
 * @returns {Promise<Array<{brand:string, size:string, quantity:number, price:number, total:number, selling_price:number}>>}
 */
async function extractTableFromImageTesseract(imageBuffer) {
  let worker;
  try {
    worker = await createWorker("eng", 1, { logger: () => {} });
    // PSM 6 = yagona matn bloki (jadval qatorlari uchun yaxshiroq)
    const { data } = await worker.recognize(imageBuffer, {
      tessedit_pageseg_mode: 6,
    });
    const text = (data && data.text) || "";
    await worker.terminate();
    return parseTableText(text);
  } catch (err) {
    if (worker) try { await worker.terminate(); } catch (_) {}
    throw err;
  }
}

// Ma'lum brendlar – boshqa brendlar uchun (Cotecho/Imperati yuqorida alohida)
const KNOWN_BRANDS = ["VAGNER", "TR"];
// OCR natidasini baza uchun bitta nomga olib kelish (Cotecho -> Cotechoo, IMPERATI -> Imperati)
const BRAND_CANONICAL = {
  COTECHO: "Cotechoo", COTECHOO: "Cotechoo", Cotechoo: "Cotechoo", Cotecho: "Cotechoo",
  IMPERATI: "Imperati", Imperati: "Imperati",
  VAGNER: "Vagner", TR: "TR",
};

// Razmer haqiqiy shina formatida ekanini tekshirish (kenglik / balandlik / diametr)
function isValidTireSize(w, h, r) {
  const ww = parseInt(w, 10);
  const hh = parseInt(h, 10);
  const rr = parseInt(r, 10);
  return (
    ww >= 145 && ww <= 355 &&
    hh >= 45 && hh <= 95 &&
    rr >= 10 && rr <= 24
  );
}

/**
 * Butun qator matnidan barcha raqamlarni yig'ib, ichidan birinchi haqiqiy 7 xonali razmerni qaytaradi.
 * Masalan: "...1657013..." yoki "1757013" qatorda bo'lsa, 165/70/13 yoki 175/70/13 topiladi.
 */
function findSizeInLine(cleanLine) {
  const allDigits = cleanLine.replace(/\D/g, "");
  if (allDigits.length < 7) return null;
  for (let i = 0; i <= allDigits.length - 7; i++) {
    const seg = allDigits.slice(i, i + 7);
    const w = seg.slice(0, 3);
    const h = seg.slice(3, 5);
    const r = seg.slice(5, 7);
    if (isValidTireSize(w, h, r)) return `${w}/${h}/${r}`;
  }
  return null;
}

/**
 * Qatordan narx va jami. Oxirgi 2–4 ta raqamdan juftliklarni sinab, to'g'ri bo'lganini qaytaradi.
 * OCR "35,00" ni "3500" deb o'qisa, 100 ga bo'lib ham tekshiramiz.
 */
function findPriceAndTotal(tokens) {
  const candidates = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const n = parseDecimalToken(t);
    if (isFinite(n) && n > 0) candidates.push({ i, value: n, raw: t });
  }
  if (candidates.length < 2) return null;

  function check(price, total) {
    if (price <= 0 || total <= 0 || total < price) return null;
    const qty = Math.round(total / price);
    if (qty < 1 || qty > 999) return null;
    if (Math.abs(qty * price - total) > Math.max(1, total * 0.08)) return null;
    return { price, total };
  }

  function tryPair(a, b) {
    let out = check(a, b) || check(b, a);
    if (out) return out;
    if (a >= 100) out = check(a / 100, b) || check(b, a / 100);
    if (out) return out;
    if (b >= 100) out = check(a, b / 100) || check(b / 100, a);
    if (out) return out;
    if (a >= 100 && b >= 100)
      out = check(a / 100, b / 100) || check(b / 100, a / 100);
    return out;
  }

  const n = candidates.length;
  const vals = candidates.map((c) => c.value);
  for (let i = n - 1; i >= Math.max(0, n - 4); i--) {
    for (let j = i - 1; j >= Math.max(0, n - 5); j--) {
      const out = tryPair(vals[i], vals[j]);
      if (out) return out;
    }
  }
  return null;
}

/**
 * Brend ustunidagi to'liq matnni qaytaradi (masalan "Zitto Ravon", "Cotecho, Cho1").
 * Qatordagi barcha harfli tokenlarni (razmer va soni/narx/jami dan tashqari) birlashtiradi.
 */
function getFullBrandFromTokens(tokens, size) {
  const sizeParts = size ? size.split("/") : [];
  const rim = sizeParts[2] ? "R" + sizeParts[2] : "";
  const exclude = new Set([...sizeParts, rim]);
  const brandTokens = tokens.filter((t) => {
    if (!/[A-Za-z]/.test(t)) return false;
    if (/^\d+$/.test(t)) return false;
    if (/^\d{3}\/\d{2}/.test(t)) return false;
    if (/^R\d{2}$/i.test(t)) return false;
    if (exclude.has(t)) return false;
    return true;
  });
  const full = brandTokens.join(" ").replace(/\s+/g, " ").trim();
  return full || null;
}

/**
 * Brendni aniqlash: avval to'liq nom (getFullBrandFromTokens), keyin ma'lum brendlar bo'yicha to'g'rilash
 */
function extractBrand(lineTokens, size) {
  const full = getFullBrandFromTokens(lineTokens, size);
  if (full) return full;

  const lineStr = lineTokens.join(" ").toUpperCase();
  const lineRaw = lineTokens.join(" ");

  const hasCho1 = /\bcho\s*1\b|cho1|ch01|ch0\s*1\b/i.test(lineRaw) || /\bCHO\s*1\b/.test(lineStr);
  const hasCho2 = /\bcho\s*2\b|cho2|ch02|ch0\s*2\b/i.test(lineRaw) || /\bCHO\s*2\b/.test(lineStr);

  if (/COTECHO|COTECHOO/i.test(lineStr)) {
    const base = BRAND_CANONICAL.COTECHOO || "Cotechoo";
    if (hasCho2) return base + ", Cho2";
    if (hasCho1) return base + ", Cho1";
    return base;
  }
  if (/IMPERATI/i.test(lineStr)) return BRAND_CANONICAL.IMPERATI || "Imperati";
  if (/VAGNER/i.test(lineStr)) return BRAND_CANONICAL.VAGNER || "Vagner";
  if (/\bTR\b/i.test(lineStr)) return BRAND_CANONICAL.TR || "TR";

  for (const b of KNOWN_BRANDS) {
    if (lineStr.includes(b.toUpperCase())) {
      const key = b.split(",")[0].trim().toUpperCase();
      const canon = BRAND_CANONICAL[key] || b.split(",")[0].trim();
      if (hasCho2) return canon + ", Cho2";
      if (hasCho1) return canon + ", Cho1";
      return canon;
    }
  }

  const brandToken =
    lineTokens.find((t) => /[A-Za-z]{2,}/.test(t)) || lineTokens[0] || "";
  const brandMatches = (brandToken || "").match(/[A-Za-z]{2,}/g) || [];
  const raw = brandMatches.sort((a, b) => b.length - a.length)[0] || "";
  return BRAND_CANONICAL[raw.toUpperCase()] || raw;
}

/**
 * OCR matnidan jadval qatorlarini ajratadi.
 * 1–2 qatorlar va boshqalari uchun: brend to'g'ri, razmer haqiqiy formatda, narx/jami vergul bilan.
 */
function parseTableText(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    const cleanLine = line.replace(/\s+/g, " ").trim();
    if (!cleanLine) continue;
    if (/жами|jami|total|умумий|итого|таблица|товар/i.test(cleanLine)) continue;

    const tokens = cleanLine.split(" ").filter(Boolean);
    if (tokens.length < 3) continue;

    const priceTotal = findPriceAndTotal(tokens);
    if (!priceTotal) continue;
    const { price, total } = priceTotal;
    if (price <= 0 || total <= 0) continue;

    const qty = Math.round(total / price);
    if (qty < 1) continue;
    const expectedTotal = qty * price;
    if (Math.abs(expectedTotal - total) > Math.max(1, total * 0.05)) continue;

    // Avval razmerni topamiz, keyin brendni to'liq (razmerdan tashqari matn) qilib olamiz
    let size = findSizeInLine(cleanLine);
    if (!size) {
      const numericTokens = tokens.filter((t) => /[0-9]/.test(t));
      const sizeSourceTokens = numericTokens.slice(
        0,
        Math.max(0, numericTokens.length - 3)
      );
      let sizeDigits = sizeSourceTokens.map((t) => t.replace(/\D/g, "")).join("");
      if (!sizeDigits) {
        const brandToken =
          tokens.find((t) => /[A-Za-z]{2,}/.test(t)) || tokens[0] || "";
        sizeDigits = brandToken.replace(/\D/g, "");
      }
      if (!sizeDigits || sizeDigits.length < 5) continue;
      const w = sizeDigits.slice(0, 3);
      const h = sizeDigits.slice(3, 5);
      const r = sizeDigits.slice(5, 7);
      if (w.length !== 3 || h.length !== 2 || r.length !== 2) continue;
      if (!isValidTireSize(w, h, r)) continue;
      size = `${w}/${h}/${r}`;
    }

    const brand = extractBrand(tokens, size);
    if (!brand) continue;

    const selling_price = price + 100000;

    rows.push({
      brand: String(brand).trim(),
      size,
      quantity: qty,
      price,
      total,
      selling_price,
    });
  }

  return rows;
}

function parseDecimalToken(token) {
  if (!token) return NaN;
  // Faqat raqam, vergul va nuqtani qoldiramiz
  const str = String(token).replace(/[^\d,.\-]/g, "").replace(/\s+/g, "");
  if (!str) return NaN;
  // Bir dona vergul yoki nuqta bo‘lishi mumkin – uni o‘nlik ajratuvchi deb olamiz
  const normalized = str.replace(",", ".");
  const n = parseFloat(normalized);
  return isNaN(n) ? NaN : n;
}

module.exports = { extractTableFromImageTesseract, parseTableText };
