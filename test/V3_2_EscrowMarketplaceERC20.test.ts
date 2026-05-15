import { expect } from "chai";
import { network } from "hardhat";

describe("V3.2 EscrowMarketplaceERC20 (draft)", function () {
  enum OrderStatus {
    Created,
    Paid,
    Shipped,
    Completed,
    Cancelled,
    Disputed,
    Refunded
  }

  const DISPUTE_DELAY = 3 * 24 * 60 * 60;

  async function deploy() {
    const { ethers } = await network.create();
    const [owner, buyer, seller, stranger] = await ethers.getSigners();

    const marketplace = await ethers.deployContract("EscrowMarketplaceERC20", [], owner);
    const token = await ethers.deployContract("TestERC20", ["Mock USDC", "mUSDC", 6], owner);
    const tokenAddr = await token.getAddress();

    await marketplace.connect(owner).setAcceptedToken(tokenAddr, true);

    const amountErc20 = 1_000_000n; // 1.0 mUSDC at 6 decimals
    const amountNative = ethers.parseEther("1");
    const productId = 7n;

    // Pre-fund buyer with tokens.
    await token.mint(buyer.address, 10_000_000n);

    return {
      ethers,
      owner,
      buyer,
      seller,
      stranger,
      marketplace,
      token,
      tokenAddr,
      amountErc20,
      amountNative,
      productId
    };
  }

  describe("ownership + allowlist", function () {
    it("rejects createOrder for a non-allowlisted ERC-20", async function () {
      const fx = await deploy();
      const fake = await fx.ethers.deployContract("TestERC20", ["X", "X", 18], fx.owner);
      await expect(
        fx.marketplace
          .connect(fx.buyer)
          .createOrder(fx.seller.address, await fake.getAddress(), fx.productId, fx.amountErc20)
      ).to.be.revertedWithCustomError(fx.marketplace, "TokenNotAccepted");
    });

    it("only owner can set acceptedToken", async function () {
      const fx = await deploy();
      const fake = await fx.ethers.deployContract("TestERC20", ["Y", "Y", 18], fx.owner);
      await expect(
        fx.marketplace.connect(fx.buyer).setAcceptedToken(await fake.getAddress(), true)
      ).to.be.revertedWithCustomError(fx.marketplace, "OwnableUnauthorizedAccount");
    });

    it("emits AcceptedTokenUpdated and persists the flag", async function () {
      const fx = await deploy();
      const fake = await fx.ethers.deployContract("TestERC20", ["Z", "Z", 18], fx.owner);
      const addr = await fake.getAddress();
      await expect(fx.marketplace.connect(fx.owner).setAcceptedToken(addr, true))
        .to.emit(fx.marketplace, "AcceptedTokenUpdated")
        .withArgs(addr, true);
      expect(await fx.marketplace.acceptedToken(addr)).to.equal(true);
    });
  });

  describe("native happy path", function () {
    it("createAndPayNative → markShipped → confirmReceived releases native to seller", async function () {
      const fx = await deploy();

      await expect(
        fx.marketplace.connect(fx.buyer).createAndPayNative(fx.seller.address, fx.productId, {
          value: fx.amountNative
        })
      )
        .to.emit(fx.marketplace, "OrderCreated")
        .withArgs(1n, fx.buyer.address, fx.seller.address, fx.ethers.ZeroAddress, fx.productId, fx.amountNative)
        .and.to.emit(fx.marketplace, "OrderPaid")
        .withArgs(1n, fx.buyer.address, fx.ethers.ZeroAddress, fx.amountNative);

      // markShipped is a no-fund-movement call, so seller pays gas for it.
      // Snapshot the seller balance after markShipped, then assert exactly
      // +amountNative after confirmReceived (which the buyer pays gas for).
      await fx.marketplace.connect(fx.seller).markShipped(1n);
      const sellerBefore = await fx.ethers.provider.getBalance(fx.seller.address);

      await fx.marketplace.connect(fx.buyer).confirmReceived(1n);

      const order = await fx.marketplace.getOrder(1n);
      expect(order.status).to.equal(OrderStatus.Completed);

      const sellerAfter = await fx.ethers.provider.getBalance(fx.seller.address);
      expect(sellerAfter - sellerBefore).to.equal(fx.amountNative);

      // Marketplace must not retain funds.
      expect(await fx.ethers.provider.getBalance(await fx.marketplace.getAddress())).to.equal(0n);
    });
  });

  describe("ERC-20 happy path", function () {
    it("createOrder + approve + payOrderERC20 + ship + confirm transfers tokens to seller", async function () {
      const fx = await deploy();
      const mAddr = await fx.marketplace.getAddress();

      await fx.marketplace
        .connect(fx.buyer)
        .createOrder(fx.seller.address, fx.tokenAddr, fx.productId, fx.amountErc20);

      await fx.token.connect(fx.buyer).approve(mAddr, fx.amountErc20);

      const buyerBefore = await fx.token.balanceOf(fx.buyer.address);
      await expect(fx.marketplace.connect(fx.buyer).payOrderERC20(1n))
        .to.emit(fx.marketplace, "OrderPaid")
        .withArgs(1n, fx.buyer.address, fx.tokenAddr, fx.amountErc20);

      expect(await fx.token.balanceOf(fx.buyer.address)).to.equal(buyerBefore - fx.amountErc20);
      expect(await fx.token.balanceOf(mAddr)).to.equal(fx.amountErc20);

      await fx.marketplace.connect(fx.seller).markShipped(1n);

      const sellerBefore = await fx.token.balanceOf(fx.seller.address);
      await fx.marketplace.connect(fx.buyer).confirmReceived(1n);
      expect(await fx.token.balanceOf(fx.seller.address)).to.equal(sellerBefore + fx.amountErc20);
      expect(await fx.token.balanceOf(mAddr)).to.equal(0n);

      const order = await fx.marketplace.getOrder(1n);
      expect(order.status).to.equal(OrderStatus.Completed);
      expect(order.paymentToken).to.equal(fx.tokenAddr);
    });

    it("rejects payOrderERC20 if the order was created native", async function () {
      const fx = await deploy();
      await fx.marketplace.connect(fx.buyer).createAndPayNative(fx.seller.address, fx.productId, {
        value: fx.amountNative
      });
      await expect(fx.marketplace.connect(fx.buyer).payOrderERC20(1n)).to.be.revertedWithCustomError(
        fx.marketplace,
        "WrongPaymentMode"
      );
    });

    it("rejects payOrder (native) if the order was created ERC-20", async function () {
      const fx = await deploy();
      await fx.marketplace
        .connect(fx.buyer)
        .createOrder(fx.seller.address, fx.tokenAddr, fx.productId, fx.amountErc20);
      await expect(
        fx.marketplace.connect(fx.buyer).payOrder(1n, { value: fx.amountErc20 })
      ).to.be.revertedWithCustomError(fx.marketplace, "WrongPaymentMode");
    });
  });

  describe("dispute path (ERC-20 refund)", function () {
    it("refundBuyer=true returns tokens to buyer after delay", async function () {
      const fx = await deploy();
      const mAddr = await fx.marketplace.getAddress();
      await fx.marketplace
        .connect(fx.buyer)
        .createOrder(fx.seller.address, fx.tokenAddr, fx.productId, fx.amountErc20);
      await fx.token.connect(fx.buyer).approve(mAddr, fx.amountErc20);
      await fx.marketplace.connect(fx.buyer).payOrderERC20(1n);
      await fx.marketplace.connect(fx.buyer).openDispute(1n);

      // Cannot resolve before delay.
      await expect(
        fx.marketplace.connect(fx.owner).resolveDispute(1n, true)
      ).to.be.revertedWith("Dispute resolution delay has not elapsed");

      await fx.ethers.provider.send("evm_increaseTime", [DISPUTE_DELAY + 1]);
      await fx.ethers.provider.send("evm_mine", []);

      const buyerBefore = await fx.token.balanceOf(fx.buyer.address);
      await expect(fx.marketplace.connect(fx.owner).resolveDispute(1n, true))
        .to.emit(fx.marketplace, "DisputeResolved")
        .withArgs(1n, true)
        .and.to.emit(fx.marketplace, "OrderRefunded")
        .withArgs(1n, fx.buyer.address, fx.amountErc20);

      expect(await fx.token.balanceOf(fx.buyer.address)).to.equal(buyerBefore + fx.amountErc20);
      expect(await fx.token.balanceOf(mAddr)).to.equal(0n);

      const order = await fx.marketplace.getOrder(1n);
      expect(order.status).to.equal(OrderStatus.Refunded);
    });

    it("refundBuyer=false (seller wins) releases tokens to seller", async function () {
      const fx = await deploy();
      const mAddr = await fx.marketplace.getAddress();
      await fx.marketplace
        .connect(fx.buyer)
        .createOrder(fx.seller.address, fx.tokenAddr, fx.productId, fx.amountErc20);
      await fx.token.connect(fx.buyer).approve(mAddr, fx.amountErc20);
      await fx.marketplace.connect(fx.buyer).payOrderERC20(1n);
      await fx.marketplace.connect(fx.seller).markShipped(1n);
      await fx.marketplace.connect(fx.seller).openDispute(1n);

      await fx.ethers.provider.send("evm_increaseTime", [DISPUTE_DELAY + 1]);
      await fx.ethers.provider.send("evm_mine", []);

      const sellerBefore = await fx.token.balanceOf(fx.seller.address);
      await fx.marketplace.connect(fx.owner).resolveDispute(1n, false);
      expect(await fx.token.balanceOf(fx.seller.address)).to.equal(sellerBefore + fx.amountErc20);

      const order = await fx.marketplace.getOrder(1n);
      expect(order.status).to.equal(OrderStatus.Completed);
    });
  });

  describe("signed-auth (EIP-712, with paymentToken)", function () {
    async function buildAuth(
      fx: Awaited<ReturnType<typeof deploy>>,
      overrides: Partial<{
        buyer: string;
        seller: string;
        paymentToken: string;
        productId: bigint;
        amount: bigint;
        nonce: bigint;
        deadline: bigint;
        signer: any;
      }> = {}
    ) {
      const chainId = (await fx.ethers.provider.getNetwork()).chainId;
      const domain = {
        name: "ChainUsEscrowERC20",
        version: "3.2",
        chainId,
        verifyingContract: await fx.marketplace.getAddress()
      };
      const types = {
        PaymentAuth: [
          { name: "buyer", type: "address" },
          { name: "seller", type: "address" },
          { name: "paymentToken", type: "address" },
          { name: "productId", type: "uint256" },
          { name: "amount", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" }
        ]
      };
      const buyerAddr = overrides.buyer ?? fx.buyer.address;
      const nowSecs = BigInt(Math.floor(Date.now() / 1000));
      const auth = {
        buyer: buyerAddr,
        seller: overrides.seller ?? fx.seller.address,
        paymentToken: overrides.paymentToken ?? fx.tokenAddr,
        productId: overrides.productId ?? fx.productId,
        amount: overrides.amount ?? fx.amountErc20,
        nonce: overrides.nonce ?? (await fx.marketplace.authNonces(buyerAddr)),
        deadline: overrides.deadline ?? nowSecs + 3600n
      };
      const signer = overrides.signer ?? fx.buyer;
      const signature = await signer.signTypedData(domain, types, auth);
      return { auth, signature };
    }

    it("ERC-20 signed-auth: relayer can submit; tokens pulled from buyer", async function () {
      const fx = await deploy();
      const mAddr = await fx.marketplace.getAddress();
      await fx.token.connect(fx.buyer).approve(mAddr, fx.amountErc20);

      const { auth, signature } = await buildAuth(fx);
      await expect(fx.marketplace.connect(fx.stranger).createAndPayWithAuth(auth, signature))
        .to.emit(fx.marketplace, "PaymentAuthExecuted")
        .withArgs(1n, fx.buyer.address, fx.stranger.address, 0n);

      const order = await fx.marketplace.getOrder(1n);
      expect(order.buyer).to.equal(fx.buyer.address);
      expect(order.paymentToken).to.equal(fx.tokenAddr);
      expect(order.status).to.equal(OrderStatus.Paid);
      expect(await fx.token.balanceOf(mAddr)).to.equal(fx.amountErc20);
    });

    it("native signed-auth: msg.value must equal auth.amount", async function () {
      const fx = await deploy();
      const { auth, signature } = await buildAuth(fx, {
        paymentToken: fx.ethers.ZeroAddress,
        amount: fx.amountNative
      });
      await expect(
        fx.marketplace.connect(fx.stranger).createAndPayWithAuth(auth, signature, { value: fx.amountNative + 1n })
      ).to.be.revertedWithCustomError(fx.marketplace, "AuthAmountMismatch");
    });

    it("ERC-20 signed-auth: must NOT send native value", async function () {
      const fx = await deploy();
      await fx.token.connect(fx.buyer).approve(await fx.marketplace.getAddress(), fx.amountErc20);
      const { auth, signature } = await buildAuth(fx);
      await expect(
        fx.marketplace.connect(fx.stranger).createAndPayWithAuth(auth, signature, { value: 1n })
      ).to.be.revertedWithCustomError(fx.marketplace, "AuthAmountMismatch");
    });

    it("signature from non-buyer is rejected", async function () {
      const fx = await deploy();
      await fx.token.connect(fx.buyer).approve(await fx.marketplace.getAddress(), fx.amountErc20);
      const { auth, signature } = await buildAuth(fx, { signer: fx.stranger });
      await expect(
        fx.marketplace.connect(fx.stranger).createAndPayWithAuth(auth, signature)
      ).to.be.revertedWithCustomError(fx.marketplace, "AuthInvalidSignature");
    });
  });

  describe("reentrancy guard", function () {
    it("ReentrantERC20 cannot re-enter payOrderERC20 during release", async function () {
      const { ethers } = await network.create();
      const [owner, buyer, seller] = await ethers.getSigners();

      const marketplace = await ethers.deployContract("EscrowMarketplaceERC20", [], owner);
      const token = await ethers.deployContract("ReentrantERC20", [], owner);
      const tokenAddr = await token.getAddress();
      const mAddr = await marketplace.getAddress();

      await marketplace.connect(owner).setAcceptedToken(tokenAddr, true);
      await token.setMarketplace(mAddr);
      await token.mint(buyer.address, 10n ** 20n);

      const amount = 10n ** 18n;
      await marketplace.connect(buyer).createOrder(seller.address, tokenAddr, 1n, amount);
      await token.connect(buyer).approve(mAddr, amount);
      await marketplace.connect(buyer).payOrderERC20(1n);
      await marketplace.connect(seller).markShipped(1n);

      // Arm the token: on the next outbound transfer (release-to-seller via
      // confirmReceived), the token will attempt to re-enter payOrderERC20.
      await token.arm(1n);

      // confirmReceived must succeed (nonReentrant is the outer guard, the
      // inner re-entry attempt must revert and be swallowed by the try/catch).
      await marketplace.connect(buyer).confirmReceived(1n);

      expect(await token.reentryAttempts()).to.equal(1n);
      expect(await token.lastReentryReverted()).to.equal(true);

      // Funds were released exactly once.
      expect(await token.balanceOf(seller.address)).to.equal(amount);
      expect(await token.balanceOf(mAddr)).to.equal(0n);
    });
  });

  describe("invariants", function () {
    it("marketplace native balance is zero after a full native lifecycle", async function () {
      const fx = await deploy();
      await fx.marketplace.connect(fx.buyer).createAndPayNative(fx.seller.address, fx.productId, {
        value: fx.amountNative
      });
      await fx.marketplace.connect(fx.seller).markShipped(1n);
      await fx.marketplace.connect(fx.buyer).confirmReceived(1n);
      expect(await fx.ethers.provider.getBalance(await fx.marketplace.getAddress())).to.equal(0n);
    });

    it("rejects createOrder with seller=buyer", async function () {
      const fx = await deploy();
      await expect(
        fx.marketplace.connect(fx.buyer).createOrder(fx.buyer.address, fx.tokenAddr, fx.productId, fx.amountErc20)
      ).to.be.revertedWith("Seller cannot be buyer");
    });

    it("rejects createOrder with amount=0", async function () {
      const fx = await deploy();
      await expect(
        fx.marketplace.connect(fx.buyer).createOrder(fx.seller.address, fx.tokenAddr, fx.productId, 0n)
      ).to.be.revertedWith("Amount must be greater than zero");
    });
  });
});
