# Telegram bot — qaysi jadvalga nima saqlaydi (baza struktura)

Backend va mobile ilova bilan bir xil bazadan foydalanish uchun bot **qaysi fizik jadvallar**ga yozishini va o‘qishini bitta joyda ko‘rishingiz mumkin.

---

## Fizik jadval nomlari (PostgreSQL)

Prisma model nomi va bazadagi jadval nomi quyidagi jadvalda:

| Prisma model   | Bazadagi jadval (@@map) | Qisqacha vazifa           |
|----------------|-------------------------|---------------------------|
| **Kirim**      | **`tires`**             | Yangi shinalar kirimi (razmer, brend, soni, narx) |
| **Chiqim**     | **`sales`**             | Sotuvlar (chiqim)         |
| **UsedTire**   | **`used_tires`**        | Ishchi (second) shinalar  |
| **RabochiyBalon** | **`rabochiy_balon`**  | Rabochiy balonlar ombori  |
| **RabochiySotuv** | **`rabochiy_sotuv`**  | Rabochiy balonlar sotuvi  |
| **OlinishKerak**  | **`olinish_kerak`**   | Olinishi kerak bo‘lganlar |
| **Size**       | **`sizes`**             | Razmerlar ro‘yxati        |
| **Brand**      | **`brands`**            | Brendlar ro‘yxati         |
| **Shop**       | **`shops`**             | Do‘konlar                 |
| **ShopSetting**| **`shop_settings`**     | Do‘kon sozlamalari        |
| **ShopAdmin**  | **`shop_admins`**       | Do‘kon adminlari (telegram_id, shop_id) |
| **WarehouseLog** | **`warehouse_logs`**  | Ombor harakati (kirim/chiqim log) |
| **Admin**      | **`admins`**            | Adminlar (telegram_id, shop_id) |
| **User**       | **`users`**             | Foydalanuvchilar          |
| **DollarHistory** | **`dollar_history`** | Dollar kursi tarixi   |

---

## Telegram bot qayerda qaysi jadvalga yozadi

### 1. **Kirim (yangi shinalar)** → jadval **`tires`**

- **Qayerda:** `legacyDataService.createKirim()`, `index.js` (kirim saqlash), `inventoryService.addKirimBatch()` (OCR batch).
- **Qanday:** `prisma.kirim.upsert(...)` — `shop_id`, `brand` (balon_turi), `size` (razmer), `quantity` (soni), `price_buy` (kelgan_narx), `price_sell` (sotish_narx). Unique: `(shop_id, brand, size)`.
- **Qo‘shimcha:** Kirim yozilganda `sizes` va `brands` jadvallariga ham `upsert` qilinadi (razmer va brend nomi).

### 2. **Chiqim (sotuvlar)** → jadval **`sales`**

- **Ikki xil yo‘l bor:**
  - **Legacy (eski) mantiq:** `saleService.saveChiqim()` — **index.js** orqali (balon sotuv + ixtiyoriy rabochiy balon). Bu kod `razmer`, `balonTuri`, `sotildi`, `umumiyQiymat`, `foyda`, `naqdFoyda`, `zaxiraFoyda`, `rabochiyOlindi`, `rabochiyNarxi` kabi maydonlar bilan `tx.chiqim.create()` qiladi.
  - **Yangi mantiq:** `salesService.createSale()` — `item_type`, `tire_id` yoki `used_tire_id`, `quantity`, `total_price`, `admin_id`, `shop_id` bilan `tx.chiqim.create()`.
- **⚠️ E’tibor:** Hozirgi `prisma/schema.prisma` dagi **Chiqim** modelida faqat yangi ustunlar (tire_id, used_tire_id, quantity, total_price, admin_id, shop_id) bor. Lekin `saleService.saveChiqim()` eski ustunlar (razmer, balonTuri, sotildi, …) bilan yozadi. Agar bazing haqiqiy bazadagi `sales` jadvalida bu eski ustunlar bo‘lmasa, legacy sotuv (index.js orqali) ishlamaydi yoki xato beradi. Backend va mobile **sales** dan ma’lumot olayotgan bo‘lsa, ular **shu jadvaldan** olishi kerak; agar backend boshqa jadvalga yozayotgan bo‘lsa, uni `sales` ga qaytarish kerak.

### 3. **Rabochiy balonlar** → **`rabochiy_balon`**

- **Qayerda:** `saleService.saveChiqim()` (sotuvda rabochiy balon qo‘shilganda), `saleService.saveRabochiySotuv()` (sotuvdan keyin rabochiy balonlar o‘chiriladi), `inventoryService`, `legacyDataService`.
- **Yozish:** `razmer`, `balon_turi`, `soni`, `narx`, `holat`, `shop_id`.

### 4. **Rabochiy sotuv** → **`rabochiy_sotuv`**

- **Qayerda:** `saleService.saveRabochiySotuv()`.
- **Yozish:** `razmer`, `balon_turi`, `olingan_narx`, `sotilgan_narx`, `shop_id`. Shu bilan birga `rabochiy_balon` dan tegishli yozuvlar o‘chiriladi.

### 5. **Olinish kerak** → **`olinish_kerak`**

