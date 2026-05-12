-- CreateTable
CREATE TABLE "OnChainOrder" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "chainId" INTEGER NOT NULL,
    "onChainOrderId" TEXT NOT NULL,
    "buyer" TEXT NOT NULL,
    "seller" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "amountWei" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME,
    "paidAt" DATETIME,
    "shippedAt" DATETIME,
    "completedAt" DATETIME,
    "refundedAt" DATETIME,
    "disputedAt" DATETIME,
    "lastBlock" BIGINT NOT NULL,
    "lastLogIndex" INTEGER NOT NULL DEFAULT 0,
    "lastTxHash" TEXT NOT NULL,
    "lastSyncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "IndexerState" (
    "chainId" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "lastBlock" BIGINT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "OnChainOrder_buyer_idx" ON "OnChainOrder"("buyer");

-- CreateIndex
CREATE INDEX "OnChainOrder_seller_idx" ON "OnChainOrder"("seller");

-- CreateIndex
CREATE INDEX "OnChainOrder_status_idx" ON "OnChainOrder"("status");

-- CreateIndex
CREATE INDEX "OnChainOrder_chainId_idx" ON "OnChainOrder"("chainId");

-- CreateIndex
CREATE UNIQUE INDEX "OnChainOrder_chainId_onChainOrderId_key" ON "OnChainOrder"("chainId", "onChainOrderId");
