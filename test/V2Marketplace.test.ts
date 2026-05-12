import { expect } from "chai";
import { network } from "hardhat";

// Tests for the v2 architecture: a marketplace contract + a separate EscrowVault.
// The vault is the only contract that holds ETH; the marketplace owns all order
// logic. Wiring step (vault.setMarketplace) is exercised in the fixtures below.
describe("V2 Marketplace (marketplace + vault)", function () {
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

    const vault = await ethers.deployContract("EscrowVault", [], owner);
    const marketplace = await ethers.deployContract("EscrowMarketplaceV2", [await vault.getAddress()], owner);
    await vault.connect(owner).setMarketplace(await marketplace.getAddress());

    const amount = ethers.parseEther("1");
    const productId = 42n;

    return { ethers, owner, buyer, seller, other, vault, marketplace, amount, productId };
  }

  async function createdOrder() {
    const fixture = await deploy();
    const { buyer, seller, marketplace, amount, productId } = fixture;

    await marketplace.connect(buyer).createOrder(seller.address, productId, amount);

    return { ...fixture, orderId: 1n };
  }

  async function paidOrder() {
    const fixture = await createdOrder();
    const { buyer, marketplace, amount, orderId } = fixture;

    await marketplace.connect(buyer).payOrder(orderId, { value: amount });

    return fixture;
  }

  async function shippedOrder() {
    const fixture = await paidOrder();
    const { seller, marketplace, orderId } = fixture;

    await marketplace.connect(seller).markShipped(orderId);

    return fixture;
  }

  async function disputedOrder() {
    const fixture = await paidOrder();
    const { buyer, marketplace, orderId } = fixture;

    await marketplace.connect(buyer).openDispute(orderId);

    return fixture;
  }

  async function checkInvariants(fixture: any, orderIds: bigint[]) {
    const { ethers, marketplace, vault } = fixture;
    const marketplaceAddress = await marketplace.getAddress();
    const vaultAddress = await vault.getAddress();
    const nextOrderId = await marketplace.nextOrderId();
    let totalLocked = 0n;

    for (const orderId of orderIds) {
      expect(orderId).to.be.lessThan(nextOrderId);

      const order = await marketplace.getOrder(orderId);
      const status = Number(order.status);
      const locked = await vault.lockedAmount(orderId);

      totalLocked += locked;

      if (
        status === OrderStatus.Paid ||
        status === OrderStatus.Shipped ||
        status === OrderStatus.Disputed
      ) {
        expect(locked).to.equal(order.amount);
      } else {
        expect(locked).to.equal(0n);
      }
    }

    expect(await ethers.provider.getBalance(marketplaceAddress)).to.equal(0n);
    expect(await ethers.provider.getBalance(vaultAddress)).to.equal(totalLocked);
  }

  // -------- happy paths --------

  it("完整流程：Created -> Paid -> Shipped -> Completed", async function () {
    const { ethers, buyer, seller, marketplace, vault, amount, productId } = await deploy();

    await expect(marketplace.connect(buyer).createOrder(seller.address, productId, amount))
      .to.emit(marketplace, "OrderCreated")
      .withArgs(1n, buyer.address, seller.address, productId, amount);

    expect((await marketplace.getOrder(1n)).status).to.equal(OrderStatus.Created);

    await expect(marketplace.connect(buyer).payOrder(1n, { value: amount }))
      .to.emit(marketplace, "OrderPaid")
      .withArgs(1n, buyer.address, amount);

    expect((await marketplace.getOrder(1n)).status).to.equal(OrderStatus.Paid);
    expect(await vault.lockedAmount(1n)).to.equal(amount);
    expect(await ethers.provider.getBalance(await marketplace.getAddress())).to.equal(0n);
    expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(amount);

    await marketplace.connect(seller).markShipped(1n);

    const sellerBalanceBefore = await ethers.provider.getBalance(seller.address);
    await marketplace.connect(buyer).confirmReceived(1n);
    const sellerBalanceAfter = await ethers.provider.getBalance(seller.address);

    expect((await marketplace.getOrder(1n)).status).to.equal(OrderStatus.Completed);
    expect(await vault.lockedAmount(1n)).to.equal(0n);
    expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(0n);
    expect(sellerBalanceAfter - sellerBalanceBefore).to.equal(amount);

    await checkInvariants({ ethers, marketplace, vault }, [1n]);
  });

  it("dispute 退款给 buyer", async function () {
    const { ethers, owner, buyer, marketplace, vault, amount, orderId } = await disputedOrder();

    const buyerBalanceBefore = await ethers.provider.getBalance(buyer.address);

    await expect(marketplace.connect(owner).resolveDispute(orderId, true))
      .to.emit(marketplace, "OrderRefunded")
      .withArgs(orderId, buyer.address, amount);

    const buyerBalanceAfter = await ethers.provider.getBalance(buyer.address);
    expect((await marketplace.getOrder(orderId)).status).to.equal(OrderStatus.Refunded);
    expect(await vault.lockedAmount(orderId)).to.equal(0n);
    expect(buyerBalanceAfter - buyerBalanceBefore).to.equal(amount);

    await checkInvariants({ ethers, marketplace, vault }, [orderId]);
  });

  it("dispute 放款给 seller", async function () {
    const { ethers, owner, seller, marketplace, vault, amount, orderId } = await disputedOrder();

    const sellerBalanceBefore = await ethers.provider.getBalance(seller.address);
    await marketplace.connect(owner).resolveDispute(orderId, false);
    const sellerBalanceAfter = await ethers.provider.getBalance(seller.address);

    expect((await marketplace.getOrder(orderId)).status).to.equal(OrderStatus.Completed);
    expect(await vault.lockedAmount(orderId)).to.equal(0n);
    expect(sellerBalanceAfter - sellerBalanceBefore).to.equal(amount);

    await checkInvariants({ ethers, marketplace, vault }, [orderId]);
  });

  it("cancelOrder：Created 状态下 buyer 取消", async function () {
    const { ethers, buyer, marketplace, vault, orderId } = await createdOrder();

    await expect(marketplace.connect(buyer).cancelOrder(orderId))
      .to.emit(marketplace, "OrderCancelled")
      .withArgs(orderId);

    expect((await marketplace.getOrder(orderId)).status).to.equal(OrderStatus.Cancelled);

    await checkInvariants({ ethers, marketplace, vault }, [orderId]);
  });

  it("getBuyerOrders 和 getSellerOrders 返回 v2 订单列表", async function () {
    const { ethers, buyer, seller, marketplace, vault, amount, productId } = await deploy();

    await marketplace.connect(buyer).createOrder(seller.address, productId, amount);
    await marketplace.connect(buyer).createOrder(seller.address, productId + 1n, amount);

    expect(await marketplace.getBuyerOrders(buyer.address)).to.deep.equal([1n, 2n]);
    expect(await marketplace.getSellerOrders(seller.address)).to.deep.equal([1n, 2n]);

    await checkInvariants({ ethers, marketplace, vault }, [1n, 2n]);
  });

  it("ownerEmergencyRefund：Paid 状态下 owner 退款", async function () {
    const { ethers, owner, buyer, marketplace, vault, amount, orderId } = await paidOrder();

    const buyerBalanceBefore = await ethers.provider.getBalance(buyer.address);
    await expect(marketplace.connect(owner).ownerEmergencyRefund(orderId))
      .to.emit(marketplace, "OrderEmergencyRefunded")
      .withArgs(orderId, buyer.address, amount);
    const buyerBalanceAfter = await ethers.provider.getBalance(buyer.address);

    expect((await marketplace.getOrder(orderId)).status).to.equal(OrderStatus.Refunded);
    expect(await vault.lockedAmount(orderId)).to.equal(0n);
    expect(buyerBalanceAfter - buyerBalanceBefore).to.equal(amount);

    await checkInvariants({ ethers, marketplace, vault }, [orderId]);
  });

  // -------- access control --------

  it("非 buyer 不能 payOrder", async function () {
    const { ethers, other, marketplace, vault, amount, orderId } = await createdOrder();

    await expect(marketplace.connect(other).payOrder(orderId, { value: amount })).to.be.revertedWith(
      "Only buyer can pay this order"
    );

    await checkInvariants({ ethers, marketplace, vault }, [orderId]);
  });

  it("非 seller 不能 markShipped", async function () {
    const { ethers, other, marketplace, vault, orderId } = await paidOrder();

    await expect(marketplace.connect(other).markShipped(orderId)).to.be.revertedWith(
      "Only seller can mark shipped"
    );

    await checkInvariants({ ethers, marketplace, vault }, [orderId]);
  });

  it("非 buyer 不能 confirmReceived", async function () {
    const { ethers, other, marketplace, vault, orderId } = await shippedOrder();

    await expect(marketplace.connect(other).confirmReceived(orderId)).to.be.revertedWith(
      "Only buyer can confirm receipt"
    );

    await checkInvariants({ ethers, marketplace, vault }, [orderId]);
  });

  it("非 buyer 不能 cancelOrder", async function () {
    const { ethers, other, marketplace, vault, orderId } = await createdOrder();

    await expect(marketplace.connect(other).cancelOrder(orderId)).to.be.revertedWith(
      "Only buyer can cancel this order"
    );

    await checkInvariants({ ethers, marketplace, vault }, [orderId]);
  });

  it("非 buyer/seller 不能 openDispute", async function () {
    const { ethers, other, marketplace, vault, orderId } = await paidOrder();

    await expect(marketplace.connect(other).openDispute(orderId)).to.be.revertedWith(
      "Only buyer or seller can open dispute"
    );

    await checkInvariants({ ethers, marketplace, vault }, [orderId]);
  });

  it("非 owner 不能 resolveDispute", async function () {
    const { ethers, other, marketplace, vault, orderId } = await disputedOrder();

    await expect(marketplace.connect(other).resolveDispute(orderId, true)).to.be.revertedWith(
      "Only owner can call this function"
    );

    await checkInvariants({ ethers, marketplace, vault }, [orderId]);
  });

  it("非 owner 不能 ownerEmergencyRefund", async function () {
    const { ethers, other, marketplace, vault, orderId } = await paidOrder();

    await expect(marketplace.connect(other).ownerEmergencyRefund(orderId)).to.be.revertedWith(
      "Only owner can call this function"
    );

    await checkInvariants({ ethers, marketplace, vault }, [orderId]);
  });

  // -------- state transition guards --------

  it("不能在 Paid 状态再次 payOrder", async function () {
    const { ethers, buyer, marketplace, vault, amount, orderId } = await paidOrder();

    await expect(marketplace.connect(buyer).payOrder(orderId, { value: amount })).to.be.revertedWith(
      "Order must be Created"
    );

    await checkInvariants({ ethers, marketplace, vault }, [orderId]);
  });

  it("不能在 Created 状态 markShipped", async function () {
    const { ethers, seller, marketplace, vault, orderId } = await createdOrder();

    await expect(marketplace.connect(seller).markShipped(orderId)).to.be.revertedWith("Order must be Paid");

    await checkInvariants({ ethers, marketplace, vault }, [orderId]);
  });

  it("不能在 Paid 状态 confirmReceived", async function () {
    const { ethers, buyer, marketplace, vault, orderId } = await paidOrder();

    await expect(marketplace.connect(buyer).confirmReceived(orderId)).to.be.revertedWith("Order must be Shipped");

    await checkInvariants({ ethers, marketplace, vault }, [orderId]);
  });

  it("Paid 状态不能 cancelOrder", async function () {
    const { ethers, buyer, marketplace, vault, orderId } = await paidOrder();

    await expect(marketplace.connect(buyer).cancelOrder(orderId)).to.be.revertedWith(
      "Only Created orders can be cancelled"
    );

    await checkInvariants({ ethers, marketplace, vault }, [orderId]);
  });

  it("Created 状态不能 openDispute", async function () {
    const { ethers, buyer, marketplace, vault, orderId } = await createdOrder();

    await expect(marketplace.connect(buyer).openDispute(orderId)).to.be.revertedWith(
      "Order must be Paid or Shipped"
    );

    await checkInvariants({ ethers, marketplace, vault }, [orderId]);
  });

  it("Completed 状态不能 ownerEmergencyRefund", async function () {
    const { ethers, buyer, owner, marketplace, vault, orderId } = await shippedOrder();
    await marketplace.connect(buyer).confirmReceived(orderId);

    await expect(marketplace.connect(owner).ownerEmergencyRefund(orderId)).to.be.revertedWith(
      "Order must have escrowed funds"
    );

    await checkInvariants({ ethers, marketplace, vault }, [orderId]);
  });

  it("不存在的 orderId 被 orderExists 拦截", async function () {
    const { ethers, marketplace, vault, buyer } = await deploy();

    await expect(marketplace.connect(buyer).payOrder(999n, { value: 1n })).to.be.revertedWith("Order does not exist");

    await checkInvariants({ ethers, marketplace, vault }, []);
  });

  // -------- vault isolation --------

  it("vault 拒绝非 marketplace 调 lockFunds", async function () {
    const { ethers, other, marketplace, vault } = await deploy();

    await expect(vault.connect(other).lockFunds(1n, { value: ethers.parseEther("1") })).to.be.revertedWith(
      "Only marketplace can call this function"
    );

    await checkInvariants({ ethers, marketplace, vault }, []);
  });

  it("vault 拒绝非 marketplace 调 releaseTo", async function () {
    const { ethers, other, buyer, marketplace, vault } = await deploy();

    await expect(vault.connect(other).releaseTo(1n, buyer.address)).to.be.revertedWith(
      "Only marketplace can call this function"
    );

    await checkInvariants({ ethers, marketplace, vault }, []);
  });

  it("vault 拒绝直接转 ETH", async function () {
    const { ethers, owner, marketplace, vault } = await deploy();

    await expect(
      owner.sendTransaction({ to: await vault.getAddress(), value: ethers.parseEther("1") })
    ).to.be.revertedWith("Direct ETH transfers are not allowed");

    await checkInvariants({ ethers, marketplace, vault }, []);
  });

  it("marketplace 拒绝直接转 ETH", async function () {
    const { ethers, owner, marketplace, vault } = await deploy();

    await expect(
      owner.sendTransaction({ to: await marketplace.getAddress(), value: ethers.parseEther("1") })
    ).to.be.revertedWith("Direct ETH transfers are not allowed");

    await checkInvariants({ ethers, marketplace, vault }, []);
  });

  it("vault 没设置 marketplace 时 payOrder 会失败", async function () {
    const { ethers } = await network.create();
    const [owner, buyer, seller] = await ethers.getSigners();
    const amount = ethers.parseEther("1");

    const vault = await ethers.deployContract("EscrowVault", [], owner);
    const marketplace = await ethers.deployContract("EscrowMarketplaceV2", [await vault.getAddress()], owner);
    // 故意不调 vault.setMarketplace

    await marketplace.connect(buyer).createOrder(seller.address, 42n, amount);

    await expect(marketplace.connect(buyer).payOrder(1n, { value: amount })).to.be.revertedWith(
      "Only marketplace can call this function"
    );

    await checkInvariants({ ethers, marketplace, vault }, [1n]);
  });

  it("vault 不能为同一 orderId 重复 lockFunds", async function () {
    // 直接通过 marketplace 不可能复现（因为 status 检查），但 vault 自己也得拒绝
    const { ethers, owner, buyer, marketplace, vault, amount } = await paidOrder();

    // 假设有恶意 marketplace（这里把 vault 的 marketplace 临时换成 owner 自己来测试 vault 的内部保护）
    await vault.connect(owner).setMarketplace(owner.address);
    await expect(vault.connect(owner).lockFunds(1n, { value: amount })).to.be.revertedWith(
      "Funds already locked for this order"
    );

    // 还原
    await vault.connect(owner).setMarketplace(await marketplace.getAddress());
    expect(buyer.address).to.not.equal(ethers.ZeroAddress); // dummy assert to silence linter

    await checkInvariants({ ethers, marketplace, vault }, [1n]);
  });

  // -------- emergency refund 状态全覆盖 --------

  it("ownerEmergencyRefund 在 Shipped 也可以", async function () {
    const { ethers, owner, marketplace, vault, orderId } = await shippedOrder();

    await marketplace.connect(owner).ownerEmergencyRefund(orderId);

    expect((await marketplace.getOrder(orderId)).status).to.equal(OrderStatus.Refunded);
    expect(await vault.lockedAmount(orderId)).to.equal(0n);

    await checkInvariants({ ethers, marketplace, vault }, [orderId]);
  });

  it("ownerEmergencyRefund 在 Disputed 也可以", async function () {
    const { ethers, owner, marketplace, vault, orderId } = await disputedOrder();

    await expect(marketplace.connect(owner).ownerEmergencyRefund(orderId)).to.emit(
      marketplace,
      "OrderEmergencyRefunded"
    );

    expect((await marketplace.getOrder(orderId)).status).to.equal(OrderStatus.Refunded);
    expect(await vault.lockedAmount(orderId)).to.equal(0n);

    await checkInvariants({ ethers, marketplace, vault }, [orderId]);
  });

  it("ownerEmergencyRefund 不发出 OrderRefunded 事件", async function () {
    const { ethers, owner, marketplace, vault, orderId } = await paidOrder();

    await expect(marketplace.connect(owner).ownerEmergencyRefund(orderId)).to.not.emit(marketplace, "OrderRefunded");

    await checkInvariants({ ethers, marketplace, vault }, [orderId]);
  });

  // -------- 资金不变性 --------

  it("marketplace 永远不持有 ETH", async function () {
    const { ethers, buyer, seller, owner, marketplace, vault, amount, productId } = await deploy();
    const mpAddress = await marketplace.getAddress();

    expect(await ethers.provider.getBalance(mpAddress)).to.equal(0n);

    await marketplace.connect(buyer).createOrder(seller.address, productId, amount);
    await marketplace.connect(buyer).payOrder(1n, { value: amount });
    expect(await ethers.provider.getBalance(mpAddress)).to.equal(0n);
    expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(amount);

    await marketplace.connect(seller).markShipped(1n);
    expect(await ethers.provider.getBalance(mpAddress)).to.equal(0n);

    await marketplace.connect(buyer).confirmReceived(1n);
    expect(await ethers.provider.getBalance(mpAddress)).to.equal(0n);
    expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(0n);

    expect(owner.address).to.not.equal(ethers.ZeroAddress); // silence unused

    await checkInvariants({ ethers, marketplace, vault }, [1n]);
  });

  describe("createAndPay (one-click)", function () {
    it("一步创建并支付订单", async function () {
      const { ethers, buyer, seller, marketplace, vault, amount, productId } = await deploy();

      const tx = await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      await expect(tx).to.emit(marketplace, "OrderCreated").withArgs(1n, buyer.address, seller.address, productId, amount);
      await expect(tx).to.emit(marketplace, "OrderPaid").withArgs(1n, buyer.address, amount);

      const receipt = await tx.wait();
      const eventNames = receipt?.logs
        .map((log) => {
          try {
            return marketplace.interface.parseLog(log)?.name;
          } catch {
            return undefined;
          }
        })
        .filter(Boolean);

      expect(eventNames.indexOf("OrderCreated")).to.be.lessThan(eventNames.indexOf("OrderPaid"));
      expect((await marketplace.getOrder(1n)).status).to.equal(OrderStatus.Paid);
      expect(await vault.lockedAmount(1n)).to.equal(amount);
      expect(await ethers.provider.getBalance(await marketplace.getAddress())).to.equal(0n);

      await checkInvariants({ ethers, marketplace, vault }, [1n]);
    });

    it("msg.value === 0 拒绝", async function () {
      const { buyer, seller, marketplace, productId } = await deploy();

      await expect(marketplace.connect(buyer).createAndPay(seller.address, productId, { value: 0n })).to.be.revertedWith(
        "Amount must be greater than zero"
      );
    });

    it("seller 不能等于 buyer", async function () {
      const { buyer, marketplace, amount, productId } = await deploy();

      await expect(marketplace.connect(buyer).createAndPay(buyer.address, productId, { value: amount })).to.be.revertedWith(
        "Seller cannot be buyer"
      );
    });

    it("seller 不能是 zero address", async function () {
      const { ethers, buyer, marketplace, amount, productId } = await deploy();

      await expect(marketplace.connect(buyer).createAndPay(ethers.ZeroAddress, productId, { value: amount })).to.be.revertedWith(
        "Seller cannot be zero address"
      );
    });

    it("createAndPay 后状态查询正确", async function () {
      const { buyer, seller, marketplace, amount, productId } = await deploy();

      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      const order = await marketplace.getOrder(1n);

      expect(order.buyer).to.equal(buyer.address);
      expect(order.seller).to.equal(seller.address);
      expect(order.amount).to.equal(amount);
      expect(order.productId).to.equal(productId);
      expect(order.status).to.equal(OrderStatus.Paid);
      expect(order.createdAt).to.be.greaterThan(0n);
      expect(order.paidAt).to.be.greaterThan(0n);
    });

    it("createAndPay 后可以正常 markShipped -> confirmReceived", async function () {
      const { ethers, buyer, seller, marketplace, vault, amount, productId } = await deploy();

      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      await marketplace.connect(seller).markShipped(1n);
      await marketplace.connect(buyer).confirmReceived(1n);

      expect((await marketplace.getOrder(1n)).status).to.equal(OrderStatus.Completed);
      expect(await vault.lockedAmount(1n)).to.equal(0n);

      await checkInvariants({ ethers, marketplace, vault }, [1n]);
    });

    it("createAndPay 后不能 cancelOrder（已经 Paid）", async function () {
      const { ethers, buyer, seller, marketplace, vault, amount, productId } = await deploy();

      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });

      await expect(marketplace.connect(buyer).cancelOrder(1n)).to.be.revertedWith(
        "Only Created orders can be cancelled"
      );

      await checkInvariants({ ethers, marketplace, vault }, [1n]);
    });

    it("createAndPay 后可以 openDispute（状态是 Paid）", async function () {
      const { ethers, buyer, seller, marketplace, vault, amount, productId } = await deploy();

      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      await marketplace.connect(buyer).openDispute(1n);

      expect((await marketplace.getOrder(1n)).status).to.equal(OrderStatus.Disputed);

      await checkInvariants({ ethers, marketplace, vault }, [1n]);
    });

    it("getBuyerOrders / getSellerOrders 含 createAndPay 创建的订单", async function () {
      const { ethers, buyer, seller, marketplace, vault, amount, productId } = await deploy();

      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      await marketplace.connect(buyer).createAndPay(seller.address, productId + 1n, { value: amount });

      expect(await marketplace.getBuyerOrders(buyer.address)).to.deep.equal([1n, 2n]);
      expect(await marketplace.getSellerOrders(seller.address)).to.deep.equal([1n, 2n]);

      await checkInvariants({ ethers, marketplace, vault }, [1n, 2n]);
    });

    it("invariant 检查通过", async function () {
      const fixture = await deploy();
      const { buyer, seller, marketplace, amount, productId } = fixture;

      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      await marketplace.connect(seller).markShipped(1n);

      await checkInvariants(fixture, [1n]);
    });
  });
});
