import { expect } from "chai";
import { network } from "hardhat";

describe("V3.3 EscrowMarketplaceV3_3 (draft)", function () {
  enum OrderStatus {
    Created,
    Paid,
    Shipped,
    Completed,
    Cancelled,
    Disputed,
    Refunded
  }

  const ZERO = "0x0000000000000000000000000000000000000000";
  const DISPUTE_DELAY = 3 * 24 * 60 * 60;
  const SHARES_BASE_URI = "https://chainus.org/api/shop-shares/{id}.json";
  const SHOP_MINT_FEE = 10n ** 15n; // 0.001 ETH

  async function deploy() {
    const { ethers, provider } = await network.create();
    const [owner, buyer, seller, holder, stranger] = await ethers.getSigners();

    const shopNft = await ethers.deployContract("ShopNFT", [SHOP_MINT_FEE, owner.address], owner);
    const shares = await ethers.deployContract(
      "ShopShares",
      [await shopNft.getAddress(), SHARES_BASE_URI],
      owner
    );
    const distributor = await ethers.deployContract(
      "RevenueDistributor",
      [await shares.getAddress()],
      owner
    );
    await shares.connect(owner).setSettler(await distributor.getAddress());

    const marketplace = await ethers.deployContract(
      "EscrowMarketplaceV3_3",
      [await shopNft.getAddress(), await distributor.getAddress()],
      owner
    );
    await distributor
      .connect(owner)
      .setAuthorizedDepositor(await marketplace.getAddress(), true);

    const token = await ethers.deployContract("TestERC20", ["Mock USDC", "mUSDC", 6], owner);
    const tokenAddr = await token.getAddress();
    await marketplace.connect(owner).setAcceptedToken(tokenAddr, true);
    await token.mint(buyer.address, 10_000_000n);

    // seller mints their shop + initialises shares → seller holds all 10k.
    await shopNft.connect(seller).mintShop("S Shop", "", "", { value: SHOP_MINT_FEE });
    const sellerShopId: bigint = await shopNft.shopIdOf(seller.address);
    await shares.connect(seller).initializeShares(sellerShopId);
    // seller transfers 3k to holder so we have a 7000/3000 split for the
    // revenue-distribution tests.
    await shares
      .connect(seller)
      .safeTransferFrom(seller.address, holder.address, sellerShopId, 3_000n, "0x");

    return {
      ethers,
      provider,
      owner,
      buyer,
      seller,
      holder,
      stranger,
      shopNft,
      shares,
      distributor,
      marketplace,
      marketplaceAddr: await marketplace.getAddress(),
      distAddr: await distributor.getAddress(),
      token,
      tokenAddr,
      amountErc20: 1_000_000n,
      amountNative: ethers.parseEther("1"),
      productId: 7n,
      sellerShopId
    };
  }

  async function advanceTime(provider: { send: (m: string, p: unknown[]) => Promise<unknown> }, seconds: number) {
    await provider.send("evm_increaseTime", [seconds]);
    await provider.send("evm_mine", []);
  }

  // -----------------------------------------------------------------------
  // Lifecycle — happy paths inherited from v3.2 + the new shopId field
  // -----------------------------------------------------------------------
  describe("lifecycle", function () {
    it("createAndPayNative → markShipped → confirmReceived", async function () {
      const fx = await deploy();
      const tx = await fx.marketplace
        .connect(fx.buyer)
        .createAndPayNative(fx.seller.address, fx.productId, { value: fx.amountNative });
      await tx.wait();
      await fx.marketplace.connect(fx.seller).markShipped(1n);
      const sellerBefore = await fx.ethers.provider.getBalance(fx.seller.address);
      await fx.marketplace.connect(fx.buyer).confirmReceived(1n);
      const sellerAfter = await fx.ethers.provider.getBalance(fx.seller.address);
      // Default 1 % fee → seller receives 99 %.
      const expectedSellerNet = (fx.amountNative * 9_900n) / 10_000n;
      expect(sellerAfter - sellerBefore).to.equal(expectedSellerNet);
      const order = await fx.marketplace.getOrder(1n);
      expect(order.status).to.equal(OrderStatus.Completed);
      expect(order.shopId).to.equal(fx.sellerShopId);
    });

    it("create + payOrder + ship + confirm (native, two-step)", async function () {
      const fx = await deploy();
      await fx.marketplace
        .connect(fx.buyer)
        .createOrder(fx.seller.address, ZERO, fx.productId, fx.amountNative);
      await fx.marketplace.connect(fx.buyer).payOrder(1n, { value: fx.amountNative });
      await fx.marketplace.connect(fx.seller).markShipped(1n);
      await fx.marketplace.connect(fx.buyer).confirmReceived(1n);
      expect((await fx.marketplace.getOrder(1n)).status).to.equal(OrderStatus.Completed);
    });

    it("create + payOrderERC20 + ship + confirm", async function () {
      const fx = await deploy();
      await fx.marketplace
        .connect(fx.buyer)
        .createOrder(fx.seller.address, fx.tokenAddr, fx.productId, fx.amountErc20);
      await fx.token.connect(fx.buyer).approve(fx.marketplaceAddr, fx.amountErc20);
      await fx.marketplace.connect(fx.buyer).payOrderERC20(1n);
      await fx.marketplace.connect(fx.seller).markShipped(1n);
      await fx.marketplace.connect(fx.buyer).confirmReceived(1n);
      const expectedSellerNet = (fx.amountErc20 * 9_900n) / 10_000n;
      expect(await fx.token.balanceOf(fx.seller.address)).to.equal(expectedSellerNet);
    });

    it("cancel by buyer (Created) transitions to Cancelled and does not pay distributor", async function () {
      const fx = await deploy();
      await fx.marketplace
        .connect(fx.buyer)
        .createOrder(fx.seller.address, fx.tokenAddr, fx.productId, fx.amountErc20);
      await fx.marketplace.connect(fx.buyer).cancelOrder(1n);
      expect((await fx.marketplace.getOrder(1n)).status).to.equal(OrderStatus.Cancelled);
      // distributor cumulativeIndex never moved.
      expect(await fx.distributor.cumulativeIndex(fx.sellerShopId, fx.tokenAddr)).to.equal(0n);
    });

    it("openDispute → resolveDispute(refundBuyer=true) returns full amount to buyer (no fee)", async function () {
      const fx = await deploy();
      await fx.marketplace
        .connect(fx.buyer)
        .createAndPayNative(fx.seller.address, fx.productId, { value: fx.amountNative });
      await fx.marketplace.connect(fx.seller).markShipped(1n);
      await fx.marketplace.connect(fx.buyer).openDispute(1n);
      await advanceTime(fx.provider, DISPUTE_DELAY + 1);
      const before = await fx.ethers.provider.getBalance(fx.buyer.address);
      const tx = await fx.marketplace.connect(fx.owner).resolveDispute(1n, true);
      await tx.wait();
      const after = await fx.ethers.provider.getBalance(fx.buyer.address);
      expect(after - before).to.equal(fx.amountNative);
      expect(await fx.distributor.cumulativeIndex(fx.sellerShopId, ZERO)).to.equal(0n);
    });

    it("openDispute → resolveDispute(refundBuyer=false) routes the fee like a normal complete", async function () {
      const fx = await deploy();
      await fx.marketplace
        .connect(fx.buyer)
        .createAndPayNative(fx.seller.address, fx.productId, { value: fx.amountNative });
      await fx.marketplace.connect(fx.seller).markShipped(1n);
      await fx.marketplace.connect(fx.buyer).openDispute(1n);
      await advanceTime(fx.provider, DISPUTE_DELAY + 1);
      const sellerBefore = await fx.ethers.provider.getBalance(fx.seller.address);
      await fx.marketplace.connect(fx.owner).resolveDispute(1n, false);
      const sellerAfter = await fx.ethers.provider.getBalance(fx.seller.address);
      const fee = (fx.amountNative * 100n) / 10_000n;
      expect(sellerAfter - sellerBefore).to.equal(fx.amountNative - fee);
      const PRECISION: bigint = await fx.distributor.PRECISION();
      expect(await fx.distributor.cumulativeIndex(fx.sellerShopId, ZERO)).to.equal(
        (fee * PRECISION) / 10_000n
      );
    });
  });

  // -----------------------------------------------------------------------
  // Shop / seller requirements
  // -----------------------------------------------------------------------
  describe("shop association", function () {
    it("createOrder reverts NoShopAssociated when seller has no ShopNFT", async function () {
      const fx = await deploy();
      // stranger never minted a shop.
      await expect(
        fx.marketplace
          .connect(fx.buyer)
          .createOrder(fx.stranger.address, ZERO, fx.productId, fx.amountNative)
      )
        .to.be.revertedWithCustomError(fx.marketplace, "NoShopAssociated")
        .withArgs(fx.stranger.address);
    });

    it("createAndPayNative reverts NoShopAssociated when seller has no ShopNFT", async function () {
      const fx = await deploy();
      await expect(
        fx.marketplace
          .connect(fx.buyer)
          .createAndPayNative(fx.stranger.address, fx.productId, { value: fx.amountNative })
      )
        .to.be.revertedWithCustomError(fx.marketplace, "NoShopAssociated")
        .withArgs(fx.stranger.address);
    });

    it("Order.shopId is the seller's shopId at *create time*; later NFT transfers don't change it", async function () {
      const fx = await deploy();
      await fx.marketplace
        .connect(fx.buyer)
        .createOrder(fx.seller.address, ZERO, fx.productId, fx.amountNative);
      // seller transfers the ShopNFT to stranger — Order.shopId stays.
      await fx.shopNft
        .connect(fx.seller)
        .transferFrom(fx.seller.address, fx.stranger.address, fx.sellerShopId);
      expect((await fx.marketplace.getOrder(1n)).shopId).to.equal(fx.sellerShopId);
      // ShopNFT got handed off.
      expect(await fx.shopNft.shopIdOf(fx.stranger.address)).to.equal(fx.sellerShopId);
    });
  });

  // -----------------------------------------------------------------------
  // Revenue distribution
  // -----------------------------------------------------------------------
  describe("revenue distribution", function () {
    it("native completed order: seller gets 99 %, distributor cumulativeIndex moves correctly", async function () {
      const fx = await deploy();
      await fx.marketplace
        .connect(fx.buyer)
        .createAndPayNative(fx.seller.address, fx.productId, { value: fx.amountNative });
      await fx.marketplace.connect(fx.seller).markShipped(1n);
      const sellerBefore = await fx.ethers.provider.getBalance(fx.seller.address);
      await expect(fx.marketplace.connect(fx.buyer).confirmReceived(1n))
        .to.emit(fx.marketplace, "RevenueDistributed")
        .withArgs(
          1n,
          fx.sellerShopId,
          ZERO,
          (fx.amountNative * 100n) / 10_000n,
          (fx.amountNative * 9_900n) / 10_000n
        );
      const sellerAfter = await fx.ethers.provider.getBalance(fx.seller.address);
      expect(sellerAfter - sellerBefore).to.equal((fx.amountNative * 9_900n) / 10_000n);
      const PRECISION: bigint = await fx.distributor.PRECISION();
      const total: bigint = await fx.shares.TOTAL_SUPPLY();
      const fee = (fx.amountNative * 100n) / 10_000n;
      expect(await fx.distributor.cumulativeIndex(fx.sellerShopId, ZERO)).to.equal(
        (fee * PRECISION) / total
      );
    });

    it("ERC-20 completed order: seller gets 99 %, distributor receives 1 % token balance", async function () {
      const fx = await deploy();
      await fx.marketplace
        .connect(fx.buyer)
        .createOrder(fx.seller.address, fx.tokenAddr, fx.productId, fx.amountErc20);
      await fx.token.connect(fx.buyer).approve(fx.marketplaceAddr, fx.amountErc20);
      await fx.marketplace.connect(fx.buyer).payOrderERC20(1n);
      await fx.marketplace.connect(fx.seller).markShipped(1n);
      await fx.marketplace.connect(fx.buyer).confirmReceived(1n);
      const fee = (fx.amountErc20 * 100n) / 10_000n;
      expect(await fx.token.balanceOf(fx.seller.address)).to.equal(fx.amountErc20 - fee);
      expect(await fx.token.balanceOf(fx.distAddr)).to.equal(fee);
      // forceApprove(0) cleanup after deposit.
      expect(await fx.token.allowance(fx.marketplaceAddr, fx.distAddr)).to.equal(0n);
    });

    it("feeRateBps = 500 (5 %) → seller 95 %, distributor 5 %", async function () {
      const fx = await deploy();
      await fx.marketplace.connect(fx.owner).setFeeRateBps(500);
      await fx.marketplace
        .connect(fx.buyer)
        .createAndPayNative(fx.seller.address, fx.productId, { value: fx.amountNative });
      await fx.marketplace.connect(fx.seller).markShipped(1n);
      const sellerBefore = await fx.ethers.provider.getBalance(fx.seller.address);
      await fx.marketplace.connect(fx.buyer).confirmReceived(1n);
      const sellerAfter = await fx.ethers.provider.getBalance(fx.seller.address);
      expect(sellerAfter - sellerBefore).to.equal((fx.amountNative * 9_500n) / 10_000n);
      expect(await fx.ethers.provider.getBalance(fx.distAddr)).to.equal(
        (fx.amountNative * 500n) / 10_000n
      );
    });

    it("feeRateBps = 0 → seller receives 100 %, distributor not called, no RevenueDistributed event", async function () {
      const fx = await deploy();
      await fx.marketplace.connect(fx.owner).setFeeRateBps(0);
      await fx.marketplace
        .connect(fx.buyer)
        .createAndPayNative(fx.seller.address, fx.productId, { value: fx.amountNative });
      await fx.marketplace.connect(fx.seller).markShipped(1n);
      await expect(fx.marketplace.connect(fx.buyer).confirmReceived(1n)).to.not.emit(
        fx.marketplace,
        "RevenueDistributed"
      );
      expect(await fx.ethers.provider.getBalance(fx.distAddr)).to.equal(0n);
    });

    it("shareholders earn pro-rata: 7 000 / 3 000 split → 70 % / 30 % of fee", async function () {
      const fx = await deploy();
      await fx.marketplace
        .connect(fx.buyer)
        .createAndPayNative(fx.seller.address, fx.productId, { value: fx.amountNative });
      await fx.marketplace.connect(fx.seller).markShipped(1n);
      await fx.marketplace.connect(fx.buyer).confirmReceived(1n);
      const fee = (fx.amountNative * 100n) / 10_000n;
      expect(
        await fx.distributor.pendingClaim(fx.sellerShopId, ZERO, fx.seller.address)
      ).to.equal((fee * 7_000n) / 10_000n);
      expect(
        await fx.distributor.pendingClaim(fx.sellerShopId, ZERO, fx.holder.address)
      ).to.equal((fee * 3_000n) / 10_000n);
    });

    it("five orders accumulate cleanly on the same shopId (cumulativeIndex grows linearly)", async function () {
      const fx = await deploy();
      const PRECISION: bigint = await fx.distributor.PRECISION();
      const total: bigint = await fx.shares.TOTAL_SUPPLY();
      for (let i = 0; i < 5; i++) {
        await fx.marketplace
          .connect(fx.buyer)
          .createAndPayNative(fx.seller.address, fx.productId, { value: fx.amountNative });
        const orderId = BigInt(i + 1);
        await fx.marketplace.connect(fx.seller).markShipped(orderId);
        await fx.marketplace.connect(fx.buyer).confirmReceived(orderId);
      }
      const totalFees = ((fx.amountNative * 100n) / 10_000n) * 5n;
      expect(await fx.distributor.cumulativeIndex(fx.sellerShopId, ZERO)).to.equal(
        (totalFees * PRECISION) / total
      );
    });

    it("cancel does NOT route to distributor", async function () {
      const fx = await deploy();
      await fx.marketplace
        .connect(fx.buyer)
        .createOrder(fx.seller.address, fx.tokenAddr, fx.productId, fx.amountErc20);
      await fx.marketplace.connect(fx.buyer).cancelOrder(1n);
      expect(await fx.token.balanceOf(fx.distAddr)).to.equal(0n);
      expect(await fx.distributor.cumulativeIndex(fx.sellerShopId, fx.tokenAddr)).to.equal(0n);
    });
  });

  // -----------------------------------------------------------------------
  // Admin
  // -----------------------------------------------------------------------
  describe("admin", function () {
    it("setFeeRateBps above MAX_FEE_BPS reverts InvalidFeeBps", async function () {
      const fx = await deploy();
      await expect(fx.marketplace.connect(fx.owner).setFeeRateBps(1_001))
        .to.be.revertedWithCustomError(fx.marketplace, "InvalidFeeBps")
        .withArgs(1_001);
    });

    it("setFeeRateBps at MAX_FEE_BPS is accepted and emits FeeRateUpdated", async function () {
      const fx = await deploy();
      await expect(fx.marketplace.connect(fx.owner).setFeeRateBps(1_000))
        .to.emit(fx.marketplace, "FeeRateUpdated")
        .withArgs(100, 1_000);
    });

    it("setDistributor by non-owner reverts", async function () {
      const fx = await deploy();
      await expect(
        fx.marketplace.connect(fx.stranger).setDistributor(fx.stranger.address)
      ).to.be.revertedWithCustomError(fx.marketplace, "OwnableUnauthorizedAccount");
    });

    it("setDistributor zero address reverts", async function () {
      const fx = await deploy();
      await expect(
        fx.marketplace.connect(fx.owner).setDistributor(ZERO)
      ).to.be.revertedWithCustomError(fx.marketplace, "ZeroDistributor");
    });

    it("Ownable2Step transfer + acceptOwnership", async function () {
      const fx = await deploy();
      await fx.marketplace.connect(fx.owner).transferOwnership(fx.stranger.address);
      expect(await fx.marketplace.owner()).to.equal(fx.owner.address);
      await fx.marketplace.connect(fx.stranger).acceptOwnership();
      expect(await fx.marketplace.owner()).to.equal(fx.stranger.address);
    });

    it("setFeeRecipient by owner updates + emits; zero address reverts", async function () {
      const fx = await deploy();
      await expect(fx.marketplace.connect(fx.owner).setFeeRecipient(fx.holder.address))
        .to.emit(fx.marketplace, "FeeRecipientUpdated")
        .withArgs(fx.owner.address, fx.holder.address);
      await expect(
        fx.marketplace.connect(fx.owner).setFeeRecipient(ZERO)
      ).to.be.revertedWith("Recipient cannot be zero");
    });
  });

  // -----------------------------------------------------------------------
  // EIP-712 PaymentAuth
  // -----------------------------------------------------------------------
  describe("createAndPayWithAuth (EIP-712)", function () {
    async function signAuth(fx: Awaited<ReturnType<typeof deploy>>, overrides: Partial<{
      buyer: string;
      seller: string;
      paymentToken: string;
      productId: bigint;
      amount: bigint;
      nonce: bigint;
      deadline: bigint;
    }> = {}) {
      const domain = {
        name: "ChainUsEscrowV3_3",
        version: "3.3",
        chainId: (await fx.ethers.provider.getNetwork()).chainId,
        verifyingContract: fx.marketplaceAddr
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
      } as const;
      const value = {
        buyer: overrides.buyer ?? fx.buyer.address,
        seller: overrides.seller ?? fx.seller.address,
        paymentToken: overrides.paymentToken ?? fx.tokenAddr,
        productId: overrides.productId ?? fx.productId,
        amount: overrides.amount ?? fx.amountErc20,
        nonce: overrides.nonce ?? (await fx.marketplace.authNonces(fx.buyer.address)),
        deadline:
          overrides.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 60 * 60)
      };
      const sig = await fx.buyer.signTypedData(domain, types, value);
      return { value, sig };
    }

    it("happy path: createAndPayWithAuth on ERC-20 completes the order", async function () {
      const fx = await deploy();
      await fx.token.connect(fx.buyer).approve(fx.marketplaceAddr, fx.amountErc20);
      const { value, sig } = await signAuth(fx);
      await expect(fx.marketplace.connect(fx.stranger).createAndPayWithAuth(value, sig))
        .to.emit(fx.marketplace, "PaymentAuthExecuted")
        .withArgs(1n, fx.buyer.address, fx.stranger.address, 0n);
      expect((await fx.marketplace.getOrder(1n)).status).to.equal(OrderStatus.Paid);
    });

    it("rejects a v3.2-domain signature (different EIP-712 domain ⇒ different digest)", async function () {
      const fx = await deploy();
      await fx.token.connect(fx.buyer).approve(fx.marketplaceAddr, fx.amountErc20);
      const wrongDomain = {
        name: "ChainUsEscrowERC20", // v3.2 name
        version: "3.2", // v3.2 version
        chainId: (await fx.ethers.provider.getNetwork()).chainId,
        verifyingContract: fx.marketplaceAddr
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
      } as const;
      const value = {
        buyer: fx.buyer.address,
        seller: fx.seller.address,
        paymentToken: fx.tokenAddr,
        productId: fx.productId,
        amount: fx.amountErc20,
        nonce: 0n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 60 * 60)
      };
      const sig = await fx.buyer.signTypedData(wrongDomain, types, value);
      await expect(
        fx.marketplace.connect(fx.stranger).createAndPayWithAuth(value, sig)
      ).to.be.revertedWithCustomError(fx.marketplace, "AuthInvalidSignature");
    });

    it("invalidateNonce bumps the buyer's nonce and rejects the now-stale signature", async function () {
      const fx = await deploy();
      await fx.marketplace.connect(fx.buyer).invalidateNonce();
      const { value, sig } = await signAuth(fx, { nonce: 0n });
      await fx.token.connect(fx.buyer).approve(fx.marketplaceAddr, fx.amountErc20);
      await expect(
        fx.marketplace.connect(fx.stranger).createAndPayWithAuth(value, sig)
      ).to.be.revertedWithCustomError(fx.marketplace, "AuthNonceMismatch");
    });

    it("native createAndPayWithAuth happy path (msg.value == auth.amount)", async function () {
      const fx = await deploy();
      const { value, sig } = await signAuth(fx, {
        paymentToken: ZERO,
        amount: fx.amountNative
      });
      await fx.marketplace
        .connect(fx.stranger)
        .createAndPayWithAuth(value, sig, { value: fx.amountNative });
      const order = await fx.marketplace.getOrder(1n);
      expect(order.status).to.equal(OrderStatus.Paid);
      expect(order.paymentToken).to.equal(ZERO);
      expect(order.shopId).to.equal(fx.sellerShopId);
    });
  });

  // -----------------------------------------------------------------------
  // Multi-shop + investor-invariant edge cases
  // -----------------------------------------------------------------------
  describe("multi-shop + investor invariant", function () {
    it("orders to two different sellers route fees to distinct shopIds", async function () {
      const fx = await deploy();
      // holder mints their own shop → shopId differs from sellerShopId.
      await fx.shopNft.connect(fx.holder).mintShop("H Shop", "", "", { value: SHOP_MINT_FEE });
      const holderShopId: bigint = await fx.shopNft.shopIdOf(fx.holder.address);
      expect(holderShopId).to.not.equal(fx.sellerShopId);

      // Order #1 to seller → fee goes to sellerShopId.
      await fx.marketplace
        .connect(fx.buyer)
        .createAndPayNative(fx.seller.address, fx.productId, { value: fx.amountNative });
      await fx.marketplace.connect(fx.seller).markShipped(1n);
      await fx.marketplace.connect(fx.buyer).confirmReceived(1n);

      // Order #2 to holder → fee goes to holderShopId.
      await fx.marketplace
        .connect(fx.buyer)
        .createAndPayNative(fx.holder.address, fx.productId + 1n, { value: fx.amountNative });
      await fx.marketplace.connect(fx.holder).markShipped(2n);
      await fx.marketplace.connect(fx.buyer).confirmReceived(2n);

      const fee = (fx.amountNative * 100n) / 10_000n;
      const PRECISION: bigint = await fx.distributor.PRECISION();
      const total: bigint = await fx.shares.TOTAL_SUPPLY();
      const expected = (fee * PRECISION) / total;
      expect(await fx.distributor.cumulativeIndex(fx.sellerShopId, ZERO)).to.equal(expected);
      expect(await fx.distributor.cumulativeIndex(holderShopId, ZERO)).to.equal(expected);
    });

    it("investor invariant: ShopNFT transferred mid-flight, revenue still routes to original shopId", async function () {
      const fx = await deploy();
      // Order created → Order.shopId captured.
      await fx.marketplace
        .connect(fx.buyer)
        .createAndPayNative(fx.seller.address, fx.productId, { value: fx.amountNative });
      const orderShopIdBefore = (await fx.marketplace.getOrder(1n)).shopId;
      expect(orderShopIdBefore).to.equal(fx.sellerShopId);

      // Seller hands the NFT to stranger BEFORE the order completes.
      await fx.shopNft
        .connect(fx.seller)
        .transferFrom(fx.seller.address, fx.stranger.address, fx.sellerShopId);

      // Complete the order. Fee should still route to the snapshot
      // shopId, which is now owned by stranger — but the *shareholders*
      // are unchanged (the ShopNFT transfer didn't move shares).
      await fx.marketplace.connect(fx.seller).markShipped(1n);
      await fx.marketplace.connect(fx.buyer).confirmReceived(1n);

      const fee = (fx.amountNative * 100n) / 10_000n;
      const PRECISION: bigint = await fx.distributor.PRECISION();
      const total: bigint = await fx.shares.TOTAL_SUPPLY();
      expect(await fx.distributor.cumulativeIndex(fx.sellerShopId, ZERO)).to.equal(
        (fee * PRECISION) / total
      );
      // Shareholders unchanged: seller still holds 7000, holder 3000.
      expect(
        await fx.distributor.pendingClaim(fx.sellerShopId, ZERO, fx.seller.address)
      ).to.equal((fee * 7_000n) / 10_000n);
      expect(
        await fx.distributor.pendingClaim(fx.sellerShopId, ZERO, fx.holder.address)
      ).to.equal((fee * 3_000n) / 10_000n);
      // stranger (new ShopNFT owner) holds zero shares.
      expect(
        await fx.distributor.pendingClaim(fx.sellerShopId, ZERO, fx.stranger.address)
      ).to.equal(0n);
    });
  });

  // -----------------------------------------------------------------------
  // Receive guard
  // -----------------------------------------------------------------------
  describe("receive() guard", function () {
    it("direct ETH transfer to marketplace reverts (matches v3.2)", async function () {
      const fx = await deploy();
      await expect(
        fx.stranger.sendTransaction({ to: fx.marketplaceAddr, value: 1n })
      ).to.be.revertedWith("Direct ETH transfers are not allowed");
    });
  });

  // -----------------------------------------------------------------------
  // setAcceptedToken
  // -----------------------------------------------------------------------
  describe("setAcceptedToken", function () {
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
  });

  // -----------------------------------------------------------------------
  // Conservation invariants
  // -----------------------------------------------------------------------
  describe("funds conservation", function () {
    it("native: post-completion marketplace balance is 0; seller + distributor sum to amount", async function () {
      const fx = await deploy();
      await fx.marketplace
        .connect(fx.buyer)
        .createAndPayNative(fx.seller.address, fx.productId, { value: fx.amountNative });
      await fx.marketplace.connect(fx.seller).markShipped(1n);
      const sellerBefore = await fx.ethers.provider.getBalance(fx.seller.address);
      const distBefore = await fx.ethers.provider.getBalance(fx.distAddr);
      await fx.marketplace.connect(fx.buyer).confirmReceived(1n);
      const sellerAfter = await fx.ethers.provider.getBalance(fx.seller.address);
      const distAfter = await fx.ethers.provider.getBalance(fx.distAddr);
      expect(await fx.ethers.provider.getBalance(fx.marketplaceAddr)).to.equal(0n);
      const sellerDelta = sellerAfter - sellerBefore;
      const distDelta = distAfter - distBefore;
      expect(sellerDelta + distDelta).to.equal(fx.amountNative);
    });

    it("ERC-20: marketplace token balance returns to 0; allowance to distributor cleared", async function () {
      const fx = await deploy();
      await fx.marketplace
        .connect(fx.buyer)
        .createOrder(fx.seller.address, fx.tokenAddr, fx.productId, fx.amountErc20);
      await fx.token.connect(fx.buyer).approve(fx.marketplaceAddr, fx.amountErc20);
      await fx.marketplace.connect(fx.buyer).payOrderERC20(1n);
      await fx.marketplace.connect(fx.seller).markShipped(1n);
      await fx.marketplace.connect(fx.buyer).confirmReceived(1n);
      expect(await fx.token.balanceOf(fx.marketplaceAddr)).to.equal(0n);
      expect(await fx.token.allowance(fx.marketplaceAddr, fx.distAddr)).to.equal(0n);
    });

    it("five-order rollup: distributor delta = 5× fee; marketplace returns to 0", async function () {
      // Note: we measure the distributor delta (the only party in the
      // loop that doesn't pay gas on any tx) and the marketplace
      // balance. Summing seller's balance delta is incorrect because
      // seller pays gas on markShipped each iteration.
      const fx = await deploy();
      const distBefore = await fx.ethers.provider.getBalance(fx.distAddr);
      for (let i = 0; i < 5; i++) {
        await fx.marketplace
          .connect(fx.buyer)
          .createAndPayNative(fx.seller.address, fx.productId, { value: fx.amountNative });
        const orderId = BigInt(i + 1);
        await fx.marketplace.connect(fx.seller).markShipped(orderId);
        await fx.marketplace.connect(fx.buyer).confirmReceived(orderId);
      }
      const distAfter = await fx.ethers.provider.getBalance(fx.distAddr);
      const expectedFeeTotal = ((fx.amountNative * 100n) / 10_000n) * 5n;
      expect(distAfter - distBefore).to.equal(expectedFeeTotal);
      expect(await fx.ethers.provider.getBalance(fx.marketplaceAddr)).to.equal(0n);
    });
  });
});
