import { expect } from "chai";
import { network } from "hardhat";

describe("V3.3 KlerosV2DisputeAdapterV3_3", function () {
  const DISPUTE_RESOLUTION_DELAY = 3 * 24 * 60 * 60;
  const KLEROS_TIMEOUT = 30 * 24 * 60 * 60;
  const EMERGENCY_TIMELOCK = 7 * 24 * 60 * 60;
  const AMOUNT_RAW = 3_000_000n; // 3 mUSD at 6 decimals
  const PRODUCT_ID = 1n;

  enum OrderStatus {
    Created,
    Paid,
    Shipped,
    Completed,
    Cancelled,
    Disputed,
    Refunded
  }

  async function deploy() {
    const { ethers } = await network.create();
    const [owner, buyer, seller, other] = await ethers.getSigners();

    // v3.3 marketplace constructor needs (shopNft, distributor). Both are
    // minimal stand-ins; the Kleros adapter tests don't exercise share
    // mechanics — they just need the wiring to not revert on completion.
    const shopNft = await ethers.deployContract("MockShopNFTMinimal", [], owner);
    const distributor = await ethers.deployContract("MockRevenueDistributor", [], owner);

    const marketplace = await ethers.deployContract(
      "EscrowMarketplaceV3_3",
      [await shopNft.getAddress(), await distributor.getAddress()],
      owner
    );
    const mockUsd = await ethers.deployContract("MockERC20", ["Mock USD", "mUSD", 6], owner);
    const arbitrator = await ethers.deployContract("MockArbitratorV2", [], owner);

    // Allow mUSD before ownership transfer — afterwards we'd have to go
    // through executeOnMarketplace.
    await marketplace.connect(owner).setAcceptedToken(await mockUsd.getAddress(), true);

    const adapter = await ethers.deployContract(
      "KlerosV2DisputeAdapterV3_3",
      [await marketplace.getAddress(), await arbitrator.getAddress(), "0x", 0n],
      owner
    );

    // Hand marketplace ownership to adapter (Ownable2Step → propose + accept).
    await marketplace.connect(owner).transferOwnership(await adapter.getAddress());
    await adapter.connect(owner).acceptMarketplaceOwnership();

    // Mint mUSD to the test buyer.
    await mockUsd.mint(buyer.address, AMOUNT_RAW * 10n);

    return {
      ethers,
      owner,
      buyer,
      seller,
      other,
      marketplace,
      mockUsd,
      arbitrator,
      adapter,
      shopNft,
      distributor
    };
  }

  async function setupDisputedOrder(ctx: Awaited<ReturnType<typeof deploy>>) {
    const { marketplace, mockUsd, buyer, seller } = ctx;
    const marketplaceAddr = await marketplace.getAddress();
    const tokenAddr = await mockUsd.getAddress();

    await mockUsd.connect(buyer).approve(marketplaceAddr, AMOUNT_RAW);
    await marketplace.connect(buyer).createOrder(seller.address, tokenAddr, PRODUCT_ID, AMOUNT_RAW);
    const orderId = 1n;
    await marketplace.connect(buyer).payOrderERC20(orderId);
    await marketplace.connect(seller).markShipped(orderId);
    await marketplace.connect(buyer).openDispute(orderId);
    return orderId;
  }

  async function advanceTime(ctx: Awaited<ReturnType<typeof deploy>>, seconds: number) {
    await ctx.ethers.provider.send("evm_increaseTime", [seconds]);
    await ctx.ethers.provider.send("evm_mine", []);
  }

  describe("constructor + ownership handover", function () {
    it("sets immutable fields", async function () {
      const { adapter, marketplace, arbitrator } = await deploy();
      expect(await adapter.marketplace()).to.equal(await marketplace.getAddress());
      expect(await adapter.arbitrator()).to.equal(await arbitrator.getAddress());
      expect(await adapter.arbitratorExtraData()).to.equal("0x");
      expect(await adapter.templateId()).to.equal(0n);
    });

    it("rejects zero marketplace address", async function () {
      const { ethers } = await network.create();
      const [deployer] = await ethers.getSigners();
      const arbitrator = await ethers.deployContract("MockArbitratorV2", [], deployer);
      const factory = await ethers.getContractFactory("KlerosV2DisputeAdapterV3_3", deployer);
      await expect(
        factory.deploy(ethers.ZeroAddress, await arbitrator.getAddress(), "0x", 0n)
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("rejects zero arbitrator address", async function () {
      const { ethers } = await network.create();
      const [deployer] = await ethers.getSigners();
      const shopNft = await ethers.deployContract("MockShopNFTMinimal", [], deployer);
      const distributor = await ethers.deployContract("MockRevenueDistributor", [], deployer);
      const marketplace = await ethers.deployContract(
        "EscrowMarketplaceV3_3",
        [await shopNft.getAddress(), await distributor.getAddress()],
        deployer
      );
      const factory = await ethers.getContractFactory("KlerosV2DisputeAdapterV3_3", deployer);
      await expect(
        factory.deploy(await marketplace.getAddress(), ethers.ZeroAddress, "0x", 0n)
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("marketplace.owner() is the adapter after handover", async function () {
      const { marketplace, adapter } = await deploy();
      expect(await marketplace.owner()).to.equal(await adapter.getAddress());
    });
  });

  describe("escalateToKleros", function () {
    it("happy path: buyer pays fee, dispute created, mappings set", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, adapter, arbitrator } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");

      await expect(adapter.connect(buyer).escalateToKleros(orderId, { value: fee }))
        .to.emit(adapter, "DisputeEscalated")
        .withArgs(orderId, 1n, buyer.address, fee)
        .and.to.emit(adapter, "Dispute")
        .withArgs(await arbitrator.getAddress(), 1n, 0n, "");

      expect(await adapter.klerosDisputeIdByOrder(orderId)).to.equal(1n);
      expect(await adapter.orderEscalated(orderId)).to.equal(true);
      expect(await adapter.orderIdByDispute(1n)).to.equal(orderId);
      expect(await adapter.escalatedAt(orderId)).to.be.greaterThan(0n);
    });

    it("seller can also escalate", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { seller, adapter, arbitrator } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");

      await expect(adapter.connect(seller).escalateToKleros(orderId, { value: fee }))
        .to.emit(adapter, "DisputeEscalated");
    });

    it("over-payment stored as pending refund (pull pattern)", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { ethers, buyer, adapter, arbitrator } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");
      const excess = ethers.parseEther("0.5");

      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee + excess });
      expect(await adapter.pendingRefunds(buyer.address)).to.equal(excess);

      const balBefore = await ethers.provider.getBalance(buyer.address);
      const tx = await adapter.connect(buyer).withdrawRefund();
      const r = await tx.wait();
      const gas = r!.gasUsed * r!.gasPrice;
      const balAfter = await ethers.provider.getBalance(buyer.address);
      expect(balAfter - balBefore + gas).to.equal(excess);
      expect(await adapter.pendingRefunds(buyer.address)).to.equal(0n);
    });

    it("withdrawRefund reverts when nothing owed", async function () {
      const { other, adapter } = await deploy();
      await expect(adapter.connect(other).withdrawRefund()).to.be.revertedWithCustomError(adapter, "NoRefundPending");
    });

    it("reverts AlreadyEscalated on second call", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, seller, adapter, arbitrator } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");

      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee });
      await expect(
        adapter.connect(seller).escalateToKleros(orderId, { value: fee })
      ).to.be.revertedWithCustomError(adapter, "AlreadyEscalated");
    });

    it("reverts NotPartyOfOrder for an unrelated wallet", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { other, adapter, arbitrator } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");
      await expect(
        adapter.connect(other).escalateToKleros(orderId, { value: fee })
      ).to.be.revertedWithCustomError(adapter, "NotPartyOfOrder");
    });

    it("reverts OrderNotDisputed when status is not Disputed", async function () {
      const ctx = await deploy();
      const { marketplace, mockUsd, buyer, seller, adapter, arbitrator } = ctx;
      const tokenAddr = await mockUsd.getAddress();
      await mockUsd.connect(buyer).approve(await marketplace.getAddress(), AMOUNT_RAW);
      await marketplace.connect(buyer).createOrder(seller.address, tokenAddr, PRODUCT_ID, AMOUNT_RAW);
      // orderId=1 is in Created status here, not Disputed.
      const fee = await arbitrator.arbitrationCost("0x");
      await expect(
        adapter.connect(buyer).escalateToKleros(1n, { value: fee })
      ).to.be.revertedWithCustomError(adapter, "OrderNotDisputed");
    });

    it("reverts InsufficientArbitrationFee", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, adapter, arbitrator } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");
      await expect(
        adapter.connect(buyer).escalateToKleros(orderId, { value: fee - 1n })
      ).to.be.revertedWithCustomError(adapter, "InsufficientArbitrationFee");
    });

    it("handles Kleros disputeId == 0 via orderEscalated flag", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, seller, adapter, arbitrator } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");

      await arbitrator.setNextDisputeID(0n);
      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee });
      expect(await adapter.klerosDisputeIdByOrder(orderId)).to.equal(0n);
      expect(await adapter.orderEscalated(orderId)).to.equal(true);

      await expect(
        adapter.connect(seller).escalateToKleros(orderId, { value: fee })
      ).to.be.revertedWithCustomError(adapter, "AlreadyEscalated");
    });
  });

  describe("rule (Kleros callback)", function () {
    it("only the arbitrator can call rule", async function () {
      const { other, adapter } = await deploy();
      await expect(adapter.connect(other).rule(1n, 1n)).to.be.revertedWithCustomError(adapter, "OnlyArbitrator");
    });

    it("reverts UnknownDispute for non-existent disputeID", async function () {
      const ctx = await deploy();
      const arbitratorAddr = await ctx.arbitrator.getAddress();
      await ctx.ethers.provider.send("hardhat_impersonateAccount", [arbitratorAddr]);
      await ctx.ethers.provider.send("hardhat_setBalance", [arbitratorAddr, "0x56BC75E2D63100000"]);
      const arbitratorSigner = await ctx.ethers.getSigner(arbitratorAddr);
      await expect(
        ctx.adapter.connect(arbitratorSigner).rule(999n, 1n)
      ).to.be.revertedWithCustomError(ctx.adapter, "UnknownDispute");
      await ctx.ethers.provider.send("hardhat_stopImpersonatingAccount", [arbitratorAddr]);
    });

    it("reverts InvalidRuling for ruling > 2", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, adapter, arbitrator } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");
      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee });

      await expect(arbitrator.giveRuling(1n, 3n)).to.be.revertedWithCustomError(adapter, "InvalidRuling");
    });

    it("ruling=1 buyer wins → refund (after cooldown)", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, adapter, arbitrator, marketplace, mockUsd } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");
      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee });
      await advanceTime(ctx, DISPUTE_RESOLUTION_DELAY + 1);

      const buyerBalBefore = await mockUsd.balanceOf(buyer.address);
      await expect(arbitrator.giveRuling(1n, 1n))
        .to.emit(adapter, "DisputeRuled")
        .withArgs(orderId, 1n, 1n);

      const order = await marketplace.getOrder(orderId);
      expect(order.status).to.equal(OrderStatus.Refunded);
      const buyerBalAfter = await mockUsd.balanceOf(buyer.address);
      expect(buyerBalAfter - buyerBalBefore).to.equal(AMOUNT_RAW);
      expect(await adapter.pendingRulings(orderId)).to.equal(0n);
    });

    it("ruling=2 seller wins → release (after cooldown)", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, seller, adapter, arbitrator, marketplace, mockUsd } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");
      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee });
      await advanceTime(ctx, DISPUTE_RESOLUTION_DELAY + 1);

      // v3.3 fee = 1% by default. Seller receives amount - fee.
      const feeBps = await marketplace.feeRateBps();
      const platformFee = (AMOUNT_RAW * BigInt(feeBps)) / 10_000n;
      const sellerExpected = AMOUNT_RAW - platformFee;

      const sellerBalBefore = await mockUsd.balanceOf(seller.address);
      await expect(arbitrator.giveRuling(1n, 2n))
        .to.emit(adapter, "DisputeRuled")
        .withArgs(orderId, 1n, 2n);

      const order = await marketplace.getOrder(orderId);
      expect(order.status).to.equal(OrderStatus.Completed);
      const sellerBalAfter = await mockUsd.balanceOf(seller.address);
      expect(sellerBalAfter - sellerBalBefore).to.equal(sellerExpected);
    });

    it("ruling=2 seller wins → distributor receives platform fee (v3.3-specific)", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, adapter, arbitrator, marketplace, mockUsd, distributor } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");
      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee });
      await advanceTime(ctx, DISPUTE_RESOLUTION_DELAY + 1);

      const feeBps = await marketplace.feeRateBps();
      const expectedFee = (AMOUNT_RAW * BigInt(feeBps)) / 10_000n;
      // shopId=1 because MockShopNFTMinimal defaults all sellers to 1.
      const distBalBefore = await mockUsd.balanceOf(await distributor.getAddress());
      await expect(arbitrator.giveRuling(1n, 2n)).to.emit(adapter, "DisputeRuled");
      const distBalAfter = await mockUsd.balanceOf(await distributor.getAddress());
      expect(distBalAfter - distBalBefore).to.equal(expectedFee);
      expect(await distributor.erc20ByShop(1n, await mockUsd.getAddress())).to.equal(expectedFee);
    });

    it("ruling=0 refuse → defaults to buyer refund (conservative)", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, adapter, arbitrator, marketplace, mockUsd } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");
      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee });
      await advanceTime(ctx, DISPUTE_RESOLUTION_DELAY + 1);

      const buyerBalBefore = await mockUsd.balanceOf(buyer.address);
      await expect(arbitrator.giveRuling(1n, 0n))
        .to.emit(adapter, "DisputeRuled")
        .withArgs(orderId, 1n, 1n); // emitted with normalised ruling (refuse → buyer)

      const order = await marketplace.getOrder(orderId);
      expect(order.status).to.equal(OrderStatus.Refunded);
      const buyerBalAfter = await mockUsd.balanceOf(buyer.address);
      expect(buyerBalAfter - buyerBalBefore).to.equal(AMOUNT_RAW);
    });

    it("ruling before cooldown defers; applyKlerosRuling completes after cooldown", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, other, adapter, arbitrator, marketplace, mockUsd } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");
      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee });

      // Cooldown NOT elapsed. Ruling stays pending.
      await expect(arbitrator.giveRuling(1n, 1n))
        .to.emit(adapter, "RulingDeferred")
        .withArgs(orderId, 1n, 1n, "Dispute resolution delay has not elapsed");
      expect(await adapter.pendingRulings(orderId)).to.equal(1n);
      let order = await marketplace.getOrder(orderId);
      expect(order.status).to.equal(OrderStatus.Disputed);

      // After cooldown elapses, anyone can apply.
      await advanceTime(ctx, DISPUTE_RESOLUTION_DELAY + 1);
      const buyerBalBefore = await mockUsd.balanceOf(buyer.address);
      await expect(adapter.connect(other).applyKlerosRuling(orderId))
        .to.emit(adapter, "DisputeRuled");
      order = await marketplace.getOrder(orderId);
      expect(order.status).to.equal(OrderStatus.Refunded);
      const buyerBalAfter = await mockUsd.balanceOf(buyer.address);
      expect(buyerBalAfter - buyerBalBefore).to.equal(AMOUNT_RAW);
    });

    it("applyKlerosRuling reverts when nothing pending", async function () {
      const { other, adapter } = await deploy();
      await expect(adapter.connect(other).applyKlerosRuling(1n)).to.be.revertedWithCustomError(adapter, "UnknownDispute");
    });
  });

  describe("emergency refund (propose / execute / cancel)", function () {
    async function escalated(ctx: Awaited<ReturnType<typeof deploy>>) {
      const orderId = await setupDisputedOrder(ctx);
      const fee = await ctx.arbitrator.arbitrationCost("0x");
      await ctx.adapter.connect(ctx.buyer).escalateToKleros(orderId, { value: fee });
      return orderId;
    }

    it("propose reverts before KLEROS_TIMEOUT", async function () {
      const ctx = await deploy();
      const orderId = await escalated(ctx);
      await expect(
        ctx.adapter.connect(ctx.owner).proposeEmergencyRefund(orderId, true)
      ).to.be.revertedWithCustomError(ctx.adapter, "KlerosTimeoutNotElapsed");
    });

    it("propose reverts if not escalated", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      await expect(
        ctx.adapter.connect(ctx.owner).proposeEmergencyRefund(orderId, true)
      ).to.be.revertedWithCustomError(ctx.adapter, "NotEscalated");
    });

    it("propose succeeds after KLEROS_TIMEOUT", async function () {
      const ctx = await deploy();
      const orderId = await escalated(ctx);
      await advanceTime(ctx, KLEROS_TIMEOUT + 1);
      await expect(ctx.adapter.connect(ctx.owner).proposeEmergencyRefund(orderId, true))
        .to.emit(ctx.adapter, "EmergencyRefundProposed");
      expect(await ctx.adapter.emergencyProposedAt(orderId)).to.be.greaterThan(0n);
      expect(await ctx.adapter.emergencyRefundBuyer(orderId)).to.equal(true);
    });

    it("execute reverts before EMERGENCY_TIMELOCK", async function () {
      const ctx = await deploy();
      const orderId = await escalated(ctx);
      await advanceTime(ctx, KLEROS_TIMEOUT + 1);
      await ctx.adapter.connect(ctx.owner).proposeEmergencyRefund(orderId, true);
      await expect(
        ctx.adapter.connect(ctx.owner).executeEmergencyRefund(orderId)
      ).to.be.revertedWithCustomError(ctx.adapter, "EmergencyTimelockNotElapsed");
    });

    it("execute succeeds after timelock + refunds buyer", async function () {
      const ctx = await deploy();
      const orderId = await escalated(ctx);
      const { buyer, owner, adapter, marketplace, mockUsd } = ctx;
      await advanceTime(ctx, KLEROS_TIMEOUT + 1);
      await adapter.connect(owner).proposeEmergencyRefund(orderId, true);
      await advanceTime(ctx, EMERGENCY_TIMELOCK + 1);

      const buyerBalBefore = await mockUsd.balanceOf(buyer.address);
      await expect(adapter.connect(owner).executeEmergencyRefund(orderId))
        .to.emit(adapter, "EmergencyRefundExecuted")
        .withArgs(orderId, true);
      const order = await marketplace.getOrder(orderId);
      expect(order.status).to.equal(OrderStatus.Refunded);
      const buyerBalAfter = await mockUsd.balanceOf(buyer.address);
      expect(buyerBalAfter - buyerBalBefore).to.equal(AMOUNT_RAW);
    });

    it("execute with refundBuyer=false releases to seller (minus platform fee)", async function () {
      const ctx = await deploy();
      const orderId = await escalated(ctx);
      const { seller, owner, adapter, marketplace, mockUsd } = ctx;
      await advanceTime(ctx, KLEROS_TIMEOUT + 1);
      await adapter.connect(owner).proposeEmergencyRefund(orderId, false);
      await advanceTime(ctx, EMERGENCY_TIMELOCK + 1);

      const feeBps = await marketplace.feeRateBps();
      const platformFee = (AMOUNT_RAW * BigInt(feeBps)) / 10_000n;
      const sellerExpected = AMOUNT_RAW - platformFee;

      const sellerBalBefore = await mockUsd.balanceOf(seller.address);
      await adapter.connect(owner).executeEmergencyRefund(orderId);
      const order = await marketplace.getOrder(orderId);
      expect(order.status).to.equal(OrderStatus.Completed);
      const sellerBalAfter = await mockUsd.balanceOf(seller.address);
      expect(sellerBalAfter - sellerBalBefore).to.equal(sellerExpected);
    });

    it("propose twice reverts EmergencyAlreadyProposed", async function () {
      const ctx = await deploy();
      const orderId = await escalated(ctx);
      await advanceTime(ctx, KLEROS_TIMEOUT + 1);
      await ctx.adapter.connect(ctx.owner).proposeEmergencyRefund(orderId, true);
      await expect(
        ctx.adapter.connect(ctx.owner).proposeEmergencyRefund(orderId, false)
      ).to.be.revertedWithCustomError(ctx.adapter, "EmergencyAlreadyProposed");
    });

    it("cancel clears proposal", async function () {
      const ctx = await deploy();
      const orderId = await escalated(ctx);
      await advanceTime(ctx, KLEROS_TIMEOUT + 1);
      await ctx.adapter.connect(ctx.owner).proposeEmergencyRefund(orderId, true);
      await expect(ctx.adapter.connect(ctx.owner).cancelEmergencyRefund(orderId))
        .to.emit(ctx.adapter, "EmergencyRefundCancelled")
        .withArgs(orderId);
      expect(await ctx.adapter.emergencyProposedAt(orderId)).to.equal(0n);
    });

    it("cancel reverts when nothing proposed", async function () {
      const ctx = await deploy();
      const orderId = await escalated(ctx);
      await expect(
        ctx.adapter.connect(ctx.owner).cancelEmergencyRefund(orderId)
      ).to.be.revertedWithCustomError(ctx.adapter, "EmergencyNotProposed");
    });

    it("non-owner cannot propose / execute / cancel", async function () {
      const ctx = await deploy();
      const orderId = await escalated(ctx);
      await advanceTime(ctx, KLEROS_TIMEOUT + 1);
      await expect(ctx.adapter.connect(ctx.other).proposeEmergencyRefund(orderId, true))
        .to.be.revertedWithCustomError(ctx.adapter, "OwnableUnauthorizedAccount");
    });
  });

  describe("ownership consequences", function () {
    it("direct marketplace.resolveDispute by EOA reverts (adapter owns marketplace)", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      await advanceTime(ctx, DISPUTE_RESOLUTION_DELAY + 1);
      await expect(ctx.marketplace.connect(ctx.owner).resolveDispute(orderId, true)).to.be.revertedWithCustomError(
        ctx.marketplace,
        "OwnableUnauthorizedAccount"
      );
    });

    it("Kleros ruling can still resolve the order (adapter is the owner)", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, adapter, arbitrator } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");
      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee });
      await advanceTime(ctx, DISPUTE_RESOLUTION_DELAY + 1);

      await expect(arbitrator.giveRuling(1n, 1n)).to.emit(adapter, "DisputeRuled");
    });
  });

  describe("conservation of marketplace token balance", function () {
    it("buyer-wins ruling: marketplace token delta == -amount", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, adapter, arbitrator, marketplace, mockUsd } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");
      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee });
      await advanceTime(ctx, DISPUTE_RESOLUTION_DELAY + 1);

      const mpBefore = await mockUsd.balanceOf(await marketplace.getAddress());
      await arbitrator.giveRuling(1n, 1n);
      const mpAfter = await mockUsd.balanceOf(await marketplace.getAddress());
      expect(mpBefore - mpAfter).to.equal(AMOUNT_RAW);
    });

    it("seller-wins ruling: marketplace token delta == -amount (seller + distributor split)", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, adapter, arbitrator, marketplace, mockUsd } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");
      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee });
      await advanceTime(ctx, DISPUTE_RESOLUTION_DELAY + 1);

      const mpBefore = await mockUsd.balanceOf(await marketplace.getAddress());
      await arbitrator.giveRuling(1n, 2n);
      const mpAfter = await mockUsd.balanceOf(await marketplace.getAddress());
      expect(mpBefore - mpAfter).to.equal(AMOUNT_RAW);
    });
  });

  describe("owner setters", function () {
    it("setArbitratorExtraData by owner emits + updates", async function () {
      const { owner, adapter } = await deploy();
      await expect(adapter.connect(owner).setArbitratorExtraData("0xdead"))
        .to.emit(adapter, "ArbitratorExtraDataUpdated")
        .withArgs("0x", "0xdead");
      expect(await adapter.arbitratorExtraData()).to.equal("0xdead");
    });

    it("setArbitratorExtraData by non-owner reverts", async function () {
      const { other, adapter } = await deploy();
      await expect(
        adapter.connect(other).setArbitratorExtraData("0xdead")
      ).to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount");
    });

    it("setTemplateId emits + updates", async function () {
      const { owner, adapter } = await deploy();
      await expect(adapter.connect(owner).setTemplateId(42n))
        .to.emit(adapter, "TemplateIdUpdated")
        .withArgs(0n, 42n);
      expect(await adapter.templateId()).to.equal(42n);
    });
  });

  describe("executeOnMarketplace pass-through", function () {
    it("only owner can call", async function () {
      const ctx = await deploy();
      const data = ctx.marketplace.interface.encodeFunctionData("pause");
      await expect(
        ctx.adapter.connect(ctx.other).executeOnMarketplace(data)
      ).to.be.revertedWithCustomError(ctx.adapter, "OwnableUnauthorizedAccount");
    });

    it("owner can pause/unpause marketplace through the adapter", async function () {
      const { owner, adapter, marketplace } = await deploy();
      expect(await marketplace.paused()).to.equal(false);
      const pauseData = marketplace.interface.encodeFunctionData("pause");
      await adapter.connect(owner).executeOnMarketplace(pauseData);
      expect(await marketplace.paused()).to.equal(true);
      const unpauseData = marketplace.interface.encodeFunctionData("unpause");
      await adapter.connect(owner).executeOnMarketplace(unpauseData);
      expect(await marketplace.paused()).to.equal(false);
    });

    it("owner can call setAcceptedToken via pass-through", async function () {
      const { ethers, owner, adapter, marketplace } = await deploy();
      const randomToken = ethers.Wallet.createRandom().address;
      const data = marketplace.interface.encodeFunctionData("setAcceptedToken", [randomToken, true]);
      await adapter.connect(owner).executeOnMarketplace(data);
      expect(await marketplace.acceptedToken(randomToken)).to.equal(true);
    });

    it("owner can call setDistributor via pass-through (v3.3-specific)", async function () {
      const { ethers, owner, adapter, marketplace } = await deploy();
      const newDist = await ethers.deployContract("MockRevenueDistributor", [], owner);
      const data = marketplace.interface.encodeFunctionData("setDistributor", [await newDist.getAddress()]);
      await adapter.connect(owner).executeOnMarketplace(data);
      expect(await marketplace.distributor()).to.equal(await newDist.getAddress());
    });

    it("owner can call setFeeRateBps via pass-through (v3.3-specific)", async function () {
      const { owner, adapter, marketplace } = await deploy();
      const data = marketplace.interface.encodeFunctionData("setFeeRateBps", [250]);
      await adapter.connect(owner).executeOnMarketplace(data);
      expect(await marketplace.feeRateBps()).to.equal(250n);
    });

    it("emits MarketplaceCallExecuted with selector", async function () {
      const { owner, adapter, marketplace } = await deploy();
      const data = marketplace.interface.encodeFunctionData("pause");
      const selector = data.slice(0, 10);
      await expect(adapter.connect(owner).executeOnMarketplace(data))
        .to.emit(adapter, "MarketplaceCallExecuted")
        .withArgs(selector, 0n);
    });

    it("bubbles up marketplace revert reason", async function () {
      const { owner, adapter, marketplace, ethers } = await deploy();
      // setAcceptedToken(0x0, true) is rejected by the marketplace.
      const data = marketplace.interface.encodeFunctionData("setAcceptedToken", [ethers.ZeroAddress, true]);
      await expect(adapter.connect(owner).executeOnMarketplace(data)).to.be.revertedWith(
        "Token cannot be zero address"
      );
    });
  });

  describe("withdrawBalance", function () {
    it("owner can drain stranded ETH; non-owner cannot", async function () {
      const { ethers, owner, other, adapter } = await deploy();
      const adapterAddr = await adapter.getAddress();
      await owner.sendTransaction({ to: adapterAddr, value: ethers.parseEther("0.05") });

      await expect(adapter.connect(other).withdrawBalance(other.address)).to.be.revertedWithCustomError(
        adapter,
        "OwnableUnauthorizedAccount"
      );

      const before = await ethers.provider.getBalance(owner.address);
      const tx = await adapter.connect(owner).withdrawBalance(owner.address);
      const r = await tx.wait();
      const gas = r!.gasUsed * r!.gasPrice;
      const after = await ethers.provider.getBalance(owner.address);
      expect(after - before + gas).to.equal(ethers.parseEther("0.05"));
    });

    it("withdrawBalance reverts at zero balance", async function () {
      const { owner, adapter } = await deploy();
      await expect(adapter.connect(owner).withdrawBalance(owner.address)).to.be.revertedWith("No balance");
    });
  });
});
