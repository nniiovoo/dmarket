import { expect } from "chai";
import { network } from "hardhat";

describe("EscrowMarketplace", function () {
  enum OrderStatus {
    Created,
    Paid,
    Shipped,
    Completed,
    Cancelled,
    Disputed,
    Refunded
  }

  async function deployFixture() {
    const { ethers } = await network.create();
    const [owner, buyer, seller, other] = await ethers.getSigners();
    const marketplace = await ethers.deployContract("EscrowMarketplace", [], owner);
    const amount = ethers.parseEther("1");
    const productId = 101n;

    return { ethers, marketplace, owner, buyer, seller, other, amount, productId };
  }

  async function createOrder() {
    const fixture = await deployFixture();
    const { marketplace, buyer, seller, amount, productId } = fixture;

    await marketplace.connect(buyer).createOrder(seller.address, productId, amount);

    return { ...fixture, orderId: 1n };
  }

  async function createPaidOrder() {
    const fixture = await createOrder();
    const { marketplace, buyer, amount, orderId } = fixture;

    await marketplace.connect(buyer).payOrder(orderId, { value: amount });

    return fixture;
  }

  async function createShippedOrder() {
    const fixture = await createPaidOrder();
    const { marketplace, seller, orderId } = fixture;

    await marketplace.connect(seller).markShipped(orderId);

    return fixture;
  }

  async function createCompletedOrder() {
    const fixture = await createShippedOrder();
    const { marketplace, buyer, orderId } = fixture;

    await marketplace.connect(buyer).confirmReceived(orderId);

    return fixture;
  }

  async function createCancelledOrder() {
    const fixture = await createOrder();
    const { marketplace, buyer, orderId } = fixture;

    await marketplace.connect(buyer).cancelOrder(orderId);

    return fixture;
  }

  async function createDisputedOrder() {
    const fixture = await createPaidOrder();
    const { marketplace, buyer, orderId } = fixture;

    await marketplace.connect(buyer).openDispute(orderId);

    return fixture;
  }

  async function createRefundedOrder() {
    const fixture = await createDisputedOrder();
    const { marketplace, owner, orderId } = fixture;

    await marketplace.connect(owner).resolveDispute(orderId, true);

    return fixture;
  }

  it("buyer 可以 createOrder", async function () {
    const { marketplace, buyer, seller, amount, productId } = await deployFixture();

    await expect(marketplace.connect(buyer).createOrder(seller.address, productId, amount))
      .to.emit(marketplace, "OrderCreated")
      .withArgs(1n, buyer.address, seller.address, productId, amount);

    expect(await marketplace.getBuyerOrders(buyer.address)).to.deep.equal([1n]);
    expect(await marketplace.getSellerOrders(seller.address)).to.deep.equal([1n]);
  });

  it("nextOrderId 从 1 开始并随 createOrder 递增", async function () {
    const { marketplace, buyer, seller, amount, productId } = await deployFixture();

    expect(await marketplace.nextOrderId()).to.equal(1n);

    await marketplace.connect(buyer).createOrder(seller.address, productId, amount);
    expect(await marketplace.nextOrderId()).to.equal(2n);

    await marketplace.connect(buyer).createOrder(seller.address, productId + 1n, amount);
    expect(await marketplace.nextOrderId()).to.equal(3n);
  });

  it("getBuyerOrders 和 getSellerOrders 会累积多个订单 id", async function () {
    const { marketplace, buyer, seller, amount, productId } = await deployFixture();

    await marketplace.connect(buyer).createOrder(seller.address, productId, amount);
    await marketplace.connect(buyer).createOrder(seller.address, productId + 1n, amount);

    expect(await marketplace.getBuyerOrders(buyer.address)).to.deep.equal([1n, 2n]);
    expect(await marketplace.getSellerOrders(seller.address)).to.deep.equal([1n, 2n]);
  });

  it("createOrder 后订单状态是 Created", async function () {
    const { marketplace, orderId } = await createOrder();

    const order = await marketplace.getOrder(orderId);

    expect(order.status).to.equal(OrderStatus.Created);
  });

  it("seller 不能是 0 地址", async function () {
    const { ethers, marketplace, buyer, amount, productId } = await deployFixture();

    await expect(
      marketplace.connect(buyer).createOrder(ethers.ZeroAddress, productId, amount)
    ).to.be.revertedWith("Seller cannot be zero address");
  });

  it("seller 不能是 buyer 自己", async function () {
    const { marketplace, buyer, amount, productId } = await deployFixture();

    await expect(
      marketplace.connect(buyer).createOrder(buyer.address, productId, amount)
    ).to.be.revertedWith("Seller cannot be buyer");
  });

  it("amount 不能是 0", async function () {
    const { marketplace, buyer, seller, productId } = await deployFixture();

    await expect(
      marketplace.connect(buyer).createOrder(seller.address, productId, 0n)
    ).to.be.revertedWith("Amount must be greater than zero");
  });

  it("buyer 可以 payOrder", async function () {
    const { marketplace, buyer, amount, orderId } = await createOrder();

    await expect(marketplace.connect(buyer).payOrder(orderId, { value: amount }))
      .to.emit(marketplace, "OrderPaid")
      .withArgs(orderId, buyer.address, amount);

    const order = await marketplace.getOrder(orderId);
    expect(order.status).to.equal(OrderStatus.Paid);
    expect(order.paidAt).to.be.greaterThan(0n);
  });

  it("同一订单不能重复 payOrder", async function () {
    const { marketplace, buyer, amount, orderId } = await createPaidOrder();

    await expect(marketplace.connect(buyer).payOrder(orderId, { value: amount })).to.be.revertedWith(
      "Order must be Created"
    );
  });

  it("payOrder 时 msg.value 必须等于 amount", async function () {
    const { marketplace, buyer, orderId } = await createOrder();

    await expect(
      marketplace.connect(buyer).payOrder(orderId, { value: 1n })
    ).to.be.revertedWith("Payment amount must equal order amount");
  });

  it("不是 buyer 不能 payOrder", async function () {
    const { marketplace, other, amount, orderId } = await createOrder();

    await expect(
      marketplace.connect(other).payOrder(orderId, { value: amount })
    ).to.be.revertedWith("Only buyer can pay this order");
  });

  it("seller 可以 markShipped", async function () {
    const { marketplace, seller, orderId } = await createPaidOrder();

    await expect(marketplace.connect(seller).markShipped(orderId))
      .to.emit(marketplace, "OrderShipped")
      .withArgs(orderId, seller.address);

    const order = await marketplace.getOrder(orderId);
    expect(order.status).to.equal(OrderStatus.Shipped);
    expect(order.shippedAt).to.be.greaterThan(0n);
  });

  it("Created 状态不能 markShipped", async function () {
    const { marketplace, seller, orderId } = await createOrder();

    await expect(marketplace.connect(seller).markShipped(orderId)).to.be.revertedWith("Order must be Paid");
  });

  it("Shipped 状态不能再次 markShipped", async function () {
    const { marketplace, seller, orderId } = await createShippedOrder();

    await expect(marketplace.connect(seller).markShipped(orderId)).to.be.revertedWith("Order must be Paid");
  });

  it("不是 seller 不能 markShipped", async function () {
    const { marketplace, other, orderId } = await createPaidOrder();

    await expect(marketplace.connect(other).markShipped(orderId)).to.be.revertedWith(
      "Only seller can mark shipped"
    );
  });

  it("buyer 可以 confirmReceived", async function () {
    const { marketplace, buyer, seller, amount, orderId } = await createShippedOrder();

    await expect(marketplace.connect(buyer).confirmReceived(orderId))
      .to.emit(marketplace, "OrderCompleted")
      .withArgs(orderId, seller.address, amount);

    const order = await marketplace.getOrder(orderId);
    expect(order.status).to.equal(OrderStatus.Completed);
    expect(order.completedAt).to.be.greaterThan(0n);
  });

  it("不是 buyer 不能 confirmReceived", async function () {
    const { marketplace, other, orderId } = await createShippedOrder();

    await expect(marketplace.connect(other).confirmReceived(orderId)).to.be.revertedWith(
      "Only buyer can confirm receipt"
    );
  });

  it("Paid 状态不能 confirmReceived", async function () {
    const { marketplace, buyer, orderId } = await createPaidOrder();

    await expect(marketplace.connect(buyer).confirmReceived(orderId)).to.be.revertedWith("Order must be Shipped");
  });

  it("confirmReceived 后 seller 余额增加", async function () {
    const { ethers, marketplace, buyer, seller, amount, orderId } = await createShippedOrder();
    const beforeBalance = await ethers.provider.getBalance(seller.address);

    await marketplace.connect(buyer).confirmReceived(orderId);

    const afterBalance = await ethers.provider.getBalance(seller.address);
    expect(afterBalance - beforeBalance).to.equal(amount);
  });

  it("Created 状态下 buyer 可以 cancelOrder", async function () {
    const { marketplace, buyer, orderId } = await createOrder();

    await expect(marketplace.connect(buyer).cancelOrder(orderId))
      .to.emit(marketplace, "OrderCancelled")
      .withArgs(orderId);

    const order = await marketplace.getOrder(orderId);
    expect(order.status).to.equal(OrderStatus.Cancelled);
  });

  it("不是 buyer 不能 cancelOrder", async function () {
    const { marketplace, other, orderId } = await createOrder();

    await expect(marketplace.connect(other).cancelOrder(orderId)).to.be.revertedWith(
      "Only buyer can cancel this order"
    );
  });

  it("Paid 状态下不能 cancelOrder", async function () {
    const { marketplace, buyer, orderId } = await createPaidOrder();

    await expect(marketplace.connect(buyer).cancelOrder(orderId)).to.be.revertedWith(
      "Only Created orders can be cancelled"
    );
  });

  it("buyer 或 seller 可以 openDispute", async function () {
    const paidOrder = await createPaidOrder();
    await expect(paidOrder.marketplace.connect(paidOrder.buyer).openDispute(paidOrder.orderId))
      .to.emit(paidOrder.marketplace, "DisputeOpened")
      .withArgs(paidOrder.orderId, paidOrder.buyer.address);

    const shippedOrder = await createShippedOrder();
    await expect(shippedOrder.marketplace.connect(shippedOrder.seller).openDispute(shippedOrder.orderId))
      .to.emit(shippedOrder.marketplace, "DisputeOpened")
      .withArgs(shippedOrder.orderId, shippedOrder.seller.address);
  });

  it("Created 状态不能 openDispute", async function () {
    const { marketplace, buyer, orderId } = await createOrder();

    await expect(marketplace.connect(buyer).openDispute(orderId)).to.be.revertedWith(
      "Order must be Paid or Shipped"
    );
  });

  it("Completed 状态不能 openDispute", async function () {
    const { marketplace, buyer, orderId } = await createCompletedOrder();

    await expect(marketplace.connect(buyer).openDispute(orderId)).to.be.revertedWith(
      "Order must be Paid or Shipped"
    );
  });

  it("Cancelled 状态不能 openDispute", async function () {
    const { marketplace, buyer, orderId } = await createCancelledOrder();

    await expect(marketplace.connect(buyer).openDispute(orderId)).to.be.revertedWith(
      "Order must be Paid or Shipped"
    );
  });

  it("非 buyer/seller 不能 openDispute", async function () {
    const { marketplace, other, orderId } = await createPaidOrder();

    await expect(marketplace.connect(other).openDispute(orderId)).to.be.revertedWith(
      "Only buyer or seller can open dispute"
    );
  });

  it("owner 可以 resolveDispute 退款给 buyer", async function () {
    const { ethers, marketplace, owner, buyer, amount, orderId } = await createPaidOrder();
    await marketplace.connect(buyer).openDispute(orderId);
    const beforeBalance = await ethers.provider.getBalance(buyer.address);

    await expect(marketplace.connect(owner).resolveDispute(orderId, true))
      .to.emit(marketplace, "OrderRefunded")
      .withArgs(orderId, buyer.address, amount)
      .and.to.emit(marketplace, "DisputeResolved")
      .withArgs(orderId, true);

    const afterBalance = await ethers.provider.getBalance(buyer.address);
    const order = await marketplace.getOrder(orderId);
    expect(order.status).to.equal(OrderStatus.Refunded);
    expect(afterBalance - beforeBalance).to.equal(amount);
  });

  it("owner 可以 resolveDispute 放款给 seller", async function () {
    const { ethers, marketplace, owner, buyer, seller, amount, orderId } = await createPaidOrder();
    await marketplace.connect(buyer).openDispute(orderId);
    const beforeBalance = await ethers.provider.getBalance(seller.address);

    await expect(marketplace.connect(owner).resolveDispute(orderId, false))
      .to.emit(marketplace, "OrderCompleted")
      .withArgs(orderId, seller.address, amount)
      .and.to.emit(marketplace, "DisputeResolved")
      .withArgs(orderId, false);

    const afterBalance = await ethers.provider.getBalance(seller.address);
    const order = await marketplace.getOrder(orderId);
    expect(order.status).to.equal(OrderStatus.Completed);
    expect(afterBalance - beforeBalance).to.equal(amount);
  });

  it("非 Disputed 状态不能 resolveDispute", async function () {
    const { marketplace, owner, orderId } = await createPaidOrder();

    await expect(marketplace.connect(owner).resolveDispute(orderId, true)).to.be.revertedWith(
      "Order must be Disputed"
    );
  });

  it("非 owner 不能 resolveDispute", async function () {
    const { marketplace, buyer, other, orderId } = await createPaidOrder();
    await marketplace.connect(buyer).openDispute(orderId);

    await expect(marketplace.connect(other).resolveDispute(orderId, true)).to.be.revertedWith(
      "Only owner can call this function"
    );
  });

  it("owner 可以 emergency refund Paid 订单", async function () {
    const { ethers, marketplace, owner, buyer, amount, orderId } = await createPaidOrder();
    const beforeBalance = await ethers.provider.getBalance(buyer.address);

    await expect(marketplace.connect(owner).ownerEmergencyRefund(orderId))
      .to.emit(marketplace, "OrderEmergencyRefunded")
      .withArgs(orderId, buyer.address, amount);

    const afterBalance = await ethers.provider.getBalance(buyer.address);
    const order = await marketplace.getOrder(orderId);
    expect(order.status).to.equal(OrderStatus.Refunded);
    expect(afterBalance - beforeBalance).to.equal(amount);
  });

  it("owner 可以 emergency refund Shipped 订单", async function () {
    const { marketplace, owner, buyer, amount, orderId } = await createShippedOrder();

    await expect(marketplace.connect(owner).ownerEmergencyRefund(orderId))
      .to.emit(marketplace, "OrderEmergencyRefunded")
      .withArgs(orderId, buyer.address, amount);

    const order = await marketplace.getOrder(orderId);
    expect(order.status).to.equal(OrderStatus.Refunded);
  });

  it("owner 可以 emergency refund Disputed 订单", async function () {
    const { marketplace, owner, buyer, amount, orderId } = await createDisputedOrder();

    await expect(marketplace.connect(owner).ownerEmergencyRefund(orderId))
      .to.emit(marketplace, "OrderEmergencyRefunded")
      .withArgs(orderId, buyer.address, amount);

    const order = await marketplace.getOrder(orderId);
    expect(order.status).to.equal(OrderStatus.Refunded);
  });

  it("非 owner 不能 emergency refund", async function () {
    const { marketplace, other, orderId } = await createPaidOrder();

    await expect(marketplace.connect(other).ownerEmergencyRefund(orderId)).to.be.revertedWith(
      "Only owner can call this function"
    );
  });

  it("没有托管资金的订单不能 emergency refund", async function () {
    const { marketplace, owner, orderId } = await createOrder();

    await expect(marketplace.connect(owner).ownerEmergencyRefund(orderId)).to.be.revertedWith(
      "Order must have escrowed funds"
    );
  });

  it("Completed 状态不能 emergency refund", async function () {
    const { marketplace, owner, orderId } = await createCompletedOrder();

    await expect(marketplace.connect(owner).ownerEmergencyRefund(orderId)).to.be.revertedWith(
      "Order must have escrowed funds"
    );
  });

  it("Refunded 状态不能 emergency refund", async function () {
    const { marketplace, owner, orderId } = await createRefundedOrder();

    await expect(marketplace.connect(owner).ownerEmergencyRefund(orderId)).to.be.revertedWith(
      "Order must have escrowed funds"
    );
  });

  it("Cancelled 状态不能 emergency refund", async function () {
    const { marketplace, owner, orderId } = await createCancelledOrder();

    await expect(marketplace.connect(owner).ownerEmergencyRefund(orderId)).to.be.revertedWith(
      "Order must have escrowed funds"
    );
  });

  it("不存在的 orderId 会被 orderExists 拦截", async function () {
    const { marketplace, buyer, seller, owner, amount } = await deployFixture();

    await expect(marketplace.getOrder(0n)).to.be.revertedWith("Order does not exist");
    await expect(marketplace.connect(buyer).payOrder(999n, { value: amount })).to.be.revertedWith(
      "Order does not exist"
    );
    await expect(marketplace.connect(seller).markShipped(999n)).to.be.revertedWith("Order does not exist");
    await expect(marketplace.connect(buyer).confirmReceived(999n)).to.be.revertedWith("Order does not exist");
    await expect(marketplace.connect(buyer).cancelOrder(999n)).to.be.revertedWith("Order does not exist");
    await expect(marketplace.connect(buyer).openDispute(999n)).to.be.revertedWith("Order does not exist");
    await expect(marketplace.connect(owner).resolveDispute(999n, true)).to.be.revertedWith("Order does not exist");
    await expect(marketplace.connect(owner).ownerEmergencyRefund(999n)).to.be.revertedWith("Order does not exist");
  });

  it("用户不能直接向合约转 ETH", async function () {
    const { marketplace, buyer, amount } = await deployFixture();

    await expect(
      buyer.sendTransaction({ to: await marketplace.getAddress(), value: amount })
    ).to.be.revertedWith("Direct ETH transfers are not allowed");
  });

  it("恶意 seller 在收款时重入也不能重复放款", async function () {
    const { ethers, marketplace, buyer, amount, productId } = await deployFixture();
    const maliciousSeller = await ethers.deployContract("MaliciousSeller", [await marketplace.getAddress()]);
    const maliciousSellerAddress = await maliciousSeller.getAddress();

    await marketplace.connect(buyer).createOrder(maliciousSellerAddress, productId, amount);
    await maliciousSeller.setOrderId(1n);
    await marketplace.connect(buyer).payOrder(1n, { value: amount });
    await maliciousSeller.markShipped();
    await maliciousSeller.enableAttack();

    const beforeSellerBalance = await ethers.provider.getBalance(maliciousSellerAddress);

    await marketplace.connect(buyer).confirmReceived(1n);

    const afterSellerBalance = await ethers.provider.getBalance(maliciousSellerAddress);
    const order = await marketplace.getOrder(1n);

    expect(order.status).to.equal(OrderStatus.Completed);
    expect(afterSellerBalance - beforeSellerBalance).to.equal(amount);
    expect(await maliciousSeller.reentryAttempts()).to.equal(1n);
    expect(await ethers.provider.getBalance(await marketplace.getAddress())).to.equal(0n);
  });

  it("恶意 buyer 拒收 ETH 时 dispute refund 会失败并保持 Disputed", async function () {
    const { ethers, marketplace, owner, seller, amount, productId } = await deployFixture();
    const maliciousBuyer = await ethers.deployContract("MaliciousBuyerRejectsEth", [await marketplace.getAddress()]);

    await maliciousBuyer.createOrder(seller.address, productId, amount);
    await maliciousBuyer.payOrder({ value: amount });
    await maliciousBuyer.openDispute();

    await expect(marketplace.connect(owner).resolveDispute(1n, true)).to.be.revertedWith(
      "ETH refund to buyer failed"
    );

    const order = await marketplace.getOrder(1n);
    expect(order.status).to.equal(OrderStatus.Disputed);
  });
});
