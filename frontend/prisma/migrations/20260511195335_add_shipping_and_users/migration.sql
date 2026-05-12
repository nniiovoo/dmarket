-- AlterTable
ALTER TABLE "OnChainOrder" ADD COLUMN "carrier" TEXT;
ALTER TABLE "OnChainOrder" ADD COLUMN "shippingNote" TEXT;
ALTER TABLE "OnChainOrder" ADD COLUMN "shippingUpdatedAt" DATETIME;
ALTER TABLE "OnChainOrder" ADD COLUMN "trackingNumber" TEXT;
ALTER TABLE "OnChainOrder" ADD COLUMN "trackingUrl" TEXT;

-- CreateTable
CREATE TABLE "User" (
    "walletAddress" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EmailLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "toAddress" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "onChainOrderId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE INDEX "EmailLog_toAddress_kind_onChainOrderId_idx" ON "EmailLog"("toAddress", "kind", "onChainOrderId");

-- CreateIndex
CREATE INDEX "EmailLog_createdAt_idx" ON "EmailLog"("createdAt");
