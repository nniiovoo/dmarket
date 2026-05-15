import { expect } from "chai";
import { network } from "hardhat";

describe("KlerosV2DisputeAdapter", function () {
  const DISPUTE_RESOLUTION_DELAY = 3 * 24 * 60 * 60;
  const PLACEHOLDER_SOURCE = "return Functions.encodeString('pending')";

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

    const vault = await ethers.deployContract("EscrowVaultV3", [owner.address], owner);
    const router = await ethers.deployContract("FunctionsRouterMock", [], owner);
    const marketplace = await ethers.deployContract(
      "EscrowMarketplaceV3",
      [await vault.getAddress(), await router.getAddress(), PLACEHOLDER_SOURCE],
      owner
    );
    await vault.connect(owner).setMarketplace(await marketplace.getAddress());

    const arbitrator = await ethers.deployContract("MockArbitratorV2", [], owner);

    const adapter = await ethers.deployContract(
      "KlerosV2DisputeAdapter",
      [
        await arbitrator.getAddress(),
        await marketplace.getAddress(),
        "0x",
        1n
      ],
      owner
    );

    // Hand marketplace ownership to adapter
    await marketplace.connect(owner).transferOwnership(await adapter.getAddress());
    await adapter.connect(owner).acceptMarketplaceOwnership();

    const amount = ethers.parseEther("0.1");
    const productId = 42n;
    return { ethers, owner, buyer, seller, other, vault, router, marketplace, arbitrator, adapter, amount, productId };
  }

  async function setupDisputedOrder(ctx: Awaited<ReturnType<typeof deploy>>) {
    const { marketplace, buyer, seller, amount, productId } = ctx;
    await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
    const orderId = 1n;
    await marketplace.connect(seller).markShipped(orderId);
    await marketplace.connect(buyer).openDispute(orderId);
    return orderId;
  }

  async function advanceCooldown(ctx: Awaited<ReturnType<typeof deploy>>) {
    await ctx.ethers.provider.send("evm_increaseTime", [DISPUTE_RESOLUTION_DELAY + 1]);
    await ctx.ethers.provider.send("evm_mine", []);
  }

  describe("constructor", function () {
    it("rejects zero arbitrator", async function () {
      const { ethers } = await network.create();
      const [deployer] = await ethers.getSigners();
      const vault = await ethers.deployContract("EscrowVaultV3", [deployer.address], deployer);
      const router = await ethers.deployContract("FunctionsRouterMock", [], deployer);
      const marketplace = await ethers.deployContract(
        "EscrowMarketplaceV3",
        [await vault.getAddress(), await router.getAddress(), PLACEHOLDER_SOURCE],
        deployer
      );

      const factory = await ethers.getContractFactory("KlerosV2DisputeAdapter", deployer);
      await expect(
        factory.deploy(ethers.ZeroAddress, await marketplace.getAddress(), "0x", 1n)
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("rejects zero marketplace", async function () {
      const { ethers } = await network.create();
      const [deployer] = await ethers.getSigners();
      const arbitrator = await ethers.deployContract("MockArbitratorV2", [], deployer);

      const factory = await ethers.getContractFactory("KlerosV2DisputeAdapter", deployer);
      await expect(
        factory.deploy(await arbitrator.getAddress(), ethers.ZeroAddress, "0x", 1n)
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("sets immutable fields + initial extra data + template", async function () {
      const { adapter, arbitrator, marketplace } = await deploy();
      expect(await adapter.arbitrator()).to.equal(await arbitrator.getAddress());
      expect(await adapter.marketplace()).to.equal(await marketplace.getAddress());
      expect(await adapter.arbitratorExtraData()).to.equal("0x");
      expect(await adapter.templateId()).to.equal(1n);
    });
  });

  describe("Marketplace ownership handover", function () {
    it("after deployer transferOwnership(adapter) + adapter.acceptMarketplaceOwnership(), marketplace.owner == adapter", async function () {
      const { marketplace, adapter } = await deploy();
      expect(await marketplace.owner()).to.equal(await adapter.getAddress());
    });
  });

  describe("escalateToKleros", function () {
    it("happy path: buyer pays fee, dispute created, mappings set, events fire", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, adapter, arbitrator } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");

      await expect(adapter.connect(buyer).escalateToKleros(orderId, { value: fee }))
        .to.emit(adapter, "DisputeEscalatedToKleros")
        .withArgs(orderId, 1n, buyer.address, fee)
        .and.to.emit(adapter, "Dispute")
        .withArgs(await arbitrator.getAddress(), 1n, 1n, "");

      expect(await adapter.orderToDisputeID(orderId)).to.equal(1n);
      expect(await adapter.disputeToOrderID(1n)).to.equal(orderId);
      expect(await adapter.disputeEscalatedBy(1n)).to.equal(buyer.address);
    });

    it("seller can also escalate", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { seller, adapter, arbitrator } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");

      await expect(adapter.connect(seller).escalateToKleros(orderId, { value: fee }))
        .to.emit(adapter, "DisputeEscalatedToKleros")
        .withArgs(orderId, 1n, seller.address, fee);
    });

    it("over-payment stored in pendingRefunds (pull-payment, H2 fix)", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { ethers, buyer, adapter, arbitrator } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");
      const excess = ethers.parseEther("0.5");
      const overpay = fee + excess;

      await adapter.connect(buyer).escalateToKleros(orderId, { value: overpay });

      // Refund is stored, not sent immediately.
      expect(await adapter.pendingRefunds(buyer.address)).to.equal(excess);

      // withdrawRefund sends it back.
      const balBefore = await ethers.provider.getBalance(buyer.address);
      const tx = await adapter.connect(buyer).withdrawRefund();
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice;
      const balAfter = await ethers.provider.getBalance(buyer.address);

      expect(balAfter - balBefore + gas).to.equal(excess);
      expect(await adapter.pendingRefunds(buyer.address)).to.equal(0n);
    });

    it("reverts NotPartyOfOrder for unrelated wallet", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { other, adapter, arbitrator } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");

      await expect(
        adapter.connect(other).escalateToKleros(orderId, { value: fee })
      ).to.be.revertedWithCustomError(adapter, "NotPartyOfOrder");
    });

    it("reverts OrderNotDisputed when status != Disputed", async function () {
      const ctx = await deploy();
      const { marketplace, buyer, seller, amount, productId, adapter, arbitrator } = ctx;
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      const fee = await arbitrator.arbitrationCost("0x");

      await expect(
        adapter.connect(buyer).escalateToKleros(1n, { value: fee })
      ).to.be.revertedWithCustomError(adapter, "OrderNotDisputed");
    });

    it("reverts AlreadyEscalated on second call for same orderId", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, seller, adapter, arbitrator } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");

      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee });
      await expect(
        adapter.connect(seller).escalateToKleros(orderId, { value: fee })
      ).to.be.revertedWithCustomError(adapter, "AlreadyEscalated");
    });

    it("reverts InsufficientArbitrationFee when msg.value < cost", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, adapter, arbitrator } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");

      await expect(
        adapter.connect(buyer).escalateToKleros(orderId, { value: fee - 1n })
      ).to.be.revertedWithCustomError(adapter, "InsufficientArbitrationFee");
    });
  });

  describe("rule (Kleros callback)", function () {
    it("reverts OnlyArbitrator when called by non-arbitrator", async function () {
      const { other, adapter } = await deploy();
      await expect(
        adapter.connect(other).rule(1n, 1n)
      ).to.be.revertedWithCustomError(adapter, "OnlyArbitrator");
    });

    it("reverts UnknownDispute for non-existent disputeID", async function () {
      const ctx = await deploy();
      const { arbitrator } = ctx;

      // giveRuling on an unknown disputeID first requires us to construct a
      // disputeID that has a recorded arbitrable address; trying to call
      // rule on the adapter via a path that doesn't go through the
      // arbitrator is the cleanest way. We impersonate the arbitrator EOA.
      const arbitratorAddress = await arbitrator.getAddress();
      await ctx.ethers.provider.send("hardhat_impersonateAccount", [arbitratorAddress]);
      await ctx.ethers.provider.send("hardhat_setBalance", [arbitratorAddress, "0x56BC75E2D63100000"]);
      const arbitratorSigner = await ctx.ethers.getSigner(arbitratorAddress);

      await expect(
        ctx.adapter.connect(arbitratorSigner).rule(999n, 1n)
      ).to.be.revertedWithCustomError(ctx.adapter, "UnknownDispute");

      await ctx.ethers.provider.send("hardhat_stopImpersonatingAccount", [arbitratorAddress]);
    });

    it("reverts InvalidRuling for ruling > 2", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, adapter, arbitrator } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");
      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee });

      await expect(arbitrator.giveRuling(1n, 3n)).to.be.revertedWithCustomError(adapter, "InvalidRuling");
    });

    it("RULING_REFUSE: emits Ruling, does not call marketplace, no pendingRuling stored", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, adapter, arbitrator, marketplace } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");
      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee });

      await expect(arbitrator.giveRuling(1n, 0n))
        .to.emit(adapter, "Ruling")
        .withArgs(await arbitrator.getAddress(), 1n, 0n);

      expect(await adapter.pendingRulings(orderId)).to.equal(0n);
      const order = await marketplace.getOrder(orderId);
      expect(order.status).to.equal(OrderStatus.Disputed);
    });

    it("RULING_BUYER after 3-day cooldown: calls marketplace.resolveDispute(_, true), refunds buyer via vault", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, adapter, arbitrator, marketplace, vault, amount } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");
      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee });

      await advanceCooldown(ctx);

      await expect(arbitrator.giveRuling(1n, 1n))
        .to.emit(adapter, "KlerosRulingApplied")
        .withArgs(orderId, 1n, 1n);

      const order = await marketplace.getOrder(orderId);
      expect(order.status).to.equal(OrderStatus.Refunded);
      expect(await vault.pendingWithdrawal(buyer.address)).to.equal(amount);
      expect(await adapter.pendingRulings(orderId)).to.equal(0n);
    });

    it("RULING_SELLER after 3-day cooldown: calls marketplace.resolveDispute(_, false), pays seller", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, seller, adapter, arbitrator, marketplace, vault, amount } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");
      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee });

      await advanceCooldown(ctx);

      await expect(arbitrator.giveRuling(1n, 2n))
        .to.emit(adapter, "KlerosRulingApplied")
        .withArgs(orderId, 1n, 2n);

      const order = await marketplace.getOrder(orderId);
      expect(order.status).to.equal(OrderStatus.Completed);
      expect(await vault.pendingWithdrawal(seller.address)).to.equal(amount);
    });

    it("RULING_BUYER before 3-day cooldown: stores pendingRuling, emits Deferred, marketplace state unchanged", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, adapter, arbitrator, marketplace } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");
      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee });

      // Cooldown NOT advanced — resolveDispute should revert inside try/catch.
      await expect(arbitrator.giveRuling(1n, 1n))
        .to.emit(adapter, "KlerosRulingDeferred")
        .withArgs(orderId, 1n, 1n, "Dispute resolution delay has not elapsed");

      expect(await adapter.pendingRulings(orderId)).to.equal(1n);
      const order = await marketplace.getOrder(orderId);
      expect(order.status).to.equal(OrderStatus.Disputed);
    });

    it("after Deferred, applyKlerosRuling once cooldown elapses applies the ruling", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, other, adapter, arbitrator, marketplace, vault, amount } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");
      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee });

      // Defer
      await arbitrator.giveRuling(1n, 1n);
      expect(await adapter.pendingRulings(orderId)).to.equal(1n);

      await advanceCooldown(ctx);

      await expect(adapter.connect(other).applyKlerosRuling(orderId))
        .to.emit(adapter, "KlerosRulingApplied")
        .withArgs(orderId, 1n, 1n);

      const order = await marketplace.getOrder(orderId);
      expect(order.status).to.equal(OrderStatus.Refunded);
      expect(await vault.pendingWithdrawal(buyer.address)).to.equal(amount);
    });
  });

  describe("applyKlerosRuling", function () {
    it("reverts NoPendingRuling if nothing pending", async function () {
      const ctx = await deploy();
      await expect(
        ctx.adapter.connect(ctx.other).applyKlerosRuling(1n)
      ).to.be.revertedWithCustomError(ctx.adapter, "NoPendingRuling");
    });

    it("anyone can call it (permissionless)", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, other, adapter, arbitrator } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");
      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee });
      await arbitrator.giveRuling(1n, 2n);
      await advanceCooldown(ctx);

      // `other` is unrelated wallet — should still succeed.
      await expect(adapter.connect(other).applyKlerosRuling(orderId))
        .to.emit(adapter, "KlerosRulingApplied");
    });
  });

  describe("emergencyResolveDispute (owner fallback)", function () {
    it("only owner can call", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      await advanceCooldown(ctx);

      await expect(
        ctx.adapter.connect(ctx.other).emergencyResolveDispute(orderId, true)
      ).to.be.revertedWithCustomError(ctx.adapter, "OwnableUnauthorizedAccount");
    });

    it("works after cooldown, regardless of any Kleros activity", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { owner, adapter, marketplace, vault, buyer, amount } = ctx;

      // Note: no escalation, no Kleros — owner intervenes directly.
      await advanceCooldown(ctx);

      await expect(adapter.connect(owner).emergencyResolveDispute(orderId, true))
        .to.emit(adapter, "EmergencyResolved")
        .withArgs(orderId, true);

      const order = await marketplace.getOrder(orderId);
      expect(order.status).to.equal(OrderStatus.Refunded);
      expect(await vault.pendingWithdrawal(buyer.address)).to.equal(amount);
    });
  });

  describe("owner setters", function () {
    it("setArbitratorExtraData by owner emits event + updates state", async function () {
      const { owner, adapter } = await deploy();
      const newData = "0x1234";
      await expect(adapter.connect(owner).setArbitratorExtraData(newData))
        .to.emit(adapter, "ArbitratorExtraDataUpdated")
        .withArgs("0x", newData);
      expect(await adapter.arbitratorExtraData()).to.equal(newData);
    });

    it("setArbitratorExtraData by non-owner reverts", async function () {
      const { other, adapter } = await deploy();
      await expect(
        adapter.connect(other).setArbitratorExtraData("0x1234")
      ).to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount");
    });

    it("setTemplateId by owner emits event", async function () {
      const { owner, adapter } = await deploy();
      await expect(adapter.connect(owner).setTemplateId(42n))
        .to.emit(adapter, "TemplateIdUpdated")
        .withArgs(1n, 42n);
      expect(await adapter.templateId()).to.equal(42n);
    });

    it("setTemplateRegistryURI by owner emits event", async function () {
      const { owner, adapter } = await deploy();
      const newURI = "ipfs://template";
      await expect(adapter.connect(owner).setTemplateRegistryURI(newURI))
        .to.emit(adapter, "TemplateRegistryURIUpdated")
        .withArgs(newURI);
      expect(await adapter.templateRegistryURI()).to.equal(newURI);
    });
  });

  describe("H1: disputeID=0 collision fix", function () {
    it("orderEscalated is false before escalation and true after", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, adapter, arbitrator } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");

      expect(await adapter.orderEscalated(orderId)).to.equal(false);
      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee });
      expect(await adapter.orderEscalated(orderId)).to.equal(true);
    });

    it("AlreadyEscalated fires even when Kleros assigns disputeID=0", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, seller, adapter, arbitrator } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");

      // Force Kleros mock to start from disputeID=0
      await arbitrator.setNextDisputeID(0n);
      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee });

      expect(await adapter.orderToDisputeID(orderId)).to.equal(0n);  // stored as 0
      expect(await adapter.orderEscalated(orderId)).to.equal(true);   // but flag is set

      // Second escalate must revert even though orderToDisputeID==0
      await expect(
        adapter.connect(seller).escalateToKleros(orderId, { value: fee })
      ).to.be.revertedWithCustomError(adapter, "AlreadyEscalated");
    });

    it("rule() with disputeID=0 resolves correctly", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { buyer, adapter, arbitrator, marketplace } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");

      await arbitrator.setNextDisputeID(0n);
      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee });

      expect(await adapter.disputeToOrderID(0n)).to.equal(orderId);

      await advanceCooldown(ctx);

      await expect(arbitrator.giveRuling(0n, 1n))
        .to.emit(adapter, "KlerosRulingApplied")
        .withArgs(orderId, 0n, 1n);

      const order = await marketplace.getOrder(orderId);
      expect(order.status).to.equal(OrderStatus.Refunded);
    });
  });

  describe("H2 + withdrawRefund", function () {
    it("withdrawRefund reverts NoRefundPending when nothing owed", async function () {
      const { other, adapter } = await deploy();
      await expect(
        adapter.connect(other).withdrawRefund()
      ).to.be.revertedWithCustomError(adapter, "NoRefundPending");
    });

    it("withdrawRefund clears pending balance and emits RefundWithdrawn", async function () {
      const ctx = await deploy();
      const orderId = await setupDisputedOrder(ctx);
      const { ethers, buyer, adapter, arbitrator } = ctx;
      const fee = await arbitrator.arbitrationCost("0x");
      const excess = ethers.parseEther("0.3");
      await adapter.connect(buyer).escalateToKleros(orderId, { value: fee + excess });

      await expect(adapter.connect(buyer).withdrawRefund())
        .to.emit(adapter, "RefundWithdrawn")
        .withArgs(buyer.address, excess);

      expect(await adapter.pendingRefunds(buyer.address)).to.equal(0n);
    });
  });

  describe("L1: withdrawBalance", function () {
    it("only owner can call withdrawBalance", async function () {
      const { other, adapter } = await deploy();
      await expect(
        adapter.connect(other).withdrawBalance(other.address)
      ).to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount");
    });

    it("owner can drain stranded ETH from adapter", async function () {
      const { ethers, owner, adapter } = await deploy();
      const adapterAddr = await adapter.getAddress();

      // Send ETH directly to adapter (simulates accidental transfer)
      await owner.sendTransaction({ to: adapterAddr, value: ethers.parseEther("0.1") });
      expect(await ethers.provider.getBalance(adapterAddr)).to.equal(ethers.parseEther("0.1"));

      const balBefore = await ethers.provider.getBalance(owner.address);
      const tx = await adapter.connect(owner).withdrawBalance(owner.address);
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice;
      const balAfter = await ethers.provider.getBalance(owner.address);

      expect(balAfter - balBefore + gas).to.equal(ethers.parseEther("0.1"));
      expect(await ethers.provider.getBalance(adapterAddr)).to.equal(0n);
    });

    it("withdrawBalance reverts when balance is zero", async function () {
      const { owner, adapter } = await deploy();
      await expect(
        adapter.connect(owner).withdrawBalance(owner.address)
      ).to.be.revertedWith("No balance");
    });
  });

  describe("receive()", function () {
    it("accepts plain ETH transfer", async function () {
      const { ethers, owner, adapter } = await deploy();
      const adapterAddress = await adapter.getAddress();
      const balBefore = await ethers.provider.getBalance(adapterAddress);

      await owner.sendTransaction({ to: adapterAddress, value: ethers.parseEther("0.05") });

      const balAfter = await ethers.provider.getBalance(adapterAddress);
      expect(balAfter - balBefore).to.equal(ethers.parseEther("0.05"));
    });
  });

  describe("executeOnMarketplace (pass-through)", function () {
    it("only owner can call", async function () {
      const ctx = await deploy();
      const { adapter, other, marketplace } = ctx;
      const data = marketplace.interface.encodeFunctionData("pause");
      await expect(adapter.connect(other).executeOnMarketplace(data))
        .to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount");
    });

    it("owner can pause marketplace through adapter after ownership transfer", async function () {
      const ctx = await deploy();
      const { ethers, owner, adapter, marketplace } = ctx;

      // Sanity: marketplace owner is now adapter
      expect(await marketplace.owner()).to.equal(await adapter.getAddress());
      expect(await marketplace.paused()).to.equal(false);

      const pauseData = marketplace.interface.encodeFunctionData("pause");
      await adapter.connect(owner).executeOnMarketplace(pauseData);

      expect(await marketplace.paused()).to.equal(true);

      const unpauseData = marketplace.interface.encodeFunctionData("unpause");
      await adapter.connect(owner).executeOnMarketplace(unpauseData);

      expect(await marketplace.paused()).to.equal(false);
    });

    it("owner can update Chainlink config through adapter (setSubscriptionId)", async function () {
      const ctx = await deploy();
      const { owner, adapter, marketplace } = ctx;

      const data = marketplace.interface.encodeFunctionData("setSubscriptionId", [42n]);
      await adapter.connect(owner).executeOnMarketplace(data);

      expect(await marketplace.subscriptionId()).to.equal(42n);
    });

    it("bubbles up marketplace revert reason", async function () {
      const ctx = await deploy();
      const { owner, adapter, marketplace } = ctx;

      // setCallbackGasLimit reverts on zero
      const data = marketplace.interface.encodeFunctionData("setCallbackGasLimit", [0]);
      await expect(adapter.connect(owner).executeOnMarketplace(data)).to.be.revertedWith(
        "Callback gas limit cannot be zero"
      );
    });

    it("emits MarketplaceCallExecuted with selector", async function () {
      const ctx = await deploy();
      const { owner, adapter, marketplace } = ctx;

      const data = marketplace.interface.encodeFunctionData("setSubscriptionId", [99n]);
      const selector = data.slice(0, 10); // 0x + 4 bytes
      await expect(adapter.connect(owner).executeOnMarketplace(data))
        .to.emit(adapter, "MarketplaceCallExecuted")
        .withArgs(selector, 0n);
    });
  });
});
