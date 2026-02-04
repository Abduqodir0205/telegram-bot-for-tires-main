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

  const prompt = `Ushbu rasmda shina (tires) yoki tovar jadvali bor. Jadvaldan barcha qatorlarni ajratib, quyidagi qoidalarga muvofiq faqat bitta toza JSON massiv qaytaring.

Qoidalar:
1. Har bir qator uchun ob'ekt: brand, size, quantity, price, total, selling_price.
2. brand – brend/mahsulot nomi (matn).
3. size – razmer/o'lcham, doim shu formatda: 165/70/13 (3 raqam slash bilan; masalan 175 70 R13 -> 175/70/13).
4. quantity – soni (butun musbat son).
5. price – tan narxi (1 dona, raqam).
6. total – jami tan narxi (raqam).
7. selling_price – sotish narxi: price + 100000 (har bir qator uchun hisoblab qo'ying).

Rasmdagi jadval ustunlari boshqa tillarda bo'lishi mumkin (Masalan: Товар номи, Razmer, Soni, Narx, Jami va hokazo). Ularni yuqoridagi maydonlarga moslashtiring.

Javobingiz faqat JSON massiv bo'lsin, boshqa matn yoki markdown yo'q. Masalan:
[{"brand":"Largo","size":"165/70/13","quantity":4,"price":320000,"total":1280000,"selling_price":420000}, ...]`;

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

  // Normalize size (165/70/13) va selling_price = price + 100000
  const out = rows.map((r) => {
    const price = Number(r.price) || 0;
    const selling_price = (price || 0) + 100000;
    let size = (r.size != null ? String(r.size) : "").trim();
    size = size.replace(/\s*[Rr]\s*/g, "/").replace(/\s+/g, "/").replace(/\/+/g, "/");
    if (/^\d{3}\/\d{2}\/\d{2}$/.test(size)) {
      // already 165/70/13
    } else {
      const m = size.match(/(\d{3})[\/\s]*(\d{2})[\/\s]*(\d{2})/);
      if (m) size = `${m[1]}/${m[2]}/${m[3]}`;
    }
    return {
      brand: r.brand != null ? String(r.brand) : "",
      size,
      quantity: Math.max(0, Math.round(Number(r.quantity) || 0)),
      price,
      total: Number(r.total) || 0,
      selling_price,
    };
  });

  return out;
}

module.exports = { extractTableFromImage };
