"use strict";

const { GoogleGenAI } = require("@google/genai");

/**
 * Rasmdagi jadvaldan ma'lumotlarni Google Gemini (1.5 Flash) orqali JSON formatida ajratib oladi.
 *
 * Qoidalar:
 * - Model: gemini-2.0-flash
 * - Jadvaldan: brand, size, quantity, price (tan narxi), total (jami tan narxi)
 * - selling_price = price + 100000
 * - size doim 165/70/13 ko'rinishida (slash bilan)
 * - Natija faqat toza JSON (massiv).
 *
 * @param {Buffer|string} imageInput - Rasm buffer yoki base64 string
 * @param {string} [apiKey] - GEMINI_API_KEY (yoki process.env.GEMINI_API_KEY)
 * @returns {Promise<Array<{brand:string, size:string, quantity:number, price:number, total:number, selling_price:number}>>}
 */
async function extractTableFromImage(imageInput, apiKey) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY talab qilinadi (env yoki ikkinchi argument).");
  }

  let base64Data;
  let mimeType = "image/jpeg";

  if (Buffer.isBuffer(imageInput)) {
    base64Data = imageInput.toString("base64");
    // PNG magic number
    if (imageInput[0] === 0x89 && imageInput[1] === 0x50) mimeType = "image/png";
  } else if (typeof imageInput === "string") {
    base64Data = imageInput.replace(/^data:image\/\w+;base64,/, "");
    const match = imageInput.match(/^data:(image\/\w+);base64,/);
    if (match) mimeType = match[1];
  } else {
    throw new Error("imageInput Buffer yoki base64 string bo'lishi kerak.");
  }

  const ai = new GoogleGenAI({ apiKey: key });

  const prompt = `Rasmdagi shina jadvalini tahlil qiling. Jadvalda 4 ustun bor: Razmer | Brend | Soni | Kelgan narx ($). Har bir QATOR uchun bitta ob'ekt, faqat bitta toza JSON massiv qaytaring.

USTUNLAR (100% aniq ajrating):
1. Razmer – shina o'lchami. Rasmdagi ko'rinishini AYNAN saqlang. Qabul qilinadigan formatlar:
   - 165/70 R13, 185/65 R14, 195/60 R15 (slash va R bilan)
   - 165R13C, 195/75/16C (qisqa format, C = commercial) – bunday yozilgan bo'lsa o'sha ko'rinishda qoldiring
   - Boshqa variantlar: 195/75/16C, 235/50 R18 – rasmdagi matnni o'zgartirmang.
2. Brend – brend yoki model nomi (masalan: Cotechoo Chol, Largo Arduzza, Lassa, Vagner VR77). Vergul yoki bo'shliq bilan yozilgan bo'lsa ham to'liq yozing.
3. Soni – faqat BUTUN SON (1, 2, 4, 6, 8, 10, 12 ...). Hech qachon o'nlik yoki narxni bu ustunga yozmang.
4. Kelgan narx ($) – 1 dona narxi DOLLARda (30.00, 32.00, 35.00, 43.00, 53.00, 81.00). Soni va narxni ALMASHTIRMANG.

Chiqish format:
- Har bir ob'ekt: brand, size, quantity, price, total, selling_price.
- size: rasmdagi Razmer ustunidagi qiymat (165/70 R13 yoki 165R13C yoki 195/75/16C va hokazo).
- quantity: Soni ustuni (butun).
- price: Kelgan narx ($) ustuni (son).
- total: quantity * price.
- selling_price: price + 100000.

Javob faqat JSON massiv, boshqa so'z yo'q. Misol:
[{"brand":"Cotechoo, Chol","size":"165/70 R13","quantity":4,"price":30,"total":120,"selling_price":100030},{"brand":"Lassa","size":"165R13C","quantity":2,"price":35,"total":70,"selling_price":100035}]`;

  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: [
      { inlineData: { mimeType, data: base64Data } },
      { text: prompt },
    ],
  });

  const raw = (response && typeof response.text !== "undefined" ? response.text : "") ||
    (response?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "");
  if (!raw || typeof raw !== "string") {
    throw new Error("Gemini javob qaytarmadi.");
  }

  const trimmed = raw.replace(/^[\s\S]*?\[/, "[").replace(/\][\s\S]*$/, "]");
  let rows;
  try {
    rows = JSON.parse(trimmed);
  } catch (e) {
    throw new Error("Gemini javobini JSON parse qilib bo'lmadi: " + e.message);
  }

  if (!Array.isArray(rows)) {
    throw new Error("Natija massiv emas.");
  }

  // Soni va narx almashib kelgan bo'lsa tuzatish: soni odatda 1–100, narx 15–300 (yoki 100k+ so'm)
  function fixQuantityPriceSwap(qty, pr) {
    const a = Math.max(0, Math.round(Number(qty) || 0));
    const b = Number(pr) || 0;
    if (a <= 0 || b <= 0) return { quantity: a, price: b };
    // Soni kichik butun (1–150), narx dollar (15–500) yoki so'm (100000+)
    const looksLikeQuantity = (n) => Number.isInteger(n) && n >= 1 && n <= 150;
    const looksLikePrice = (n) => (n >= 15 && n <= 500) || n >= 100000;
    if (looksLikeQuantity(a) && looksLikePrice(b)) return { quantity: a, price: b };
    if (looksLikeQuantity(b) && looksLikePrice(a)) return { quantity: b, price: a };
    return { quantity: a, price: b };
  }

  // Normalize size: 165/70/13 -> 165/70 R13; 165R13C, 195/75/16C saqlanadi
  function normalizeSize(s) {
    let size = (s != null ? String(s) : "").trim().replace(/\s+/g, " ");
    if (!size) return "";
    // XXX/YY/ZZ yoki XXX/YY RZZ -> 165/70 R13 (C bilan tugasa saqlanadi)
    const m = size.match(/(\d{3})[\/\s]*(\d{2})[\/\s]*[Rr]?\s*(\d{2})/);
    if (m) {
      const suffix = size.match(/C\s*$/i) ? "C" : "";
      return `${m[1]}/${m[2]} R${m[3]}${suffix}`.trim();
    }
    // 165R13C (3 raqam + R + 2 raqam + C)
    const short = size.match(/(\d{3})\s*[Rr]\s*(\d{2})\s*C?\s*$/i);
    if (short) return `${short[1]}R${short[2]}${/C/i.test(size) ? "C" : ""}`.trim();
    return size;
  }

  const out = rows.map((r) => {
    let quantity = Math.max(0, Math.round(Number(r.quantity) || 0));
    let price = Number(r.price) || 0;
    const fixed = fixQuantityPriceSwap(quantity, price);
    quantity = fixed.quantity;
    price = fixed.price;
    const selling_price = (price || 0) + 100000;
    const size = normalizeSize(r.size);
    const total = quantity * price;
    return {
      brand: r.brand != null ? String(r.brand) : "",
      size,
      quantity,
      price,
      total,
      selling_price,
    };
  });

  return out;
}

module.exports = { extractTableFromImage };
