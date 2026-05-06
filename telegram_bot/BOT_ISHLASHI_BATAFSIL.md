# Telegram bot — qanday ishlashi va qaysi jadvalga nima qiladi (batafsil)

Bu hujjat botning **barcha funksiyalari**, **foydalanuvchi oqimlari** va **har bir harakatda qaysi bazadagi jadvalga yozish/o‘qish** ekanini batafsil tavsiflaydi.

---

## 1. Botning umumiy tuzilishi

- **Platforma:** Grammy (Telegram Bot API).
- **Baza:** PostgreSQL, Prisma orqali.
- **Rollar:** **Boss** (barcha do‘konlar), **Admin** (bir yoki bir nechta do‘kon), **User** (mijoz — faqat ko‘rish, do‘kon tanlash).
- **Session:** Har bir foydalanuvchi uchun `ctx.session` — joriy qadam (`step`), kiritilgan ma’lumot (`data`), tanlangan do‘kon (`shopId` / `userShopId`).

---

## 2. Asosiy menyu va kirish

| Kim | Start / menyu |
|-----|----------------|
| **Boss** | Bosh menyu: Do‘kon tanlash, Kirim, Chiqim, Xisobot, Royxat, Rabochiy, Olinish kerak, Sozlamalar, Do‘konlar boshqaruvi. |
| **Admin** | Xuddi shu admin menyu, lekin faqat o‘z do‘koni (yoki boss unga tayinlagan do‘konlar). |
| **User** | Do‘kon tanlang → keyin: Yangi Balonlar, Rabochiy Balonlar, Mashinam uchun, Do‘konlar, Yaqin do‘konlar, Qidiruv. |

**Jadval(lar):** `shops`, `shop_admins`, `admins`, `users` — do‘kon va admin aniqlash; `shop_settings` — sozlamalar o‘qish.

---

## 3. 📦 Kirim (tovar qabul qilish)

### 3.1 Qanday ishlaydi

- Admin **📦 Kirim** ni bosadi.
- Tanlash: **➕ Yangi kirim** | **📷 Rasm orqali kirim** | **📋 Royxat**.

**Yangi kirim:**

1. Razmer tanlash (ro‘yxatdan yoki "Yangi razmer").
2. Brend tanlash (ro‘yxatdan yoki "Yangi brend").
3. Sonini kiritish (nechta keldi).
4. Kelgan narx (so‘m yoki dollar).
5. Sotish narxi (so‘m yoki dollar) — yaxlitlanadi, keyin saqlanadi.

**Rasm orqali kirim:**

1. Admin **📷 Rasm orqali kirim** ni bosadi, keyin chek/jadval rasmini yuboradi.
2. Bot rasmni **Gemini** yoki **Tesseract** OCR bilan tahlil qiladi (jadval: razmer, brend, soni, narx).
3. Chiqqan qatorlar **bir batch** da kirim sifatida saqlanadi.

**Kirim ro‘yxati:**

- Sahifalangan ro‘yxat (20 tadan): ID, razmer, brend, soni, kelgan/sotish narx, sana.

### 3.2 Qaysi jadvalga yozadi / o‘qiydi

| Amal | Jadval | Izoh |
|------|--------|------|
| Kirim saqlash (yangi yoki batch) | **tires** | `legacyData.createKirim()` — upsert (shop_id, brand, size); quantity increment, price_buy, price_sell. |
| Razmer/brend ro‘yxati | **sizes**, **brands** | Kirim boshlanganda tanlash; yangi razmer/brend kiritilsa **sizes** va **brands** ga upsert. |
| Dollar kursi | **shop_settings** | Kelgan/sotish narx dollar bo‘lsa, kurs o‘qiladi (key). |
| Kirim ro‘yxati | **tires** | `getKirimPaginated`, `getKirimCount` — joriy do‘kon bo‘yicha. |
| Default sotish narxi | **shop_settings** | Birinchi kirimda ustama saqlanadi (default_sotish_narx_som). |

