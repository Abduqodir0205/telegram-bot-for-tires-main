-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "ItemType" AS ENUM ('NEW', 'USED');

-- CreateEnum
CREATE TYPE "LogType" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "TireCondition" AS ENUM ('EXCELLENT', 'GOOD', 'FAIR', 'POOR');

-- CreateTable
CREATE TABLE "shops" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT,
    "phone" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "telegram_id" BIGINT NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "username" TEXT,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "shop_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admins" (
    "id" SERIAL NOT NULL,
    "telegram_id" BIGINT NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tires" (
    "id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "brand" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "price_buy" DOUBLE PRECISION NOT NULL,
    "price_sell" DOUBLE PRECISION NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tires_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "used_tires" (
    "id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "size" TEXT NOT NULL,
    "condition" "TireCondition" NOT NULL DEFAULT 'GOOD',
    "price_buy" DOUBLE PRECISION NOT NULL,
    "price_sell" DOUBLE PRECISION,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "used_tires_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales" (
    "id" SERIAL NOT NULL,
    "item_type" "ItemType" NOT NULL,
    "tire_id" INTEGER,
    "used_tire_id" INTEGER,
    "quantity" INTEGER NOT NULL,
    "total_price" DOUBLE PRECISION NOT NULL,
    "admin_id" INTEGER NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_logs" (
    "id" SERIAL NOT NULL,
    "item_type" "ItemType" NOT NULL,
    "tire_id" INTEGER,
    "used_tire_id" INTEGER,
    "log_type" "LogType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegram_id_key" ON "users"("telegram_id");

-- CreateIndex
CREATE INDEX "users_telegram_id_idx" ON "users"("telegram_id");

-- CreateIndex
CREATE UNIQUE INDEX "admins_telegram_id_key" ON "admins"("telegram_id");

-- CreateIndex
CREATE INDEX "admins_telegram_id_idx" ON "admins"("telegram_id");

-- CreateIndex
CREATE INDEX "tires_shop_id_idx" ON "tires"("shop_id");

-- CreateIndex
CREATE INDEX "tires_brand_idx" ON "tires"("brand");

-- CreateIndex
CREATE INDEX "tires_size_idx" ON "tires"("size");

-- CreateIndex
CREATE UNIQUE INDEX "tires_shop_id_brand_size_key" ON "tires"("shop_id", "brand", "size");

-- CreateIndex
CREATE INDEX "used_tires_shop_id_idx" ON "used_tires"("shop_id");

-- CreateIndex
CREATE INDEX "used_tires_size_idx" ON "used_tires"("size");

-- CreateIndex
CREATE UNIQUE INDEX "used_tires_shop_id_size_condition_key" ON "used_tires"("shop_id", "size", "condition");

-- CreateIndex
CREATE INDEX "sales_item_type_idx" ON "sales"("item_type");

-- CreateIndex
CREATE INDEX "sales_created_at_idx" ON "sales"("created_at");

-- CreateIndex
CREATE INDEX "sales_shop_id_idx" ON "sales"("shop_id");

-- CreateIndex
CREATE INDEX "warehouse_logs_item_type_idx" ON "warehouse_logs"("item_type");

-- CreateIndex
CREATE INDEX "warehouse_logs_log_type_idx" ON "warehouse_logs"("log_type");

-- CreateIndex
CREATE INDEX "warehouse_logs_created_at_idx" ON "warehouse_logs"("created_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admins" ADD CONSTRAINT "admins_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tires" ADD CONSTRAINT "tires_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "used_tires" ADD CONSTRAINT "used_tires_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tire_id_fkey" FOREIGN KEY ("tire_id") REFERENCES "tires"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_used_tire_id_fkey" FOREIGN KEY ("used_tire_id") REFERENCES "used_tires"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_logs" ADD CONSTRAINT "warehouse_logs_tire_id_fkey" FOREIGN KEY ("tire_id") REFERENCES "tires"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_logs" ADD CONSTRAINT "warehouse_logs_used_tire_id_fkey" FOREIGN KEY ("used_tire_id") REFERENCES "used_tires"("id") ON DELETE SET NULL ON UPDATE CASCADE;