- **Qayerda:** `legacyDataService.createOlinishKerak()`, `inventoryService` (sync), **index.js** (qo‘lda qo‘shish).
- **Yozish:** `razmer`, `balon_turi`, `soni`, `shop_id`.

### 6. **Razmerlar va brendlar** → **`sizes`**, **`brands`**

- **Qayerda:** Kirim yozilganda va OCR batch da `legacyDataService` orqali `ensureSize` / `ensureBrand` → `prisma.size.upsert`, `prisma.brand.upsert`.

### 7. **Do‘konlar va sozlamalar**

- **`shops`:** `shopService.createShop()`, initDb.
- **`shop_settings`:** `shopService.getSetting()` / sozlama saqlash (dollar_kurs va boshqalar).
- **`shop_admins`:** do‘kon adminlarini boshqarish.

### 8. **Ombor logi** → **`warehouse_logs`**

- **Qayerda:** `tireService` (yangi shina kirim/chiqim, yangi/ishchi shina), `salesService.createSale()`.
- **Yozish:** `item_type`, `tire_id` / `used_tire_id`, `log_type` (IN/OUT), `quantity`, `price`.

### 9. **Admin / User**

- **`admins`:** admin qo‘shish (settings).
- **`users`:** authService, middlewares orqali foydalanuvchi yaratish/o‘qish.

### 10. **Dollar kursi** → **`dollar_history`**

- **Qayerda:** `shopService` (kurs o‘zgartirilganda).

---

## Qisqacha xulosa: bot qaysi jadvalga bog‘liq

| Ma’lumot turi     | Asosiy jadval(lar)        | Bot yozadi/o‘qiydi |
|-------------------|---------------------------|---------------------|
| Yangi shina kirim | **tires**, sizes, brands  | Ha                  |
| Sotuvlar          | **sales**                 | Ha                  |
| Ishchi shinalar   | **used_tires**            | Ha (tireService)    |
| Rabochiy balon    | **rabochiy_balon**, **rabochiy_sotuv** | Ha |
| Olinish kerak     | **olinish_kerak**         | Ha                  |
| Do‘konlar/sozlamalar | shops, shop_settings, shop_admins | Ha |
| Ombor harakati    | **warehouse_logs**        | Ha                  |

Barcha yozuvlar **bir xil PostgreSQL bazasida**, **shu jadval nomlari** bilan. Agar backend yoki mobile boshqa jadval nomiga (yoki boshqa bazaga) yozsa/o‘qisa, ma’lumotlar “chalkashib” ketadi: bot bir jadvalga, ilova boshqasiga qaraydi.

---

## Maslahat: backend va mobile bilan bir xil ma’lumot

1. **Bitta baza, bitta jadval to‘plami**  
   Backend (mobile API) **xuddi shu** `tires`, `sales`, `used_tires`, `rabochiy_balon`, `rabochiy_sotuv`, `olinish_kerak`, `shops`, `shop_settings` va hokazo jadvallardan **o‘qishi va yozishi** kerak. Boshqa nomli jadval (masalan, `inventory`, `orders`) ochib, faqat mobile uchun yozish **chalkashlik** keltiradi.

2. **Bir xil DATABASE_URL**  
   Telegram bot va backend **bir xil** `.env` dagi `DATABASE_URL` (yoki bir xil connection string) orqali ulanishi kerak. URL boshqacha bo‘lsa, ikkita baza bo‘ladi, ma’lumotlar uchrashmaydi.

3. **sales jadvali — bitta manba**  
   Sotuvlar **faqat** `sales` jadvalida bo‘lishi kerak. Backend sotuv yozganda ham `sales` ga yozsin, o‘qiganda ham `sales` dan o‘qisin. Agar hozir backend boshqa jadvalga (yoki boshqa bazaga) yozayotgan bo‘lsa, uni `sales` (va kerak bo‘lsa tires, used_tires) ga qaytarish kerak.

4. **Schema bir xilligi**  
   `sales` jadvalida agar eski ustunlar (razmer, balon_turi, sotildi, foyda, …) ishlatilsa, Prisma schema va backend API bir xil ustunlar to‘plamiga moslashtirilgan bo‘lishi kerak. Schema o‘zgartirilmasa (siz aytgandek), backend ham **o‘sha** jadval strukturasi bo‘yicha yozib/o‘qishi kerak.

5. **API orqali birlashtirish (ixtiyoriy)**  
   Kelajakda agar bot ham “backend API” orqali yozib/o‘qimoqchi bo‘lsa, barcha yozuv/o‘qish bir backend API dan o‘tsa, jadval tanlovi bir joyda bo‘ladi va chalkashlik kamayadi.

---

## Xulosa

- **Kirim** → **`tires`** (+ sizes, brands).
- **Sotuv (chiqim)** → **`sales`**.
- **Ishchi shinalar** → **`used_tires`**.
- **Rabochiy balon/sotuv** → **`rabochiy_balon`**, **`rabochiy_sotuv`**.
- **Olinish kerak** → **`olinish_kerak`**.
- Do‘konlar, sozlamalar, admin/user, log → **shops**, **shop_settings**, **shop_admins**, **warehouse_logs**, **admins**, **users**, **dollar_history**.

Backend va mobile **shu jadvallardan** va **shu bazadan** foydalansa, telegram bot va ilova bir xil ma’lumotni ko‘radi.
