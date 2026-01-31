// Format currency
function formatCurrency(amount, currency = 'USD') {
  if (currency === 'USD') {
    return `$${amount.toFixed(2)}`;
  }
  return `${amount.toLocaleString('uz-UZ')} so'm`;
}

// Format date
function formatDate(date) {
  return new Date(date).toLocaleDateString('uz-UZ', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Format short date
function formatShortDate(date) {
  return new Date(date).toLocaleDateString('uz-UZ', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

// Get start of day
function getStartOfDay(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

// Get end of day
function getEndOfDay(date = new Date()) {
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return end;
}

// Get start of month
function getStartOfMonth(date = new Date()) {
  const start = new Date(date);
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  return start;
}

// Get end of month
function getEndOfMonth(date = new Date()) {
  const end = new Date(date);
  end.setMonth(end.getMonth() + 1);
  end.setDate(0);
  end.setHours(23, 59, 59, 999);
  return end;
}

// Translate condition to Uzbek
function translateCondition(condition) {
  const translations = {
    EXCELLENT: "A'lo",
    GOOD: 'Yaxshi',
    FAIR: "O'rtacha",
    POOR: 'Yomon',
  };
  return translations[condition] || condition;
}

// Translate item type to Uzbek
function translateItemType(type) {
  return type === 'NEW' ? 'Yangi' : 'Rabochiy';
}

// Escape markdown characters
function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

// Validate tire size format
function isValidTireSize(size) {
  const pattern = /^\d{3}\/\d{2}\s?R\d{2}$/i;
  return pattern.test(size);
}

// Parse tire size
function parseTireSize(size) {
  const match = size.match(/^(\d{3})\/(\d{2})\s?R(\d{2})$/i);
  if (!match) return null;
  return {
    width: parseInt(match[1]),
    aspectRatio: parseInt(match[2]),
    diameter: parseInt(match[3]),
  };
}

// Chunk array for pagination
function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

module.exports = {
  formatCurrency,
  formatDate,
  formatShortDate,
  getStartOfDay,
  getEndOfDay,
  getStartOfMonth,
  getEndOfMonth,
  translateCondition,
  translateItemType,
  escapeMarkdown,
  isValidTireSize,
  parseTireSize,
  chunkArray,
};