**Xulosa:** Kirim = **tires** (asosiy), **sizes**, **brands** (kerak bo‘lsa upsert), **shop_settings** (o‘qish/yozish).

---

## 4. 💰 Chiqim (sotuv)

### 4.1 Qanday ishlaydi

- Admin **💰 Chiqim** ni bosadi.
- **➕ Yangi sotuv:** skladda bor razmer → brend → nechta sotildi → umumiy summa (so‘m) → ixtiyoriy: rabochiy balon qo‘shish (soni, narx, razmer, brend, holat).
- Sotuv saqlanganda: **sales** ga yozuv; agar rabochiy balon kiritilgan bo‘lsa **rabochiy_balon** ga yangi qatorlar qo‘shiladi; **tires** da qoldiq (quantity) kamaymaydi (legacy mantiqda sklad alohida sync qilinadi).
- **📋 Royxat:** sotuvlar sahifalangan ro‘yxati (ID, razmer, brend, sotildi, umumiy, foyda, naqd/zaxira foyda, sana).

### 4.2 Qaysi jadvalga yozadi / o‘qiydi

| Amal | Jadval | Izoh |
|------|--------|------|
| Sotuv saqlash | **sales** | `saleService.saveChiqim()` — razmer, balon_turi, sotildi, umumiy, foyda, naqdFoyda, zaxiraFoyda, rabochiyOlindi, rabochiyNarxi, shopId. |
| Rabochiy balon qo‘shish (sotuvda) | **rabochiy_balon** | Har bir rabochiy balon uchun bitta yozuv (razmer, balon_turi, soni=1, narx, holat, shopId). |
| Skladda bor razmerlar/brendlar | **tires** | `getSizesWithStock`, `getBrandsWithStock` — omborda quantity > 0 bo‘lganlar. |
| Qoldiq (soni) | **tires**, **sales** | `getStock()` — kirimdan chiqim ayiriladi. |
| Kelgan narx (foyda hisobi) | **tires** | `getKelganNarx()`. |
| Sotuvlar ro‘yxati | **sales** | `getChiqimPaginated`, `getChiqimCount`. |
| Olinish kerak sync | **olinish_kerak** | Sotuvdan keyin `syncOlinishKerakFromStock()` — sklad bo‘yicha "olinishi kerak" ro‘yxati yangilanadi. |

**Xulosa:** Chiqim = **sales** (asosiy), **rabochiy_balon** (sotuvda rabochiy qo‘shilsa), **tires** (o‘qish + sync), **olinish_kerak** (o‘qish/yozish — sync).

---

## 5. 📊 Xisobot

### 5.1 Qanday ishlaydi

- **📊 Umumiy:** Barcha razmer+brend bo‘yicha: kirdi, sotildi, qoldi, tan narx, foyda; jami foyda.
- **📅 Bugungi:** Bugungi kun uchun: naqd tushum, naqd foyda, rabochiy qo‘shilgan soni/summa, eski balondan foyda, jami foyda.
- **📦 Qoldiq:** Sklad qoldig‘i (tires) — razmer, brend, soni, tannarx, jami qiymat.
- **🔄 Ombor (Eski):** Rabochiy balonlar soni va jami summa.
- **📥 Excel yuklab olish:** Kirim / Chiqim / Umumiy — kunlik, haftalik, oylik yoki barcha vaqt.

### 5.2 Qaysi jadvalga o‘qiydi

| Hisobot | Jadvallar |
|---------|-----------|
| Umumiy | **tires** (groupBy), **sales** (aggregate — sotildi, foyda). |
| Bugungi | **sales** (sana bo‘yicha), **rabochiy_sotuv** (sana bo‘yicha). |
| Qoldiq | **tires** (quantity, priceBuy, priceSell). |
| Ombor (Eski) | **rabochiy_balon** (soni, narx). |
| Excel Kirim | **tires** (sana oralig‘i). |
| Excel Chiqim | **sales** (sana oralig‘i). |
| Excel Umumiy | **tires**, **sales**, **warehouse_logs**, **shops**. |

