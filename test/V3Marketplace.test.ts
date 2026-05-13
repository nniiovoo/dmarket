import { expect } from "chai";
import { network } from "hardhat";

describe("V3 Marketplace (delivery oracle)", function () {
  const AUTO_CONFIRM_DELAY = 10 * 24 * 60 * 60;

  enum OrderStatus {
    Created,
    Paid,
    Shipped,
    Completed,
    Cancelled,
    Disputed,
    Refunded
  }

  async function deployVaultOnly() {
    const { ethers } = await network.create();
    const [owner, marketplace, other] = await ethers.getSigners();

    const vault = await ethers.deployContract("EscrowVaultV3", [owner.address], owner);

    return { ethers, owner, marketplace, other, vault };
  }

  async function deploy() {
    const { ethers } = await network.create();
    const [owner, buyer, seller, other] = await ethers.getSigners();

    const vault = await ethers.deployContract("EscrowVaultV3", [owner.address], owner);
    const router = await ethers.deployContract("FunctionsRouterMock", [], owner);
    const marketplace = await ethers.deployContract("EscrowMarketplaceV3", [await vault.getAddress(), await router.getAddress()], owner);
    await vault.connect(owner).setMarketplace(await marketplace.getAddress());

    const amount = ethers.parseEther("1");
    const productId = 42n;

    return { ethers, owner, buyer, seller, other, router, vault, marketplace, amount, productId };
  }

  describe("EscrowVaultV3", function () {
    it("owner can bind one marketplace exactly once", async function () {
      const { owner, marketplace, other, vault } = await deployVaultOnly();

      await expect(vault.connect(other).setMarketplace(marketplace.address)).to.be.revertedWith(
        "Only owner can call this function"
      );

      await expect(vault.connect(owner).setMarketplace(marketplace.address))
        .to.emit(vault, "MarketplaceUpdated")
        .withArgs("0x0000000000000000000000000000000000000000", marketplace.address);

      expect(await vault.marketplace()).to.equal(marketplace.address);

      await expect(vault.connect(owner).setMarketplace(other.address)).to.be.revertedWith("Marketplace already set");
    });
  });

  describe("core escrow flow", function () {
    it("supports createAndPay -> markShipped -> manual confirm with deliveredAt initially unset", async function () {
      const { ethers, buyer, seller, marketplace, vault, amount, productId } = await deploy();

      await expect(marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount }))
        .to.emit(marketplace, "OrderCreated")
        .withArgs(1n, buyer.address, seller.address, productId, amount)
        .and.to.emit(marketplace, "OrderPaid")
        .withArgs(1n, buyer.address, amount);

      let order = await marketplace.getOrder(1n);
      expect(order.status).to.equal(OrderStatus.Paid);
      expect(order.deliveredAt).to.equal(0n);
      expect(await vault.lockedAmount(1n)).to.equal(amount);
      expect(await ethers.provider.getBalance(await marketplace.getAddress())).to.equal(0n);

      await marketplace.connect(seller).markShipped(1n);
      order = await marketplace.getOrder(1n);
      expect(order.status).to.equal(OrderStatus.Shipped);
      expect(order.deliveredAt).to.equal(0n);

      const sellerBalanceBefore = await ethers.provider.getBalance(seller.address);
      await marketplace.connect(buyer).confirmReceived(1n);
      const sellerBalanceAfter = await ethers.provider.getBalance(seller.address);

      order = await marketplace.getOrder(1n);
      expect(order.status).to.equal(OrderStatus.Completed);
      expect(order.completedAt).to.be.greaterThan(0n);
      expect(order.deliveredAt).to.equal(0n);
      expect(await vault.lockedAmount(1n)).to.equal(0n);
      expect(sellerBalanceAfter - sellerBalanceBefore).to.equal(amount);
    });
  });

  describe("delivery requests", function () {
    async function shippedOrder() {
      const fixture = await deploy();
      const { buyer, seller, marketplace, amount, productId } = fixture;

      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      await marketplace.connect(seller).markShipped(1n);

      return { ...fixture, orderId: 1n };
    }

    async function recordDelivery(fixture: Awaited<ReturnType<typeof shippedOrder>>, deliveredAt: bigint) {
      const { ethers, other, marketplace, router, orderId } = fixture;
      const requestId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint256"],
          [await router.getAddress(), await marketplace.getAddress(), 1n]
        )
      );

      await marketplace.connect(other).requestDelivery(orderId);
      await router.fulfill(
        await marketplace.getAddress(),
        requestId,
        ethers.AbiCoder.defaultAbiCoder().encode(["bool", "uint64"], [true, deliveredAt]),
        "0x"
      );

      return requestId;
    }

    it("anyone can request delivery check for a shipped order", async function () {
      const { ethers, other, marketplace, router, orderId } = await shippedOrder();

      const expectedRequestId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint256"],
          [await router.getAddress(), await marketplace.getAddress(), 1n]
        )
      );

      await expect(marketplace.connect(other).requestDelivery(orderId))
        .to.emit(marketplace, "DeliveryRequested")
        .withArgs(orderId, expectedRequestId)
        .and.to.emit(router, "MockRequestSent");

      expect(await marketplace.deliveryRequestToOrderId(expectedRequestId)).to.equal(orderId);
    });

    it("cannot request delivery before the order is shipped", async function () {
      const { buyer, seller, marketplace, amount, productId } = await deploy();

      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });

      await expect(marketplace.requestDelivery(1n)).to.be.revertedWith("Order must be Shipped");
    });

    it("cannot request delivery again after deliveredAt is recorded", async function () {
      const fixture = await shippedOrder();
      const { marketplace, orderId } = fixture;

      await recordDelivery(fixture, 1_800_000_000n);

      await expect(marketplace.requestDelivery(orderId)).to.be.revertedWith("Delivery already recorded");
    });

    it("records deliveredAt when the oracle reports delivered=true", async function () {
      const { ethers, other, marketplace, router, orderId } = await shippedOrder();
      const requestId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint256"],
          [await router.getAddress(), await marketplace.getAddress(), 1n]
        )
      );
      const deliveredAt = 1_800_000_000n;

      await marketplace.connect(other).requestDelivery(orderId);

      await expect(
        router.fulfill(
          await marketplace.getAddress(),
          requestId,
          ethers.AbiCoder.defaultAbiCoder().encode(["bool", "uint64"], [true, deliveredAt]),
          "0x"
        )
      )
        .to.emit(marketplace, "DeliveryRecorded")
        .withArgs(orderId, deliveredAt);

      expect((await marketplace.getOrder(orderId)).deliveredAt).to.equal(deliveredAt);
    });

    it("does not record deliveredAt when the oracle reports delivered=false", async function () {
      const { ethers, other, marketplace, router, orderId } = await shippedOrder();
      const requestId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint256"],
          [await router.getAddress(), await marketplace.getAddress(), 1n]
        )
      );

      await marketplace.connect(other).requestDelivery(orderId);
      await router.fulfill(
        await marketplace.getAddress(),
        requestId,
        ethers.AbiCoder.defaultAbiCoder().encode(["bool", "uint64"], [false, 0n]),
        "0x"
      );

      expect((await marketplace.getOrder(orderId)).deliveredAt).to.equal(0n);
    });

    it("emits DeliveryQueryFailed when the oracle returns an error", async function () {
      const { ethers, other, marketplace, router, orderId } = await shippedOrder();
      const requestId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint256"],
          [await router.getAddress(), await marketplace.getAddress(), 1n]
        )
      );

      await marketplace.connect(other).requestDelivery(orderId);

      await expect(router.fulfill(await marketplace.getAddress(), requestId, "0x", ethers.toUtf8Bytes("17track timeout")))
        .to.emit(marketplace, "DeliveryQueryFailed")
        .withArgs(orderId, requestId, "17track timeout");

      expect((await marketplace.getOrder(orderId)).deliveredAt).to.equal(0n);
    });

    it("ignores a delivered callback when the order is no longer Shipped", async function () {
      const fixture = await shippedOrder();
      const { ethers, buyer, marketplace, router, orderId } = fixture;
      const requestId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint256"],
          [await router.getAddress(), await marketplace.getAddress(), 1n]
        )
      );

      await marketplace.requestDelivery(orderId);
      await marketplace.connect(buyer).confirmReceived(orderId);
      await router.fulfill(
        await marketplace.getAddress(),
        requestId,
        ethers.AbiCoder.defaultAbiCoder().encode(["bool", "uint64"], [true, 1_800_000_000n]),
        "0x"
      );

      const order = await marketplace.getOrder(orderId);
      expect(order.status).to.equal(OrderStatus.Completed);
      expect(order.deliveredAt).to.equal(0n);
    });
  });

  describe("auto confirmation", function () {
    async function shippedOrder() {
      const fixture = await deploy();
      const { buyer, seller, marketplace, amount, productId } = fixture;

      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      await marketplace.connect(seller).markShipped(1n);

      return { ...fixture, orderId: 1n };
    }

    async function recordDelivery(fixture: Awaited<ReturnType<typeof shippedOrder>>, deliveredAt: bigint) {
      const { ethers, other, marketplace, router, orderId } = fixture;
      const requestId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint256"],
          [await router.getAddress(), await marketplace.getAddress(), 1n]
        )
      );

      await marketplace.connect(other).requestDelivery(orderId);
      await router.fulfill(
        await marketplace.getAddress(),
        requestId,
        ethers.AbiCoder.defaultAbiCoder().encode(["bool", "uint64"], [true, deliveredAt]),
        "0x"
      );
    }

    it("does not auto-complete before deliveredAt + 10 days", async function () {
      const fixture = await shippedOrder();
      const { ethers, other, marketplace, orderId } = fixture;
      const block = await ethers.provider.getBlock("latest");
      const deliveredAt = BigInt(block?.timestamp ?? 0);

      await recordDelivery(fixture, deliveredAt);

      await expect(marketplace.connect(other).autoConfirmAfterDelivery(orderId)).to.be.revertedWith(
        "Auto-confirm delay has not passed"
      );
    });

    it("lets anyone auto-complete after deliveredAt + 10 days and releases funds to seller", async function () {
      const fixture = await shippedOrder();
      const { ethers, other, seller, marketplace, vault, amount, orderId } = fixture;
      const block = await ethers.provider.getBlock("latest");
      const deliveredAt = BigInt(block?.timestamp ?? 0);

      await recordDelivery(fixture, deliveredAt);
      await ethers.provider.send("evm_increaseTime", [AUTO_CONFIRM_DELAY + 1]);
      await ethers.provider.send("evm_mine", []);

      const sellerBalanceBefore = await ethers.provider.getBalance(seller.address);

      await expect(marketplace.connect(other).autoConfirmAfterDelivery(orderId))
        .to.emit(marketplace, "OrderAutoCompleted")
        .withArgs(orderId)
        .and.to.emit(marketplace, "OrderCompleted")
        .withArgs(orderId, seller.address, amount);

      const sellerBalanceAfter = await ethers.provider.getBalance(seller.address);
      const order = await marketplace.getOrder(orderId);

      expect(order.status).to.equal(OrderStatus.Completed);
      expect(order.completedAt).to.be.greaterThan(0n);
      expect(await vault.lockedAmount(orderId)).to.equal(0n);
      expect(sellerBalanceAfter - sellerBalanceBefore).to.equal(amount);
    });

    it("does not auto-complete after a dispute is opened", async function () {
      const fixture = await shippedOrder();
      const { ethers, buyer, other, marketplace, orderId } = fixture;
      const block = await ethers.provider.getBlock("latest");
      const deliveredAt = BigInt(block?.timestamp ?? 0);

      await recordDelivery(fixture, deliveredAt);
      await marketplace.connect(buyer).openDispute(orderId);
      await ethers.provider.send("evm_increaseTime", [AUTO_CONFIRM_DELAY + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(marketplace.connect(other).autoConfirmAfterDelivery(orderId)).to.be.revertedWith(
        "Order must be Shipped"
      );
    });

    it("still lets the buyer manually confirm after delivery is recorded", async function () {
      const fixture = await shippedOrder();
      const { ethers, buyer, seller, marketplace, vault, amount, orderId } = fixture;
      const block = await ethers.provider.getBlock("latest");
      const deliveredAt = BigInt(block?.timestamp ?? 0);

      await recordDelivery(fixture, deliveredAt);

      const sellerBalanceBefore = await ethers.provider.getBalance(seller.address);
      await marketplace.connect(buyer).confirmReceived(orderId);
      const sellerBalanceAfter = await ethers.provider.getBalance(seller.address);

      const order = await marketplace.getOrder(orderId);
      expect(order.status).to.equal(OrderStatus.Completed);
      expect(order.deliveredAt).to.equal(deliveredAt);
      expect(await vault.lockedAmount(orderId)).to.equal(0n);
      expect(sellerBalanceAfter - sellerBalanceBefore).to.equal(amount);
    });
  });

  describe("Chainlink Functions configuration", function () {
    it("owner can update subscription, DON, callback gas, source, and secrets reference", async function () {
      const { ethers, owner, marketplace } = await deploy();
      const donId = ethers.encodeBytes32String("fun-sepolia");
      const secretsReference = "0x123456";

      await marketplace.connect(owner).setSubscriptionId(123n);
      await marketplace.connect(owner).setDonId(donId);
      await marketplace.connect(owner).setCallbackGasLimit(250_000);
      await marketplace.connect(owner).setRequestSource("return Functions.encodeUint256(1);");
      await marketplace.connect(owner).setEncryptedSecretsReference(secretsReference);

      expect(await marketplace.subscriptionId()).to.equal(123n);
      expect(await marketplace.donID()).to.equal(donId);
      expect(await marketplace.callbackGasLimit()).to.equal(250_000);
      expect(await marketplace.requestSource()).to.equal("return Functions.encodeUint256(1);");
      expect(await marketplace.encryptedSecretsReference()).to.equal(secretsReference);
    });
  });
});
