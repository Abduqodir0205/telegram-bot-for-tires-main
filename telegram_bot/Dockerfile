FROM node:20-slim

# Tesseract uchun kerakli tizim paketlarini o'rnatish
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    libtesseract-dev \
    openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Avval faqat package fayllarini ko'chirib, o'rnatamiz
COPY package*.json ./
RUN npm install

# Keyin loyiha fayllarini va Prisma sxemasini ko'chiramiz
COPY . .

# Prisma-ni majburiy generatsiya qilish
RUN npx prisma generate

# Botni ishga tushirish
CMD npx prisma db push && node src/index.js