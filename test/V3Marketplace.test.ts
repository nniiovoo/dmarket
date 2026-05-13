import { expect } from "chai";
import { network } from "hardhat";
import { readFileSync } from "node:fs";

describe("V3 Marketplace (delivery oracle)", function () {
  const AUTO_CONFIRM_DELAY = 10 * 24 * 60 * 60;
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
    const marketplace = await ethers.deployContract(
      "EscrowMarketplaceV3",
      [await vault.getAddress(), await router.getAddress(), PLACEHOLDER_SOURCE],
      owner
    );
    await vault.connect(owner).setMarketplace(await marketplace.getAddress());

    const amount = ethers.parseEther("1");
    const productId = 42n;

    return { ethers, owner, buyer, seller, other, router, vault, marketplace, amount, productId };
  }

  async function withdrawToSelfAndExpectBalanceIncrease(fixture: any, account: any, amount: bigint) {
    const { ethers, vault } = fixture;
    const balanceBefore = await ethers.provider.getBalance(account.address);
    const tx = await vault.connect(account).withdraw(account.address);
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed * receipt!.gasPrice;
    const balanceAfter = await ethers.provider.getBalance(account.address);

    expect(balanceAfter - balanceBefore + gas).to.equal(amount);
  }

  describe("EscrowMarketplaceV3 constructor", function () {
    it("rejects zero vault address", async function () {
      const { ethers } = await network.create();
      const [deployer] = await ethers.getSigners();
      const router = await ethers.deployContract("FunctionsRouterMock", [], deployer);

      await expect(
        ethers.deployContract(
          "EscrowMarketplaceV3",
          [ethers.ZeroAddress, await router.getAddress(), PLACEHOLDER_SOURCE],
          deployer
        )
      ).to.be.revertedWith("Vault cannot be zero address");
    });

    it("rejects zero router address", async function () {
      const { ethers } = await network.create();
      const [deployer] = await ethers.getSigners();
      const vault = await ethers.deployContract("EscrowVaultV3", [deployer.address], deployer);

      await expect(
        ethers.deployContract(
          "EscrowMarketplaceV3",
          [await vault.getAddress(), ethers.ZeroAddress, PLACEHOLDER_SOURCE],
          deployer
        )
      ).to.be.revertedWith("Router cannot be zero address");
    });
  });

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

      await marketplace.connect(buyer).confirmReceived(1n);

      order = await marketplace.getOrder(1n);
      expect(order.status).to.equal(OrderStatus.Completed);
      expect(order.completedAt).to.be.greaterThan(0n);
      expect(order.deliveredAt).to.equal(0n);
      expect(await vault.lockedAmount(1n)).to.equal(0n);
      expect(await vault.pendingWithdrawal(seller.address)).to.equal(amount);
      await withdrawToSelfAndExpectBalanceIncrease({ ethers, vault }, seller, amount);
      expect(await vault.pendingWithdrawal(seller.address)).to.equal(0n);
    });
  });

  describe("v2 dispute parity (regression)", function () {
    it("owner can resolve a dispute by refunding the buyer", async function () {
      const { ethers, buyer, seller, owner, marketplace, vault, amount, productId } = await deploy();

      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      await marketplace.connect(seller).markShipped(1n);
      await marketplace.connect(buyer).openDispute(1n);

      await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(marketplace.connect(owner).resolveDispute(1n, true))
        .to.emit(marketplace, "DisputeResolved")
        .withArgs(1n, true)
        .and.to.emit(marketplace, "OrderRefunded")
        .withArgs(1n, buyer.address, amount);

      const order = await marketplace.getOrder(1n);

      expect(order.status).to.equal(OrderStatus.Refunded);
      expect(await vault.lockedAmount(1n)).to.equal(0n);
      expect(await vault.pendingWithdrawal(buyer.address)).to.equal(amount);
      await withdrawToSelfAndExpectBalanceIncrease({ ethers, vault }, buyer, amount);
      expect(await vault.pendingWithdrawal(buyer.address)).to.equal(0n);
    });

    it("owner can resolve a dispute by completing the order (release to seller)", async function () {
      const { ethers, buyer, seller, owner, marketplace, vault, amount, productId } = await deploy();

      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      await marketplace.connect(seller).markShipped(1n);
      await marketplace.connect(buyer).openDispute(1n);

      await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(marketplace.connect(owner).resolveDispute(1n, false))
        .to.emit(marketplace, "DisputeResolved")
        .withArgs(1n, false)
        .and.to.emit(marketplace, "OrderCompleted")
        .withArgs(1n, seller.address, amount);

      const order = await marketplace.getOrder(1n);

      expect(order.status).to.equal(OrderStatus.Completed);
      expect(await vault.lockedAmount(1n)).to.equal(0n);
      expect(await vault.pendingWithdrawal(seller.address)).to.equal(amount);
      await withdrawToSelfAndExpectBalanceIncrease({ ethers, vault }, seller, amount);
      expect(await vault.pendingWithdrawal(seller.address)).to.equal(0n);
    });

    it("owner can emergency-refund a paid order to the buyer", async function () {
      const { ethers, buyer, seller, owner, marketplace, vault, amount, productId } = await deploy();

      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });

      await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(marketplace.connect(owner).ownerEmergencyRefund(1n))
        .to.emit(marketplace, "OrderEmergencyRefunded")
        .withArgs(1n, buyer.address, amount);

      const order = await marketplace.getOrder(1n);

      expect(order.status).to.equal(OrderStatus.Refunded);
      expect(await vault.lockedAmount(1n)).to.equal(0n);
      expect(await vault.pendingWithdrawal(buyer.address)).to.equal(amount);
      await withdrawToSelfAndExpectBalanceIncrease({ ethers, vault }, buyer, amount);
      expect(await vault.pendingWithdrawal(buyer.address)).to.equal(0n);
    });

    it("buyer can cancel before payment, and a paid order cannot be cancelled", async function () {
      const { buyer, seller, marketplace, amount, productId } = await deploy();

      await marketplace.connect(buyer).createOrder(seller.address, productId, amount);
      await marketplace.connect(buyer).cancelOrder(1n);

      let order = await marketplace.getOrder(1n);
      expect(order.status).to.equal(OrderStatus.Cancelled);

      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      await expect(marketplace.connect(buyer).cancelOrder(2n)).to.be.revertedWith("Only Created orders can be cancelled");
    });
  });

  describe("dispute & emergency refund time windows", function () {
    const PAID_DELAY = 30 * 24 * 60 * 60;
    const SHIPPED_DELAY = 60 * 24 * 60 * 60;
    const DISPUTE_DELAY = 3 * 24 * 60 * 60;

    it("openDispute 写入 disputedAt", async function () {
      const { ethers, buyer, seller, marketplace, amount, productId } = await deploy();
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      const orderId = 1n;
      await marketplace.connect(seller).markShipped(orderId);

      const tx = await marketplace.connect(buyer).openDispute(orderId);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      const order = await marketplace.getOrder(orderId);
      expect(order.disputedAt).to.equal(BigInt(block!.timestamp));
    });

    it("resolveDispute 在 3 天内 revert", async function () {
      const { owner, buyer, seller, marketplace, amount, productId } = await deploy();
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      const orderId = 1n;
      await marketplace.connect(seller).markShipped(orderId);
      await marketplace.connect(buyer).openDispute(orderId);

      await expect(
        marketplace.connect(owner).resolveDispute(orderId, true)
      ).to.be.revertedWith("Dispute resolution delay has not elapsed");
    });

    it("resolveDispute 3 天后成功", async function () {
      const { ethers, owner, buyer, seller, marketplace, vault, amount, productId } = await deploy();
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      const orderId = 1n;
      await marketplace.connect(seller).markShipped(orderId);
      await marketplace.connect(buyer).openDispute(orderId);

      await ethers.provider.send("evm_increaseTime", [DISPUTE_DELAY + 1]);
      await ethers.provider.send("evm_mine", []);

      await marketplace.connect(owner).resolveDispute(orderId, true);
      expect(await vault.pendingWithdrawal(buyer.address)).to.equal(amount);
    });

    it("ownerEmergencyRefund 在 Paid 状态 30 天内 revert", async function () {
      const { owner, buyer, seller, marketplace, amount, productId } = await deploy();
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      const orderId = 1n;

      await expect(
        marketplace.connect(owner).ownerEmergencyRefund(orderId)
      ).to.be.revertedWith("Order not stale enough for emergency refund");
    });

    it("ownerEmergencyRefund 在 Paid 状态 30 天后成功", async function () {
      const { ethers, owner, buyer, seller, marketplace, vault, amount, productId } = await deploy();
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      const orderId = 1n;

      await ethers.provider.send("evm_increaseTime", [PAID_DELAY + 1]);
      await ethers.provider.send("evm_mine", []);

      await marketplace.connect(owner).ownerEmergencyRefund(orderId);
      expect(await vault.pendingWithdrawal(buyer.address)).to.equal(amount);
    });

    it("ownerEmergencyRefund 在 Shipped 状态 60 天内 revert", async function () {
      const { ethers, owner, buyer, seller, marketplace, amount, productId } = await deploy();
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      const orderId = 1n;
      await marketplace.connect(seller).markShipped(orderId);

      // 30 天虽然过了 paid delay 但订单已经 Shipped，应走 shipped delay
      await ethers.provider.send("evm_increaseTime", [PAID_DELAY + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        marketplace.connect(owner).ownerEmergencyRefund(orderId)
      ).to.be.revertedWith("Order not stale enough for emergency refund");
    });

    it("ownerEmergencyRefund 在 Shipped 状态 60 天后成功", async function () {
      const { ethers, owner, buyer, seller, marketplace, vault, amount, productId } = await deploy();
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      const orderId = 1n;
      await marketplace.connect(seller).markShipped(orderId);

      await ethers.provider.send("evm_increaseTime", [SHIPPED_DELAY + 1]);
      await ethers.provider.send("evm_mine", []);

      await marketplace.connect(owner).ownerEmergencyRefund(orderId);
      expect(await vault.pendingWithdrawal(buyer.address)).to.equal(amount);
    });

    it("ownerEmergencyRefund 在 Disputed 状态 revert（必须走 resolveDispute）", async function () {
      const { ethers, owner, buyer, seller, marketplace, amount, productId } = await deploy();
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      const orderId = 1n;
      await marketplace.connect(seller).markShipped(orderId);
      await marketplace.connect(buyer).openDispute(orderId);

      // 即使过了所有时间窗也不能 emergency refund Disputed 状态
      await ethers.provider.send("evm_increaseTime", [SHIPPED_DELAY + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        marketplace.connect(owner).ownerEmergencyRefund(orderId)
      ).to.be.revertedWith("Order must be Paid or Shipped");
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
      const order = await marketplace.getOrder(orderId);

      await recordDelivery(fixture, order.shippedAt);

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
      const orderBefore = await marketplace.getOrder(orderId);
      const deliveredAt = orderBefore.shippedAt;

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

    it("fulfillRequest 对未知 requestId 不写状态、不 emit", async function () {
      const { ethers, buyer, seller, router, marketplace, amount, productId } = await deploy();
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      const orderId = 1n;
      await marketplace.connect(seller).markShipped(orderId);

      const unknownRequestId = ethers.id("never-issued");
      const response = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bool", "uint64"],
        [true, Math.floor(Date.now() / 1000)]
      );

      const tx = await router.connect(seller).fulfill(
        await marketplace.getAddress(),
        unknownRequestId,
        response,
        "0x"
      );
      const receipt = await tx.wait();

      const deliveryLogs = receipt?.logs
        .map((log: any) => {
          try {
            return marketplace.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .filter((log: any) => log?.name === "DeliveryRecorded" || log?.name === "DeliveryQueryFailed");

      expect(deliveryLogs).to.deep.equal([]);
      expect((await marketplace.orders(0)).deliveredAt).to.equal(0n);
      expect((await marketplace.orders(orderId)).deliveredAt).to.equal(0n);
    });

    it("fulfillRequest 拒绝早于 shippedAt 的时间戳", async function () {
      const { ethers, buyer, seller, router, marketplace, amount, productId } = await deploy();
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      const orderId = 1n;
      await marketplace.connect(seller).markShipped(orderId);

      const requestId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint256"],
          [await router.getAddress(), await marketplace.getAddress(), 1n]
        )
      );
      await marketplace.connect(buyer).requestDelivery(orderId);

      const order = await marketplace.getOrder(orderId);
      const badTs = order.shippedAt - 1n;
      const response = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bool", "uint64"],
        [true, badTs]
      );

      await expect(
        router.connect(seller).fulfill(
          await marketplace.getAddress(),
          requestId,
          response,
          "0x"
        )
      )
        .to.emit(marketplace, "DeliveryQueryFailed")
        .withArgs(orderId, requestId, "Invalid delivered timestamp");

      expect((await marketplace.getOrder(orderId)).deliveredAt).to.equal(0n);
      expect(await marketplace.deliveryRequestToOrderId(requestId)).to.equal(0n);
    });

    it("fulfillRequest 拒绝晚于 block.timestamp 的时间戳", async function () {
      const { ethers, buyer, seller, router, marketplace, amount, productId } = await deploy();
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      const orderId = 1n;
      await marketplace.connect(seller).markShipped(orderId);

      const requestId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint256"],
          [await router.getAddress(), await marketplace.getAddress(), 1n]
        )
      );
      await marketplace.connect(buyer).requestDelivery(orderId);

      const block = await ethers.provider.getBlock("latest");
      const futureTs = BigInt(block?.timestamp ?? 0) + 365n * 24n * 3600n;
      const response = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bool", "uint64"],
        [true, futureTs]
      );

      await expect(
        router.connect(seller).fulfill(
          await marketplace.getAddress(),
          requestId,
          response,
          "0x"
        )
      )
        .to.emit(marketplace, "DeliveryQueryFailed")
        .withArgs(orderId, requestId, "Invalid delivered timestamp");

      expect((await marketplace.getOrder(orderId)).deliveredAt).to.equal(0n);
      expect(await marketplace.deliveryRequestToOrderId(requestId)).to.equal(0n);
    });

    it("第二次 requestDelivery 在冷却时间内被拒绝", async function () {
      const { buyer, seller, marketplace, amount, productId } = await deploy();
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      const orderId = 1n;
      await marketplace.connect(seller).markShipped(orderId);

      await marketplace.connect(buyer).requestDelivery(orderId);
      await expect(
        marketplace.connect(buyer).requestDelivery(orderId)
      ).to.be.revertedWith("Delivery request cooldown");
    });

    it("冷却时间过后可再次 requestDelivery", async function () {
      const { ethers, buyer, seller, marketplace, amount, productId } = await deploy();
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      const orderId = 1n;
      await marketplace.connect(seller).markShipped(orderId);

      await marketplace.connect(buyer).requestDelivery(orderId);
      await ethers.provider.send("evm_increaseTime", [60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await marketplace.connect(buyer).requestDelivery(orderId);
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

    it("does not auto-complete when delivery was never recorded", async function () {
      const { ethers, other, marketplace, orderId } = await shippedOrder();

      await ethers.provider.send("evm_increaseTime", [AUTO_CONFIRM_DELAY + 100 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine", []);

      await expect(marketplace.connect(other).autoConfirmAfterDelivery(orderId)).to.be.revertedWith(
        "Delivery not recorded"
      );
    });

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

      await expect(marketplace.connect(other).autoConfirmAfterDelivery(orderId))
        .to.emit(marketplace, "OrderAutoCompleted")
        .withArgs(orderId)
        .and.to.emit(marketplace, "OrderCompleted")
        .withArgs(orderId, seller.address, amount);

      const order = await marketplace.getOrder(orderId);

      expect(order.status).to.equal(OrderStatus.Completed);
      expect(order.completedAt).to.be.greaterThan(0n);
      expect(await vault.lockedAmount(orderId)).to.equal(0n);
      expect(await vault.pendingWithdrawal(seller.address)).to.equal(amount);
      await withdrawToSelfAndExpectBalanceIncrease(fixture, seller, amount);
      expect(await vault.pendingWithdrawal(seller.address)).to.equal(0n);
    });

    it("cannot auto-complete twice (status must remain Shipped)", async function () {
      const fixture = await shippedOrder();
      const { ethers, other, marketplace, orderId } = fixture;
      const block = await ethers.provider.getBlock("latest");
      const deliveredAt = BigInt(block?.timestamp ?? 0);

      await recordDelivery(fixture, deliveredAt);
      await ethers.provider.send("evm_increaseTime", [AUTO_CONFIRM_DELAY + 1]);
      await ethers.provider.send("evm_mine", []);

      await marketplace.connect(other).autoConfirmAfterDelivery(orderId);

      await expect(marketplace.connect(other).autoConfirmAfterDelivery(orderId)).to.be.revertedWith(
        "Order must be Shipped"
      );
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

      await marketplace.connect(buyer).confirmReceived(orderId);

      const order = await marketplace.getOrder(orderId);
      expect(order.status).to.equal(OrderStatus.Completed);
      expect(order.deliveredAt).to.equal(deliveredAt);
      expect(await vault.lockedAmount(orderId)).to.equal(0n);
      expect(await vault.pendingWithdrawal(seller.address)).to.equal(amount);
      await withdrawToSelfAndExpectBalanceIncrease(fixture, seller, amount);
      expect(await vault.pendingWithdrawal(seller.address)).to.equal(0n);
    });
  });

  describe("Chainlink Functions configuration", function () {
    it("non-owner cannot update any Chainlink configuration", async function () {
      const { ethers, other, marketplace } = await deploy();
      const donId = ethers.encodeBytes32String("fun-sepolia");

      await expect(marketplace.connect(other).setSubscriptionId(123n)).to.be.revertedWithCustomError(
        marketplace,
        "OwnableUnauthorizedAccount"
      );
      await expect(marketplace.connect(other).setDonId(donId)).to.be.revertedWithCustomError(
        marketplace,
        "OwnableUnauthorizedAccount"
      );
      await expect(marketplace.connect(other).setCallbackGasLimit(250_000)).to.be.revertedWithCustomError(
        marketplace,
        "OwnableUnauthorizedAccount"
      );
      await expect(marketplace.connect(other).setEncryptedSecretsReference("0xdead")).to.be.revertedWithCustomError(
        marketplace,
        "OwnableUnauthorizedAccount"
      );
    });

    it("owner can update subscription, DON, callback gas, and secrets reference", async function () {
      const { ethers, owner, marketplace } = await deploy();
      const donId = ethers.encodeBytes32String("fun-sepolia");
      const secretsReference = "0x123456";

      await marketplace.connect(owner).setSubscriptionId(123n);
      await marketplace.connect(owner).setDonId(donId);
      await marketplace.connect(owner).setCallbackGasLimit(250_000);
      await marketplace.connect(owner).setEncryptedSecretsReference(secretsReference);

      expect(await marketplace.subscriptionId()).to.equal(123n);
      expect(await marketplace.donID()).to.equal(donId);
      expect(await marketplace.callbackGasLimit()).to.equal(250_000);
      expect(await marketplace.encryptedSecretsReference()).to.equal(secretsReference);
    });

    it("setSubscriptionId emits SubscriptionIdUpdated", async function () {
      const { owner, marketplace } = await deploy();
      await expect(marketplace.connect(owner).setSubscriptionId(42n))
        .to.emit(marketplace, "SubscriptionIdUpdated")
        .withArgs(0n, 42n);

      await expect(marketplace.connect(owner).setSubscriptionId(43n))
        .to.emit(marketplace, "SubscriptionIdUpdated")
        .withArgs(42n, 43n);
    });

    it("setDonId emits DonIdUpdated", async function () {
      const { ethers, owner, marketplace } = await deploy();
      const newDonId = ethers.id("fun-test-donid").slice(0, 66);
      await expect(marketplace.connect(owner).setDonId(newDonId))
        .to.emit(marketplace, "DonIdUpdated")
        .withArgs(ethers.ZeroHash, newDonId);
    });

    it("setCallbackGasLimit emits CallbackGasLimitUpdated", async function () {
      const { owner, marketplace } = await deploy();
      await expect(marketplace.connect(owner).setCallbackGasLimit(500_000))
        .to.emit(marketplace, "CallbackGasLimitUpdated")
        .withArgs(300_000, 500_000);
    });

    it("setEncryptedSecretsReference emits EncryptedSecretsReferenceUpdated", async function () {
      const { ethers, owner, marketplace } = await deploy();
      const ref = "0x1234567890abcdef";
      const refBytes = ethers.getBytes(ref);
      const expectedHash = ethers.keccak256(ref);

      await expect(marketplace.connect(owner).setEncryptedSecretsReference(ref))
        .to.emit(marketplace, "EncryptedSecretsReferenceUpdated")
        .withArgs(expectedHash, refBytes.length);
    });

    it("非 owner 调 setter 一律 revert（保留原有访问控制）", async function () {
      const { ethers, other, marketplace } = await deploy();
      await expect(marketplace.connect(other).setSubscriptionId(1n)).to.be.revertedWithCustomError(
        marketplace,
        "OwnableUnauthorizedAccount"
      );
      await expect(marketplace.connect(other).setDonId(ethers.ZeroHash)).to.be.revertedWithCustomError(
        marketplace,
        "OwnableUnauthorizedAccount"
      );
      await expect(marketplace.connect(other).setCallbackGasLimit(123)).to.be.revertedWithCustomError(
        marketplace,
        "OwnableUnauthorizedAccount"
      );
      await expect(marketplace.connect(other).setEncryptedSecretsReference("0x")).to.be.revertedWithCustomError(
        marketplace,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("requestSource commit-reveal", function () {
    it("proposeRequestSource 写入 pendingRequestSource 并 emit 事件", async function () {
      const { ethers, owner, marketplace } = await deploy();
      const newSource = "return Functions.encodeString('v2');";
      const hash = ethers.keccak256(ethers.toUtf8Bytes(newSource));

      const tx = await marketplace.connect(owner).proposeRequestSource(newSource);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);
      const expectedReadyAt = BigInt(block!.timestamp) + 7n * 24n * 3600n;

      await expect(tx)
        .to.emit(marketplace, "RequestSourceProposed")
        .withArgs(hash, newSource.length, expectedReadyAt);

      const pending = await marketplace.pendingRequestSource();
      expect(pending.sourceHash).to.equal(hash);
      expect(pending.readyAt).to.equal(expectedReadyAt);
    });

    it("不能在已有 pending proposal 时再 propose", async function () {
      const { owner, marketplace } = await deploy();
      await marketplace.connect(owner).proposeRequestSource("a");
      await expect(marketplace.connect(owner).proposeRequestSource("b")).to.be.revertedWith(
        "Existing proposal must be cancelled first"
      );
    });

    it("commitRequestSource 在延迟未到时 revert", async function () {
      const { owner, marketplace } = await deploy();
      const newSource = "return Functions.encodeString('v2');";
      await marketplace.connect(owner).proposeRequestSource(newSource);
      await expect(marketplace.connect(owner).commitRequestSource(newSource)).to.be.revertedWith(
        "Proposal delay has not elapsed"
      );
    });

    it("commitRequestSource source 和 proposal 不匹配时 revert", async function () {
      const { ethers, owner, marketplace } = await deploy();
      await marketplace.connect(owner).proposeRequestSource("original");
      await ethers.provider.send("evm_increaseTime", [7 * 24 * 3600 + 1]);
      await ethers.provider.send("evm_mine", []);
      await expect(marketplace.connect(owner).commitRequestSource("different")).to.be.revertedWith(
        "Source does not match pending proposal"
      );
    });

    it("commitRequestSource 在延迟过后成功更新 source 并清空 pending", async function () {
      const { ethers, owner, marketplace } = await deploy();
      const newSource = "return Functions.encodeString('v2');";
      const hash = ethers.keccak256(ethers.toUtf8Bytes(newSource));

      await marketplace.connect(owner).proposeRequestSource(newSource);
      await ethers.provider.send("evm_increaseTime", [7 * 24 * 3600 + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(marketplace.connect(owner).commitRequestSource(newSource))
        .to.emit(marketplace, "RequestSourceUpdated")
        .withArgs(hash, newSource.length);

      expect(await marketplace.requestSource()).to.equal(newSource);

      const pending = await marketplace.pendingRequestSource();
      expect(pending.sourceHash).to.equal(ethers.ZeroHash);
      expect(pending.readyAt).to.equal(0n);
    });

    it("cancelPendingRequestSource 清空 proposal 并 emit 事件", async function () {
      const { ethers, owner, marketplace } = await deploy();
      const newSource = "return Functions.encodeString('v2');";
      const hash = ethers.keccak256(ethers.toUtf8Bytes(newSource));

      await marketplace.connect(owner).proposeRequestSource(newSource);
      await expect(marketplace.connect(owner).cancelPendingRequestSource())
        .to.emit(marketplace, "RequestSourceProposalCancelled")
        .withArgs(hash);

      await marketplace.connect(owner).proposeRequestSource("new");
    });

    it("cancelPendingRequestSource 无 pending 时 revert", async function () {
      const { owner, marketplace } = await deploy();
      await expect(marketplace.connect(owner).cancelPendingRequestSource()).to.be.revertedWith(
        "No pending proposal"
      );
    });

    it("非 owner 不能 propose / commit / cancel", async function () {
      const { owner, other, marketplace } = await deploy();
      await marketplace.connect(owner).proposeRequestSource("x");

      await expect(marketplace.connect(other).proposeRequestSource("y")).to.be.revertedWithCustomError(
        marketplace,
        "OwnableUnauthorizedAccount"
      );
      await expect(marketplace.connect(other).commitRequestSource("x")).to.be.revertedWithCustomError(
        marketplace,
        "OwnableUnauthorizedAccount"
      );
      await expect(marketplace.connect(other).cancelPendingRequestSource()).to.be.revertedWithCustomError(
        marketplace,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("pausable", function () {
    it("non-owner cannot pause / unpause", async function () {
      const { other, marketplace } = await deploy();
      await expect(marketplace.connect(other).pause()).to.be.revertedWithCustomError(
        marketplace,
        "OwnableUnauthorizedAccount"
      );
      await expect(marketplace.connect(other).unpause()).to.be.revertedWithCustomError(
        marketplace,
        "OwnableUnauthorizedAccount"
      );
    });

    it("paused state blocks forward-flow entrypoints", async function () {
      const { owner, buyer, seller, marketplace, amount, productId } = await deploy();
      await marketplace.connect(owner).pause();
      expect(await marketplace.paused()).to.equal(true);

      await expect(
        marketplace.connect(buyer).createOrder(seller.address, productId, amount)
      ).to.be.revertedWithCustomError(marketplace, "EnforcedPause");

      await expect(
        marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount })
      ).to.be.revertedWithCustomError(marketplace, "EnforcedPause");
    });

    it("paused state blocks payOrder / markShipped / confirmReceived / openDispute", async function () {
      const { owner, buyer, seller, marketplace, amount, productId } = await deploy();

      await marketplace.connect(buyer).createOrder(seller.address, productId, amount);
      await marketplace.connect(owner).pause();

      await expect(
        marketplace.connect(buyer).payOrder(1n, { value: amount })
      ).to.be.revertedWithCustomError(marketplace, "EnforcedPause");

      await marketplace.connect(owner).unpause();
      await marketplace.connect(buyer).payOrder(1n, { value: amount });
      await marketplace.connect(owner).pause();

      await expect(marketplace.connect(seller).markShipped(1n)).to.be.revertedWithCustomError(
        marketplace,
        "EnforcedPause"
      );

      await marketplace.connect(owner).unpause();
      await marketplace.connect(seller).markShipped(1n);
      await marketplace.connect(owner).pause();

      await expect(marketplace.connect(buyer).confirmReceived(1n)).to.be.revertedWithCustomError(
        marketplace,
        "EnforcedPause"
      );
      await expect(marketplace.connect(buyer).openDispute(1n)).to.be.revertedWithCustomError(
        marketplace,
        "EnforcedPause"
      );
    });

    it("paused state blocks requestDelivery and autoConfirmAfterDelivery", async function () {
      const { ethers, owner, buyer, seller, marketplace, amount, productId } = await deploy();

      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      await marketplace.connect(seller).markShipped(1n);
      await marketplace.connect(owner).pause();

      await expect(marketplace.connect(buyer).requestDelivery(1n)).to.be.revertedWithCustomError(
        marketplace,
        "EnforcedPause"
      );
      await expect(marketplace.connect(buyer).autoConfirmAfterDelivery(1n)).to.be.revertedWithCustomError(
        marketplace,
        "EnforcedPause"
      );
    });

    it("escape hatches still work while paused: cancelOrder / resolveDispute / ownerEmergencyRefund", async function () {
      const { ethers, owner, buyer, seller, marketplace, vault, amount, productId } = await deploy();

      // cancelOrder while paused
      await marketplace.connect(buyer).createOrder(seller.address, productId, amount);
      await marketplace.connect(owner).pause();
      await expect(marketplace.connect(buyer).cancelOrder(1n))
        .to.emit(marketplace, "OrderCancelled")
        .withArgs(1n);
      await marketplace.connect(owner).unpause();

      // ownerEmergencyRefund while paused
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      await marketplace.connect(owner).pause();
      await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await marketplace.connect(owner).ownerEmergencyRefund(2n);
      expect(await vault.pendingWithdrawal(buyer.address)).to.equal(amount);
      await marketplace.connect(owner).unpause();

      // resolveDispute while paused
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      await marketplace.connect(seller).markShipped(3n);
      await marketplace.connect(buyer).openDispute(3n);
      await marketplace.connect(owner).pause();
      await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await marketplace.connect(owner).resolveDispute(3n, true);
      expect(await vault.pendingWithdrawal(buyer.address)).to.equal(amount * 2n);

      expect(await vault.lockedAmount(1n)).to.equal(0n);
      expect(await vault.lockedAmount(2n)).to.equal(0n);
      expect(await vault.lockedAmount(3n)).to.equal(0n);
    });

    it("unpause restores normal operation", async function () {
      const { owner, buyer, seller, marketplace, amount, productId } = await deploy();
      await marketplace.connect(owner).pause();
      await expect(
        marketplace.connect(buyer).createOrder(seller.address, productId, amount)
      ).to.be.revertedWithCustomError(marketplace, "EnforcedPause");
      await marketplace.connect(owner).unpause();
      expect(await marketplace.paused()).to.equal(false);

      await marketplace.connect(buyer).createOrder(seller.address, productId, amount);
      const order = await marketplace.getOrder(1n);
      expect(order.status).to.equal(OrderStatus.Created);
    });
  });

  describe("pull payment", function () {
    it("releaseTo 累加 pendingWithdrawal 而不是直接转账", async function () {
      const { ethers, buyer, seller, marketplace, vault, amount, productId } = await deploy();
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      const orderId = 1n;
      await marketplace.connect(seller).markShipped(orderId);

      const sellerBalanceBefore = await ethers.provider.getBalance(seller.address);
      await marketplace.connect(buyer).confirmReceived(orderId);

      expect(await vault.pendingWithdrawal(seller.address)).to.equal(amount);
      expect(await ethers.provider.getBalance(seller.address)).to.equal(sellerBalanceBefore);
    });

    it("withdraw 可以转到不同地址（修复恶意 receive() 卡死）", async function () {
      const { ethers, buyer, seller, other, marketplace, vault, amount, productId } = await deploy();
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      const orderId = 1n;
      await marketplace.connect(seller).markShipped(orderId);
      await marketplace.connect(buyer).confirmReceived(orderId);

      const otherBalanceBefore = await ethers.provider.getBalance(other.address);
      await vault.connect(seller).withdraw(other.address);

      expect(await ethers.provider.getBalance(other.address)).to.equal(otherBalanceBefore + amount);
      expect(await vault.pendingWithdrawal(seller.address)).to.equal(0n);
    });

    it("同一卖家的多次 release 累加到同一个 pending 余额", async function () {
      const { buyer, seller, marketplace, vault, amount, productId } = await deploy();

      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      await marketplace.connect(buyer).createAndPay(seller.address, productId + 1n, { value: amount });
      await marketplace.connect(seller).markShipped(1n);
      await marketplace.connect(seller).markShipped(2n);
      await marketplace.connect(buyer).confirmReceived(1n);
      await marketplace.connect(buyer).confirmReceived(2n);

      expect(await vault.pendingWithdrawal(seller.address)).to.equal(amount * 2n);

      await vault.connect(seller).withdraw(seller.address);
      expect(await vault.pendingWithdrawal(seller.address)).to.equal(0n);
    });

    it("withdraw 零余额账户 revert", async function () {
      const { other, vault } = await deploy();
      await expect(vault.connect(other).withdraw(other.address)).to.be.revertedWith("Nothing to withdraw");
    });

    it("recipient receive() revert 不再卡死 releaseTo，资金记入 pendingWithdrawal", async function () {
      const { ethers, buyer, owner, marketplace, vault, amount, productId } = await deploy();
      const maliciousRecipient = await ethers.deployContract(
        "MaliciousBuyerRejectsEth",
        [await marketplace.getAddress()],
        owner
      );
      const maliciousRecipientAddress = await maliciousRecipient.getAddress();

      await marketplace.connect(buyer).createAndPay(maliciousRecipientAddress, productId, { value: amount });
      await marketplace.connect(buyer).openDispute(1n);

      await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(marketplace.connect(owner).resolveDispute(1n, false))
        .to.emit(marketplace, "OrderCompleted")
        .withArgs(1n, maliciousRecipientAddress, amount);

      expect(await vault.pendingWithdrawal(maliciousRecipientAddress)).to.equal(amount);
      expect(await vault.lockedAmount(1n)).to.equal(0n);
    });
  });

  describe("vault self-recorded parties (H5)", function () {
    it("lockFunds 写入 partiesByOrder", async function () {
      const { buyer, seller, marketplace, vault, amount, productId } = await deploy();
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      const orderId = 1n;

      const parties = await vault.partiesByOrder(orderId);
      expect(parties.buyer).to.equal(buyer.address);
      expect(parties.seller).to.equal(seller.address);
    });

    it("releaseToBuyer 用 vault 自己存的 buyer，不接受任意地址", async function () {
      const { ethers, owner, buyer, seller, marketplace, vault, amount, productId } = await deploy();
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      const orderId = 1n;
      await marketplace.connect(seller).markShipped(orderId);
      await marketplace.connect(buyer).openDispute(orderId);
      await ethers.provider.send("evm_increaseTime", [3 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      await marketplace.connect(owner).resolveDispute(orderId, true);

      expect(await vault.pendingWithdrawal(buyer.address)).to.equal(amount);
      expect(await vault.pendingWithdrawal(seller.address)).to.equal(0n);
    });

    it("releaseToSeller 用 vault 自己存的 seller", async function () {
      const { buyer, seller, marketplace, vault, amount, productId } = await deploy();
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      const orderId = 1n;
      await marketplace.connect(seller).markShipped(orderId);
      await marketplace.connect(buyer).confirmReceived(orderId);

      expect(await vault.pendingWithdrawal(seller.address)).to.equal(amount);
      expect(await vault.pendingWithdrawal(buyer.address)).to.equal(0n);
    });

    it("releaseToBuyer / releaseToSeller 只能 marketplace 调", async function () {
      const { other, buyer, seller, marketplace, vault, amount, productId } = await deploy();
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      const orderId = 1n;

      await expect(vault.connect(other).releaseToBuyer(orderId)).to.be.revertedWith(
        "Only marketplace can call this function"
      );
      await expect(vault.connect(other).releaseToSeller(orderId)).to.be.revertedWith(
        "Only marketplace can call this function"
      );
    });

    it("lockFunds 拒绝 buyer == seller", async function () {
      // Stand up a bare vault with a signer EOA as the marketplace so we can
      // call lockFunds directly with crafted parties; the real marketplace
      // already rejects "seller == msg.sender" upstream, this is the
      // defense-in-depth check that the vault itself also refuses.
      const { ethers, owner, marketplace: fakeMarketplace, other: alice, vault } = await deployVaultOnly();
      await vault.connect(owner).setMarketplace(fakeMarketplace.address);

      await expect(
        vault.connect(fakeMarketplace).lockFunds(1n, alice.address, alice.address, {
          value: ethers.parseEther("1")
        })
      ).to.be.revertedWith("Buyer and seller must differ");
    });
  });

  describe("reentrancy", function () {
    it("malicious seller cannot double-release via reentry in confirmReceived", async function () {
      const { ethers, buyer, marketplace, vault, amount, productId } = await deploy();
      const maliciousSeller = await ethers.deployContract(
        "MaliciousSeller",
        [await marketplace.getAddress()]
      );
      const maliciousSellerAddress = await maliciousSeller.getAddress();

      await marketplace.connect(buyer).createOrder(maliciousSellerAddress, productId, amount);
      await maliciousSeller.setOrderId(1n);
      await marketplace.connect(buyer).payOrder(1n, { value: amount });
      await maliciousSeller.markShipped();
      await maliciousSeller.enableAttack();

      await marketplace.connect(buyer).confirmReceived(1n);

      const order = await marketplace.getOrder(1n);
      expect(order.status).to.equal(OrderStatus.Completed);
      expect(await vault.pendingWithdrawal(maliciousSellerAddress)).to.equal(amount);
      expect(await maliciousSeller.reentryAttempts()).to.equal(0n);
      expect(await vault.lockedAmount(1n)).to.equal(0n);
      expect(await ethers.provider.getBalance(await marketplace.getAddress())).to.equal(0n);
    });

    it("createAndPay still works normally with nonReentrant guard", async function () {
      const { buyer, seller, marketplace, vault, amount, productId } = await deploy();
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      const order = await marketplace.getOrder(1n);
      expect(order.status).to.equal(OrderStatus.Paid);
      expect(await vault.lockedAmount(1n)).to.equal(amount);
    });
  });

  describe("ownership hardening (Ownable2Step + timelock)", function () {
    it("transferOwnership 后必须 acceptOwnership 才生效", async function () {
      const { ethers, owner, other, marketplace } = await deploy();
      await marketplace.connect(owner).transferOwnership(other.address);

      expect(await marketplace.owner()).to.equal(owner.address);
      expect(await marketplace.pendingOwner()).to.equal(other.address);

      await expect(marketplace.connect(owner).acceptOwnership()).to.be.revertedWithCustomError(
        marketplace,
        "OwnableUnauthorizedAccount"
      );
      await marketplace.connect(other).acceptOwnership();

      expect(await marketplace.owner()).to.equal(other.address);
      expect(await marketplace.pendingOwner()).to.equal(ethers.ZeroAddress);
    });

    it("旧 owner 在 acceptOwnership 之前依然有完整权限", async function () {
      const { owner, other, marketplace } = await deploy();
      await marketplace.connect(owner).transferOwnership(other.address);

      await expect(marketplace.connect(owner).setSubscriptionId(7n))
        .to.emit(marketplace, "SubscriptionIdUpdated")
        .withArgs(0n, 7n);
      await expect(marketplace.connect(other).setSubscriptionId(8n)).to.be.revertedWithCustomError(
        marketplace,
        "OwnableUnauthorizedAccount"
      );
    });

    it("transferOwnership 到 zero address 不会切走当前 owner", async function () {
      const { ethers, owner, marketplace } = await deploy();
      await marketplace.connect(owner).transferOwnership(ethers.ZeroAddress);

      expect(await marketplace.owner()).to.equal(owner.address);
      expect(await marketplace.pendingOwner()).to.equal(ethers.ZeroAddress);
    });

    it("timelock 合约接管 ownership 后可正常调 onlyOwner 函数", async function () {
      const { ethers, owner, marketplace } = await deploy();
      const [, , , , multisig] = await ethers.getSigners();

      const timelockArtifact = JSON.parse(
        readFileSync("node_modules/@openzeppelin/contracts/build/contracts/TimelockController.json", "utf8")
      );
      const Timelock = new ethers.ContractFactory(
        timelockArtifact.abi,
        timelockArtifact.bytecode,
        owner
      );
      const minDelay = 1;
      const timelock = await Timelock.deploy(
        minDelay,
        [multisig.address],
        [multisig.address],
        ethers.ZeroAddress
      );
      await timelock.waitForDeployment();

      await marketplace.connect(owner).transferOwnership(await timelock.getAddress());

      const data = marketplace.interface.encodeFunctionData("acceptOwnership");
      const target = await marketplace.getAddress();
      const salt = ethers.id("accept-ownership-1");

      await timelock.connect(multisig).schedule(target, 0, data, ethers.ZeroHash, salt, minDelay);
      await ethers.provider.send("evm_increaseTime", [minDelay + 1]);
      await ethers.provider.send("evm_mine", []);
      await timelock.connect(multisig).execute(target, 0, data, ethers.ZeroHash, salt);

      expect(await marketplace.owner()).to.equal(await timelock.getAddress());

      await expect(marketplace.connect(owner).setSubscriptionId(99n)).to.be.revertedWithCustomError(
        marketplace,
        "OwnableUnauthorizedAccount"
      );

      const setData = marketplace.interface.encodeFunctionData("setSubscriptionId", [99n]);
      const setSalt = ethers.id("set-sub-1");
      await timelock.connect(multisig).schedule(target, 0, setData, ethers.ZeroHash, setSalt, minDelay);
      await ethers.provider.send("evm_increaseTime", [minDelay + 1]);
      await ethers.provider.send("evm_mine", []);
      await expect(timelock.connect(multisig).execute(target, 0, setData, ethers.ZeroHash, setSalt))
        .to.emit(marketplace, "SubscriptionIdUpdated")
        .withArgs(0n, 99n);
    });
  });

  describe("evidence registry hook", function () {
    it("evidenceRegistry 默认是 address(0)", async function () {
      const { ethers, marketplace } = await deploy();
      expect(await marketplace.evidenceRegistry()).to.equal(ethers.ZeroAddress);
    });

    it("setEvidenceRegistry by owner emit 事件 + 写入 state", async function () {
      const { ethers, owner, router, marketplace } = await deploy();

      const registry = await ethers.deployContract(
        "EvidenceRegistryV3",
        [await marketplace.getAddress(), await router.getAddress(), PLACEHOLDER_SOURCE],
        owner
      );
      const registryAddr = await registry.getAddress();

      await expect(marketplace.connect(owner).setEvidenceRegistry(registryAddr))
        .to.emit(marketplace, "EvidenceRegistryUpdated")
        .withArgs(ethers.ZeroAddress, registryAddr);

      expect(await marketplace.evidenceRegistry()).to.equal(registryAddr);
    });

    it("setEvidenceRegistry 可以设回 address(0) 解除关联", async function () {
      const { ethers, owner, router, marketplace } = await deploy();
      const registry = await ethers.deployContract(
        "EvidenceRegistryV3",
        [await marketplace.getAddress(), await router.getAddress(), PLACEHOLDER_SOURCE],
        owner
      );
      const registryAddr = await registry.getAddress();
      await marketplace.connect(owner).setEvidenceRegistry(registryAddr);

      await expect(marketplace.connect(owner).setEvidenceRegistry(ethers.ZeroAddress))
        .to.emit(marketplace, "EvidenceRegistryUpdated")
        .withArgs(registryAddr, ethers.ZeroAddress);

      expect(await marketplace.evidenceRegistry()).to.equal(ethers.ZeroAddress);
    });

    it("setEvidenceRegistry 指向错误 marketplace 的 registry 应 revert", async function () {
      const { ethers, owner, marketplace } = await deploy();

      const vault2 = await ethers.deployContract("EscrowVaultV3", [owner.address], owner);
      const router2 = await ethers.deployContract("FunctionsRouterMock", [], owner);
      const marketplace2 = await ethers.deployContract(
        "EscrowMarketplaceV3",
        [await vault2.getAddress(), await router2.getAddress(), PLACEHOLDER_SOURCE],
        owner
      );
      const wrongRegistry = await ethers.deployContract(
        "EvidenceRegistryV3",
        [await marketplace2.getAddress(), await router2.getAddress(), PLACEHOLDER_SOURCE],
        owner
      );

      await expect(
        marketplace.connect(owner).setEvidenceRegistry(await wrongRegistry.getAddress())
      ).to.be.revertedWith("Registry marketplace mismatch");
    });

    it("非 owner 不能 setEvidenceRegistry", async function () {
      const { ethers, other, marketplace } = await deploy();
      await expect(
        marketplace.connect(other).setEvidenceRegistry(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(marketplace, "OwnableUnauthorizedAccount");
    });

    it("resolveDispute / ownerEmergencyRefund 行为不受 evidenceRegistry 设置影响", async function () {
      const { ethers, owner, buyer, seller, router, marketplace, vault, amount, productId } = await deploy();
      const registry = await ethers.deployContract(
        "EvidenceRegistryV3",
        [await marketplace.getAddress(), await router.getAddress(), PLACEHOLDER_SOURCE],
        owner
      );
      await marketplace.connect(owner).setEvidenceRegistry(await registry.getAddress());

      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      const orderId = 1n;
      await marketplace.connect(seller).markShipped(orderId);
      await marketplace.connect(buyer).openDispute(orderId);

      await ethers.provider.send("evm_increaseTime", [3 * 24 * 3600 + 1]);
      await ethers.provider.send("evm_mine", []);

      await marketplace.connect(owner).resolveDispute(orderId, true);
      expect(await vault.pendingWithdrawal(buyer.address)).to.equal(amount);
    });
  });
});