**Yozish:** Xisobotlar faqat o‘qiydi; yozish yo‘q.

---

## 6. 📋 Royxat (razmerlar va brendlar)

### 6.1 Qanday ishlaydi

- **📏 Razmerlar** / **🏷 Brendlar:** Ro‘yxatni ko‘rsatadi (ID, nom).
- **➕ Razmer** / **➕ Brend:** Yangi razmer yoki brend nomini matn sifatida kiritish → bazaga qo‘shiladi.

### 6.2 Qaysi jadvalga yozadi / o‘qiydi

| Amal | Jadval |
|------|--------|
| Ro‘yxatni ko‘rsatish | **sizes**, **brands** (o‘qish). |
| Yangi razmer qo‘shish | **sizes** (yozish — create/upsert). |
| Yangi brend qo‘shish | **brands** (yozish — create/upsert). |

---

## 7. 🔄 Rabochiy (rabochiy balonlar)

### 7.1 Qanday ishlaydi

- **➕ Qo‘shish:** Razmer → Brend → Sonini kiritish → (ixtiyoriy holat) → **rabochiy_balon** ga yozuv(lar) qo‘shiladi.
- **💰 Rabochiy sotuv:** Ro‘yxatdan balonlarni tanlash (savat), jami sotilgan summani kiritish → **rabochiy_sotuv** ga yozuvlar, tanlangan **rabochiy_balon** yozuvlari o‘chiriladi.
- **📋 Ro‘yxat:** Barcha rabochiy balonlar (ID, razmer, brend, soni, narx, holat).

### 7.2 Qaysi jadvalga yozadi / o‘qiydi

| Amal | Jadval |
|------|--------|
| Rabochiy qo‘shish | **rabochiy_balon** (create). |
| Rabochiy ro‘yxat | **rabochiy_balon** (o‘qish). |
| Rabochiy sotuv tasdiq | **rabochiy_sotuv** (create), **rabochiy_balon** (delete — tanlangan ID lar). |

---

## 8. 🛒 Olinish kerak

### 8.1 Qanday ishlaydi

- **➕ Qo‘shish:** Razmer → Brend → Sonini kiritish → **olinish_kerak** ga yangi yozuv.
- **📋 Ro‘yxat:** Barcha "olinishi kerak" (ID, razmer, brend, soni).
- **📊 Talab (sotuvlar):** Sotuvlar bo‘yicha talab (qaysi razmer+brenddan nechta sotilgan).
- Tahrirlash: ID kiritish → yangi soni → **olinish_kerak** da update (soni).
- Sotuv saqlanganda avtomatik **sync** — sklad qoldig‘iga qarab "olinishi kerak" yangilanadi (`syncOlinishKerakFromStock`).

### 8.2 Qaysi jadvalga yozadi / o‘qiydi

| Amal | Jadval |
|------|--------|
| Qo‘shish | **olinish_kerak** (create). |
| Ro‘yxat | **olinish_kerak** (o‘qish). |
| Tahrirlash (soni) | **olinish_kerak** (update). |
| Talab / sync | **tires**, **sales** (o‘qish); **olinish_kerak** (yozish — sync). |

---

## 9. ⚙️ Sozlamalar

### 9.1 Qanday ishlaydi

- **💵 Dollar kursi:** Son kiritiladi → **shop_settings** (dollar_kurs) + **dollar_history** ga yozuv.
- **🏪 Do‘kon sozlamalari:** Nomi, telefon, manzil, ish vaqti, lokatsiya (location yuboriladi) → **shop_settings**.
- **💰 Ustama (so‘m):** default_sotish_narx_som — **shop_settings**.
- **🔑 Ma’lumot o‘chirish/tahrirlash:** Jadval tanlash (kirim, chiqim, rabochiy_balon, rabochiy_sotuv, olinish_kerak, sizes, brands) → ro‘yxat → ID yoki ID oralig‘i → **O‘chirish** yoki **Tahrirlash** (maydon + qiymat). Tahrir fizik jadval ustuniga map qilinadi (masalan kirim → tires, chiqim → sales).
- **📊 Hisobotlarni boshqarish:** Kunlik hisobot vaqti, haftalik hisobot kuni → **shop_settings** (report_daily_time, report_weekly_day).
- **👤 Admin qo‘shish** / **👥 Adminlar ro‘yxati:** **admins**, **shop_admins**, **users** (admin qo‘shishda).

