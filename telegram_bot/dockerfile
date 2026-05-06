FROM node:20-slim

# Tesseract uchun kerakli tizim paketlarini o'rnatish
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    libtesseract-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Prisma client'ni generatsiya qilish
RUN npx prisma generate

# Botni ishga tushirish (src/index.js orqali)
CMD ["node", "src/index.js"]