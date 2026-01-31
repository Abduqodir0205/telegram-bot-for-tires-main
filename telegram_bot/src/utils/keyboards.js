const { Keyboard, InlineKeyboard } = require('grammy');

// Admin Main Menu
const adminMainMenu = new Keyboard()
  .text('🛞 Yangi balonlar').text('♻️ Rabochiy balonlar').row()
  .text('📦 Sklad').text('💰 Sotish').row()
  .text('📊 Hisobotlar').text('📥 Excel yuklab olish').row()
  .text('⚙️ Sozlamalar')
  .resized();

// Admin Tire Management
const adminTireMenu = new Keyboard()
  .text('➕ Balon qo\'shish').text('📋 Balonlar ro\'yxati').row()
  .text('✏️ Balon tahrirlash').text('🔙 Orqaga')
  .resized();

// Admin Used Tire Management
const adminUsedTireMenu = new Keyboard()
  .text('➕ Rabochiy qabul qilish').text('📋 Rabochiy ro\'yxati').row()
  .text('💵 Narx belgilash').text('🔙 Orqaga')
  .resized();

// Admin Warehouse Menu
const adminWarehouseMenu = new Keyboard()
  .text('📦 Yangi balonlar skladi').text('♻️ Rabochiy balonlar skladi').row()
  .text('⚠️ Tugagan balonlar').text('💰 Umumiy qiymat').row()
  .text('🔙 Orqaga')
  .resized();

// Admin Sales Menu
const adminSalesMenu = new Keyboard()
  .text('🛞 Yangi balon sotish').text('♻️ Rabochiy sotish').row()
  .text('📜 Sotuvlar tarixi').text('🔙 Orqaga')
  .resized();

// Admin Reports Menu
const adminReportsMenu = new Keyboard()
  .text('📅 Kunlik hisobot').text('📆 Oylik hisobot').row()
  .text('📈 Umumiy hisobot').text('💵 Kirim/Chiqim').row()
  .text('🔙 Orqaga')
  .resized();

// Admin Settings Menu
const adminSettingsMenu = new Keyboard()
  .text('📍 Lokatsiyani o\'zgartirish').text('📞 Telefon o\'zgartirish').row()
  .text('👤 Admin qo\'shish').text('👥 Adminlar ro\'yxati').row()
  .text('🔙 Orqaga')
  .resized();

// User Main Menu
const userMainMenu = new Keyboard()
  .text('🛞 Yangi balonlar').text('♻️ Rabochiy balonlar').row()
  .text('📍 Manzil').text('📞 Aloqa').row()
  .text('ℹ️ Ma\'lumot')
  .resized();

// Back Button
const backButton = new Keyboard()
  .text('🔙 Orqaga')
  .resized();

// Cancel Button
const cancelButton = new Keyboard()
  .text('❌ Bekor qilish')
  .resized();

// Confirmation Keyboard
const confirmKeyboard = new Keyboard()
  .text('✅ Tasdiqlash').text('❌ Bekor qilish')
  .resized();

// Inline keyboards
function createTireInlineKeyboard(tireId, type = 'new') {
  return new InlineKeyboard()
    .text('✏️ Tahrirlash', `edit_${type}_${tireId}`)
    .text('🗑 O\'chirish', `delete_${type}_${tireId}`);
}

function createPaginationKeyboard(currentPage, totalPages, prefix) {
  const keyboard = new InlineKeyboard();
  
  if (currentPage > 1) {
    keyboard.text('⬅️', `${prefix}_page_${currentPage - 1}`);
  }
  
  keyboard.text(`${currentPage}/${totalPages}`, 'noop');
  
  if (currentPage < totalPages) {
    keyboard.text('➡️', `${prefix}_page_${currentPage + 1}`);
  }
  
  return keyboard;
}

function createConditionKeyboard() {
  return new InlineKeyboard()
    .text('A\'lo', 'condition_EXCELLENT')
    .text('Yaxshi', 'condition_GOOD').row()
    .text('O\'rtacha', 'condition_FAIR')
    .text('Yomon', 'condition_POOR');
}

module.exports = {
  adminMainMenu,
  adminTireMenu,
  adminUsedTireMenu,
  adminWarehouseMenu,
  adminSalesMenu,
  adminReportsMenu,
  adminSettingsMenu,
  userMainMenu,
  backButton,
  cancelButton,
  confirmKeyboard,
  createTireInlineKeyboard,
  createPaginationKeyboard,
  createConditionKeyboard,
};