### 9.2 Qaysi jadvalga yozadi / o‘qiydi

| Sozlama | Jadval |
|---------|--------|
| Dollar kursi | **shop_settings**, **dollar_history**. |
| Do‘kon nomi, telefon, manzil, ish vaqti, lokatsiya | **shop_settings**, **shops** (latitude, longitude). |
| Ustama | **shop_settings**. |
| Hisobot vaqti/kuni | **shop_settings**. |
| O‘chirish/tahrirlash | **tires**, **sales**, **rabochiy_balon**, **rabochiy_sotuv**, **olinish_kerak**, **sizes**, **brands** (jadval nomi logikada, fizik jadval nomi map orqali). |
| Admin qo‘shish / ro‘yxat | **admins**, **shop_admins**, **users**, **shops**. |

---

## 10. 🏢 Do‘konlar boshqaruvi (Boss)

- **Yangi do‘kon qo‘shish:** Nomi kiritiladi → **shops** (create).
- **Admin biriktirish:** Do‘kon tanlash → Telegram ID kiritish → **shop_admins** (upsert).

**Jadval:** **shops**, **shop_admins**.

---

## 11. User (mijoz) — faqat o‘qish

- **Do‘kon tanlash:** Ro‘yxatdan yoki "Yaqin do‘konlar" (joylashuv yuboriladi, masofa hisoblanadi) → session da `userShopId` saqlanadi. **shops**, **shop_settings** (lokatsiya, manzil, telefon, ish vaqti).
- **🛞 Yangi Balonlar:** Tanlangan do‘kon bo‘yicha **tires** dan razmerlar (qoldiq > 0), keyin brendlar va sotish narxi (shop_settings dagi dollar_kurs bilan).
- **🔄 Rabochiy Balonlar:** **rabochiy_balon** ro‘yxati (razmer, brend, narx, holat).
- **🚗 Mashinam uchun:** Statik ma’lumot (CAR_TIRE_INFO), baza ishlatilmaydi.
- **📍 Do‘konlar / Yaqin do‘konlar:** **shops**, **shop_settings** (o‘qish).
- **🔍 Qidiruv:** Matn bo‘yicha **tires** va **rabochiy_balon** da qidiruv (razmer yoki brend).

**Yozish:** User hech qanday jadvalga yozmaydi; faqat o‘qiydi.

---

## 12. Avtomatik hisobotlar (cron)

- **Vaqt:** Har daqiqa tekshiriladi (Toshkent vaqti).
- **Kunlik:** Har do‘kon uchun `report_daily_time` (masalan 21:00) da — bugungi kun hisoboti (chiqim, rabochiy sotuv, foyda) yuboriladi.
- **Haftalik:** `report_weekly_day` (masalan 5 = Juma) da haftalik hisobot.
- **Kimga:** Do‘kon adminlari (shop_admins) + Boss.

**O‘qiladigan jadvallar:** **shops**, **shop_settings**, **shop_admins**, **sales**, **rabochiy_sotuv**, **tires** (buildReportText orqali).

---

## 13. Boshqa admin handlerlar (handlers/admin)

- **Yangi balonlar (tires):** Ro‘yxat, qo‘shish, tahrirlash — **tires**, **warehouse_logs** (kirim/chiqim log).
- **Rabochiy ro‘yxati (usedTires):** **used_tires** — ro‘yxat, qabul qilish, narx belgilash; **warehouse_logs**.
- **Sotish (sales):** **sales** (yangi mantiq: tire_id/used_tire_id, quantity, total_price), **tires** / **used_tires** (quantity kamaytirish), **warehouse_logs**.
- **Sklad (warehouse):** **tires**, **used_tires**, **rabochiy_balon** — qoldiq, qiymat; tugagan balonlar (**tires** bo‘yicha).
- **Hisobotlar (reports):** Kunlik/oylik/umumiy — **sales**, **tires**, **warehouse_logs** va boshqalar.
- **Excel:** **tires**, **sales**, **warehouse_logs**, **shops**, **used_tires** (turiga qarab).
- **Sozlamalar (settings):** **shops**, **shop_settings**, **admins**, **users**, **shop_admins**.

---

## 14. Jadval bo‘yicha yagona xulosa

| Jadval | O‘qish | Yozish | Qayerda ishlatiladi |
|--------|--------|--------|----------------------|
| **tires** | ✅ | ✅ | Kirim, Chiqim (sklad, foyda), Xisobot, Excel, User (yangi balonlar), Tahrir/o‘chirish. |
| **sales** | ✅ | ✅ | Chiqim (sotuv), Xisobot, Excel, Tahrir/o‘chirish. |
| **rabochiy_balon** | ✅ | ✅ | Rabochiy bo‘limi, Chiqim (sotuvda rabochiy qo‘shish), Rabochiy sotuv (o‘chirish), Xisobot, Tahrir/o‘chirish. |
| **rabochiy_sotuv** | ✅ | ✅ | Rabochiy sotuv, Xisobot (bugungi/haftalik), Tahrir/o‘chirish. |
| **olinish_kerak** | ✅ | ✅ | Olinish kerak bo‘limi, Chiqim dan keyin sync, Tahrir/o‘chirish. |
| **sizes** | ✅ | ✅ | Royxat, Kirim (upsert), Tahrir/o‘chirish. |
| **brands** | ✅ | ✅ | Royxat, Kirim (upsert), Tahrir/o‘chirish. |
| **shops** | ✅ | ✅ | Do‘kon tanlash, boshqaruv, sozlamalar, Excel. |
| **shop_settings** | ✅ | ✅ | Barcha sozlamalar (dollar_kurs, manzil, hisobot vaqti va h.k.). |
| **shop_admins** | ✅ | ✅ | Admin do‘konlari, avtomatik hisobot yuborish. |
| **warehouse_logs** | ✅ | ✅ | TireService / SalesService (yangi balon, ishchi shina, sotuv). |
| **used_tires** | ✅ | ✅ | Admin: ishchi shinalar, sotuv, sklad. |
| **admins** | ✅ | ✅ | Kirish, sozlamalar (admin qo‘shish). |
| **users** | ✅ | ✅ | Kirish, telefon orqali ro‘yxatdan o‘tish. |
| **dollar_history** | — | ✅ | Dollar kursi o‘zgartirilganda. |

---

## 15. Qisqacha

- **Kirim** → **tires** (asosiy), **sizes**, **brands**, **shop_settings**.
- **Chiqim (sotuv)** → **sales**, **rabochiy_balon** (ixtiyoriy), **tires** (o‘qish + sync), **olinish_kerak** (sync).
- **Rabochiy** → **rabochiy_balon**, **rabochiy_sotuv**.
- **Olinish kerak** → **olinish_kerak** (+ **tires**/sales sync).
- **Royxat** → **sizes**, **brands**.
- **Xisobot / Excel** → asosan **tires**, **sales**, **rabochiy_balon**, **rabochiy_sotuv**, **warehouse_logs**, **shops** (o‘qish).
- **Sozlamalar / Do‘kon boshqaruvi** → **shops**, **shop_settings**, **shop_admins**, **admins**, **users**, **dollar_history**.
- **User** → faqat o‘qish: **shops**, **shop_settings**, **tires**, **rabochiy_balon**.

Bot barcha ma’lumotni **shu jadvalar** orqali saqlaydi va o‘qiydi; boshqa jadval yoki boshqa baza ishlatilmaydi.
