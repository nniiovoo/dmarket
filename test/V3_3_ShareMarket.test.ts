import { expect } from "chai";
import { network } from "hardhat";

describe("V3.3 ShareMarket (partial-fill redesign, Phase M.1)", function () {
  enum ListingStatus {
    Active,
    Filled,
    Cancelled
  }

  const ZERO = "0x0000000000000000000000000000000000000000";
  const SHARES_BASE_URI = "https://chainus.org/api/shop-shares/{id}.json";
  const SHOP_MINT_FEE = 10n ** 15n;

  async function deploy() {
    const { ethers } = await network.create();
    const [owner, seller, alice, buyer, stranger] = await ethers.getSigners();

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

    const market = await ethers.deployContract(
      "ShareMarket",
      [await shares.getAddress()],
      owner
    );

    // seller mints shop #1 + initialises 10 000 tokens.
    await shopNft.connect(seller).mintShop("S Shop", "", "", { value: SHOP_MINT_FEE });
    const shopId: bigint = await shopNft.shopIdOf(seller.address);
    await shares.connect(seller).initializeShares(shopId);
    // Move 5 000 to alice so seller has a meaningful balance left.
    await shares
      .connect(seller)
      .safeTransferFrom(seller.address, alice.address, shopId, 5_000n, "0x");

    const token = await ethers.deployContract("TestERC20", ["Mock USDC", "mUSDC", 6], owner);
    const tokenAddr = await token.getAddress();
    await token.mint(buyer.address, 100_000_000n);
    await token.mint(stranger.address, 100_000_000n);

    const marketAddr = await market.getAddress();
    return {
      ethers,
      owner,
      seller,
      alice,
      buyer,
      stranger,
      shopNft,
      shares,
      sharesAddr: await shares.getAddress(),
      distributor,
      market,
      marketAddr,
      token,
      tokenAddr,
      shopId
    };
  }

  // -----------------------------------------------------------------------
  // createListing happy paths
  // -----------------------------------------------------------------------
  describe("createListing", function () {
    it("native: emits ListingCreated(amount, pricePerToken), seeds remaining=amount", async function () {
      const fx = await deploy();
      const pricePerToken = fx.ethers.parseEther("0.001");
      const amount = 2_000n;
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);

      await expect(
        fx.market.connect(fx.seller).createListing(fx.shopId, amount, ZERO, pricePerToken)
      )
        .to.emit(fx.market, "ListingCreated")
        .withArgs(1n, fx.seller.address, fx.shopId, amount, ZERO, pricePerToken);

      const l = await fx.market.getListing(1n);
      expect(l.originalAmount).to.equal(amount);
      expect(l.remainingAmount).to.equal(amount);
      expect(l.pricePerToken).to.equal(pricePerToken);
      expect(l.status).to.equal(ListingStatus.Active);
      expect(await fx.market.getRemainingAmount(1n)).to.equal(amount);
    });

    it("ERC-20: same shape with non-native paymentToken", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 1_500n, fx.tokenAddr, 5_000n);
      const l = await fx.market.getListing(1n);
      expect(l.paymentToken).to.equal(fx.tokenAddr);
      expect(l.pricePerToken).to.equal(5_000n);
    });

    it("createListing without setApprovalForAll reverts MarketNotApproved", async function () {
      const fx = await deploy();
      await expect(
        fx.market.connect(fx.seller).createListing(fx.shopId, 100n, ZERO, 1n)
      )
        .to.be.revertedWithCustomError(fx.market, "MarketNotApproved")
        .withArgs(fx.seller.address);
    });

    it("createListing for more tokens than seller holds reverts InsufficientShares", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      // seller currently holds 5 000 — list 6 000.
      await expect(
        fx.market.connect(fx.seller).createListing(fx.shopId, 6_000n, ZERO, 1n)
      )
        .to.be.revertedWithCustomError(fx.market, "InsufficientShares")
        .withArgs(fx.seller.address, fx.shopId, 5_000n, 6_000n);
    });

    it("createListing(amount=0) reverts AmountZero", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await expect(
        fx.market.connect(fx.seller).createListing(fx.shopId, 0n, ZERO, 1n)
      ).to.be.revertedWithCustomError(fx.market, "AmountZero");
    });

    it("createListing(pricePerToken=0) reverts PriceZero", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await expect(
        fx.market.connect(fx.seller).createListing(fx.shopId, 100n, ZERO, 0n)
      ).to.be.revertedWithCustomError(fx.market, "PriceZero");
    });
  });

  // -----------------------------------------------------------------------
  // fillListing — full + partial paths
  // -----------------------------------------------------------------------
  describe("fillListing (whole amount)", function () {
    it("native: fill whole amount in one shot → Filled, seller paid", async function () {
      const fx = await deploy();
      const pricePerToken = fx.ethers.parseEther("0.0005");
      const amount = 1_000n;
      const totalCost = pricePerToken * amount;
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, amount, ZERO, pricePerToken);

      const sellerBefore = await fx.ethers.provider.getBalance(fx.seller.address);
      await expect(fx.market.connect(fx.buyer).fillListing(1n, amount, { value: totalCost }))
        .to.emit(fx.market, "ListingFilled")
        .withArgs(1n, fx.buyer.address, fx.seller.address, fx.shopId, amount, ZERO, totalCost, 0n);
      const sellerAfter = await fx.ethers.provider.getBalance(fx.seller.address);

      expect(sellerAfter - sellerBefore).to.equal(totalCost);
      expect(await fx.shares.balanceOf(fx.buyer.address, fx.shopId)).to.equal(amount);
      const l = await fx.market.getListing(1n);
      expect(l.status).to.equal(ListingStatus.Filled);
      expect(l.remainingAmount).to.equal(0n);
      expect(await fx.ethers.provider.getBalance(fx.marketAddr)).to.equal(0n);
    });

    it("ERC-20: full fill transfers tokens to seller + tokens to buyer", async function () {
      const fx = await deploy();
      const pricePerToken = 5_000n; // 0.005 mUSDC per token
      const amount = 1_500n;
      const totalCost = pricePerToken * amount;
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, amount, fx.tokenAddr, pricePerToken);

      await fx.token.connect(fx.buyer).approve(fx.marketAddr, totalCost);
      await fx.market.connect(fx.buyer).fillListing(1n, amount);

      expect(await fx.token.balanceOf(fx.seller.address)).to.equal(totalCost);
      expect(await fx.shares.balanceOf(fx.buyer.address, fx.shopId)).to.equal(amount);
      expect(await fx.token.balanceOf(fx.marketAddr)).to.equal(0n);
    });
  });

  describe("fillListing (partial fills)", function () {
    async function listed(fx: Awaited<ReturnType<typeof deploy>>, originalAmount = 1_000n, pricePerToken = 10n ** 15n) {
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, originalAmount, ZERO, pricePerToken);
      return { originalAmount, pricePerToken };
    }

    it("(M.1) buyer A takes 200 of 1000 → remaining=800, Active", async function () {
      const fx = await deploy();
      const { pricePerToken } = await listed(fx, 1_000n);
      const cost = pricePerToken * 200n;
      await expect(fx.market.connect(fx.buyer).fillListing(1n, 200n, { value: cost }))
        .to.emit(fx.market, "ListingFilled")
        .withArgs(1n, fx.buyer.address, fx.seller.address, fx.shopId, 200n, ZERO, cost, 800n);
      const l = await fx.market.getListing(1n);
      expect(l.remainingAmount).to.equal(800n);
      expect(l.status).to.equal(ListingStatus.Active);
      expect(await fx.shares.balanceOf(fx.buyer.address, fx.shopId)).to.equal(200n);
    });

    it("(M.1) sequential A→200, B→500 leaves remaining=300, still Active", async function () {
      const fx = await deploy();
      const { pricePerToken } = await listed(fx, 1_000n);
      await fx.market.connect(fx.buyer).fillListing(1n, 200n, { value: pricePerToken * 200n });
      await fx.market.connect(fx.stranger).fillListing(1n, 500n, { value: pricePerToken * 500n });
      const l = await fx.market.getListing(1n);
      expect(l.remainingAmount).to.equal(300n);
      expect(l.status).to.equal(ListingStatus.Active);
      expect(await fx.shares.balanceOf(fx.buyer.address, fx.shopId)).to.equal(200n);
      expect(await fx.shares.balanceOf(fx.stranger.address, fx.shopId)).to.equal(500n);
    });

    it("(M.1) A→200, B→500, C→300 closes the listing (Filled, remaining=0)", async function () {
      const fx = await deploy();
      const { pricePerToken } = await listed(fx, 1_000n);
      await fx.market.connect(fx.buyer).fillListing(1n, 200n, { value: pricePerToken * 200n });
      await fx.market.connect(fx.stranger).fillListing(1n, 500n, { value: pricePerToken * 500n });
      await fx.market.connect(fx.alice).fillListing(1n, 300n, { value: pricePerToken * 300n });
      const l = await fx.market.getListing(1n);
      expect(l.remainingAmount).to.equal(0n);
      expect(l.status).to.equal(ListingStatus.Filled);
      expect(l.closedAt).to.be.greaterThan(0n);
    });

    it("(M.1) fill amount > remaining reverts FillAmountExceedsRemaining", async function () {
      const fx = await deploy();
      await listed(fx, 1_000n);
      await fx.market.connect(fx.buyer).fillListing(1n, 700n, { value: (10n ** 15n) * 700n });
      // 700 already filled; remaining=300. Requesting 400 must revert.
      await expect(
        fx.market.connect(fx.stranger).fillListing(1n, 400n, { value: (10n ** 15n) * 400n })
      )
        .to.be.revertedWithCustomError(fx.market, "FillAmountExceedsRemaining")
        .withArgs(400n, 300n);
    });

    it("(M.1) fill amount = 0 reverts AmountZero", async function () {
      const fx = await deploy();
      await listed(fx, 1_000n);
      await expect(
        fx.market.connect(fx.buyer).fillListing(1n, 0n, { value: 0n })
      ).to.be.revertedWithCustomError(fx.market, "AmountZero");
    });

    it("(M.1) totalCost = pricePerToken * amount (native): 1e15 * 300 = 3e17", async function () {
      const fx = await deploy();
      await listed(fx, 1_000n, 10n ** 15n);
      const sellerBefore = await fx.ethers.provider.getBalance(fx.seller.address);
      await fx.market.connect(fx.buyer).fillListing(1n, 300n, { value: 3n * 10n ** 17n });
      const sellerAfter = await fx.ethers.provider.getBalance(fx.seller.address);
      expect(sellerAfter - sellerBefore).to.equal(3n * 10n ** 17n);
    });

    it("(M.1) totalCost = pricePerToken * amount (ERC-20)", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 1_000n, fx.tokenAddr, 7_000n);
      // amount=120 → totalCost = 7000 * 120 = 840_000
      const expected = 7_000n * 120n;
      await fx.token.connect(fx.buyer).approve(fx.marketAddr, expected);
      await fx.market.connect(fx.buyer).fillListing(1n, 120n);
      expect(await fx.token.balanceOf(fx.seller.address)).to.equal(expected);
      expect(await fx.shares.balanceOf(fx.buyer.address, fx.shopId)).to.equal(120n);
    });

    it("(M.1) native msg.value ≠ totalCost reverts PaymentAmountMismatch", async function () {
      const fx = await deploy();
      const { pricePerToken } = await listed(fx, 1_000n);
      const correctCost = pricePerToken * 200n;
      await expect(
        fx.market.connect(fx.buyer).fillListing(1n, 200n, { value: correctCost - 1n })
      )
        .to.be.revertedWithCustomError(fx.market, "PaymentAmountMismatch")
        .withArgs(correctCost, correctCost - 1n);
    });
  });

  // -----------------------------------------------------------------------
  // fillListing failure modes
  // -----------------------------------------------------------------------
  describe("fillListing failure modes", function () {
    async function listed(fx: Awaited<ReturnType<typeof deploy>>, originalAmount = 1_000n, pricePerToken = 1n, paymentToken = ZERO) {
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, originalAmount, paymentToken, pricePerToken);
      return { originalAmount, pricePerToken };
    }

    it("ERC-20 fill: msg.value > 0 reverts PaymentAmountMismatch(0, value)", async function () {
      const fx = await deploy();
      await listed(fx, 1_000n, 5_000n, fx.tokenAddr);
      await fx.token.connect(fx.buyer).approve(fx.marketAddr, 5_000n * 100n);
      await expect(fx.market.connect(fx.buyer).fillListing(1n, 100n, { value: 1n }))
        .to.be.revertedWithCustomError(fx.market, "PaymentAmountMismatch")
        .withArgs(0n, 1n);
    });

    it("fillListing on a non-existent id reverts ListingNotFound", async function () {
      const fx = await deploy();
      await expect(fx.market.connect(fx.buyer).fillListing(999n, 1n, { value: 1n }))
        .to.be.revertedWithCustomError(fx.market, "ListingNotFound")
        .withArgs(999n);
    });

    it("fillListing on a Filled listing reverts ListingNotActive", async function () {
      const fx = await deploy();
      const { pricePerToken, originalAmount } = await listed(fx, 100n, 10n ** 15n);
      await fx.market
        .connect(fx.buyer)
        .fillListing(1n, originalAmount, { value: pricePerToken * originalAmount });
      await expect(
        fx.market.connect(fx.stranger).fillListing(1n, 1n, { value: pricePerToken })
      )
        .to.be.revertedWithCustomError(fx.market, "ListingNotActive")
        .withArgs(1n, ListingStatus.Filled);
    });

    it("fillListing on a Cancelled listing reverts ListingNotActive", async function () {
      const fx = await deploy();
      await listed(fx, 100n);
      await fx.market.connect(fx.seller).cancelListing(1n);
      await expect(fx.market.connect(fx.buyer).fillListing(1n, 1n, { value: 1n }))
        .to.be.revertedWithCustomError(fx.market, "ListingNotActive")
        .withArgs(1n, ListingStatus.Cancelled);
    });
  });

  // -----------------------------------------------------------------------
  // Cancel
  // -----------------------------------------------------------------------
  describe("cancelListing", function () {
    it("cancel by seller moves status to Cancelled, emits event", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 1_000n, ZERO, 100n);
      await expect(fx.market.connect(fx.seller).cancelListing(1n))
        .to.emit(fx.market, "ListingCancelled")
        .withArgs(1n, fx.seller.address);
      const l = await fx.market.getListing(1n);
      expect(l.status).to.equal(ListingStatus.Cancelled);
    });

    it("cancel after a partial fill is still allowed; remaining tokens stay with seller", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 1_000n, ZERO, 10n ** 15n);
      // Partial fill 400 then cancel.
      await fx.market.connect(fx.buyer).fillListing(1n, 400n, { value: (10n ** 15n) * 400n });
      const sellerSharesAfterFill = await fx.shares.balanceOf(fx.seller.address, fx.shopId);
      await fx.market.connect(fx.seller).cancelListing(1n);
      const l = await fx.market.getListing(1n);
      expect(l.status).to.equal(ListingStatus.Cancelled);
      // Seller's wallet still holds whatever didn't get filled.
      expect(await fx.shares.balanceOf(fx.seller.address, fx.shopId)).to.equal(sellerSharesAfterFill);
    });

    it("cancelListing by non-seller reverts NotListingSeller", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 100n, ZERO, 1n);
      await expect(fx.market.connect(fx.stranger).cancelListing(1n))
        .to.be.revertedWithCustomError(fx.market, "NotListingSeller")
        .withArgs(fx.stranger.address, fx.seller.address);
    });

    it("cancelListing on a Filled listing reverts ListingNotActive", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 100n, ZERO, 1n);
      await fx.market.connect(fx.buyer).fillListing(1n, 100n, { value: 100n });
      await expect(fx.market.connect(fx.seller).cancelListing(1n))
        .to.be.revertedWithCustomError(fx.market, "ListingNotActive")
        .withArgs(1n, ListingStatus.Filled);
    });

    it("cancelListing twice reverts the second call", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 100n, ZERO, 1n);
      await fx.market.connect(fx.seller).cancelListing(1n);
      await expect(fx.market.connect(fx.seller).cancelListing(1n))
        .to.be.revertedWithCustomError(fx.market, "ListingNotActive")
        .withArgs(1n, ListingStatus.Cancelled);
    });
  });

  // -----------------------------------------------------------------------
  // ShopShares interactions
  // -----------------------------------------------------------------------
  describe("ShopShares interactions", function () {
    it("fill transfers tokens from seller to buyer (balance assertion)", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 1_234n, ZERO, 1n);
      const sellerBefore: bigint = await fx.shares.balanceOf(fx.seller.address, fx.shopId);
      await fx.market.connect(fx.buyer).fillListing(1n, 1_234n, { value: 1_234n });
      expect(await fx.shares.balanceOf(fx.seller.address, fx.shopId)).to.equal(sellerBefore - 1_234n);
      expect(await fx.shares.balanceOf(fx.buyer.address, fx.shopId)).to.equal(1_234n);
    });

    it("fill triggers ShopShares._update → distributor.settle (userIndex moves)", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.distributor.connect(fx.owner).deposit(fx.shopId, { value: 1_000n });

      const indexBefore: bigint = await fx.distributor.cumulativeIndex(fx.shopId, ZERO);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 1_000n, ZERO, 1n);
      await fx.market.connect(fx.buyer).fillListing(1n, 1_000n, { value: 1_000n });

      expect(await fx.distributor.userIndex(fx.shopId, ZERO, fx.seller.address)).to.equal(indexBefore);
      expect(await fx.distributor.userIndex(fx.shopId, ZERO, fx.buyer.address)).to.equal(indexBefore);
    });

    it("phantom listing: seller moves tokens away after listing → fill reverts", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 4_000n, ZERO, 1n);
      await fx.shares
        .connect(fx.seller)
        .safeTransferFrom(fx.seller.address, fx.alice.address, fx.shopId, 5_000n, "0x");
      await expect(
        fx.market.connect(fx.buyer).fillListing(1n, 4_000n, { value: 4_000n })
      ).to.be.revertedWithCustomError(fx.shares, "ERC1155InsufficientBalance");
    });

    it("phantom listing: seller revokes approval → fill reverts", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 1_000n, ZERO, 1n);
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, false);
      await expect(
        fx.market.connect(fx.buyer).fillListing(1n, 1_000n, { value: 1_000n })
      ).to.be.revertedWithCustomError(fx.shares, "ERC1155MissingApprovalForAll");
    });
  });

  // -----------------------------------------------------------------------
  // Multi-listing
  // -----------------------------------------------------------------------
  describe("multi-listing", function () {
    it("a single seller can hold multiple active listings simultaneously", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 1_000n, ZERO, 1n);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 2_000n, fx.tokenAddr, 5n);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 1_500n, ZERO, 7n);
      expect(await fx.market.getActiveListingCount()).to.equal(3n);
    });

    it("getSellerListings returns insertion-ordered ids", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 1_000n, ZERO, 1n);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 1_000n, ZERO, 2n);
      const ids = await fx.market.getSellerListings(fx.seller.address);
      expect(ids.map((x) => Number(x))).to.deep.equal([1, 2]);
    });
  });

  // -----------------------------------------------------------------------
  // Funds conservation
  // -----------------------------------------------------------------------
  describe("funds conservation", function () {
    it("native fill: market ETH balance stays at 0 after partial fills + final fill", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      const pricePerToken = fx.ethers.parseEther("0.0001");
      await fx.market.connect(fx.seller).createListing(fx.shopId, 100n, ZERO, pricePerToken);
      await fx.market.connect(fx.buyer).fillListing(1n, 40n, { value: pricePerToken * 40n });
      expect(await fx.ethers.provider.getBalance(fx.marketAddr)).to.equal(0n);
      await fx.market.connect(fx.stranger).fillListing(1n, 60n, { value: pricePerToken * 60n });
      expect(await fx.ethers.provider.getBalance(fx.marketAddr)).to.equal(0n);
    });

    it("ERC-20 fill: market token balance stays at 0", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 100n, fx.tokenAddr, 100n);
      await fx.token.connect(fx.buyer).approve(fx.marketAddr, 100n * 100n);
      await fx.market.connect(fx.buyer).fillListing(1n, 100n);
      expect(await fx.token.balanceOf(fx.marketAddr)).to.equal(0n);
    });

    it("cancel never moves any value — market balance remains 0 throughout", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 100n, ZERO, 100n);
      expect(await fx.ethers.provider.getBalance(fx.marketAddr)).to.equal(0n);
      await fx.market.connect(fx.seller).cancelListing(1n);
      expect(await fx.ethers.provider.getBalance(fx.marketAddr)).to.equal(0n);
    });
  });

  // -----------------------------------------------------------------------
  // Pause semantics + receive
  // -----------------------------------------------------------------------
  describe("pause + receive guard", function () {
    it("when paused, createListing reverts EnforcedPause", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.owner).pause();
      await expect(
        fx.market.connect(fx.seller).createListing(fx.shopId, 100n, ZERO, 1n)
      ).to.be.revertedWithCustomError(fx.market, "EnforcedPause");
    });

    it("when paused, fillListing reverts EnforcedPause", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 100n, ZERO, 1n);
      await fx.market.connect(fx.owner).pause();
      await expect(
        fx.market.connect(fx.buyer).fillListing(1n, 100n, { value: 100n })
      ).to.be.revertedWithCustomError(fx.market, "EnforcedPause");
    });

    it("when paused, cancelListing still works (sellers can always exit)", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 100n, ZERO, 1n);
      await fx.market.connect(fx.owner).pause();
      await expect(fx.market.connect(fx.seller).cancelListing(1n))
        .to.emit(fx.market, "ListingCancelled")
        .withArgs(1n, fx.seller.address);
    });

    it("direct ETH transfer to the market reverts", async function () {
      const fx = await deploy();
      await expect(
        fx.stranger.sendTransaction({ to: fx.marketAddr, value: 1n })
      ).to.be.revertedWith("Direct ETH transfers are not allowed");
    });
  });

  // -----------------------------------------------------------------------
  // Constructor + zero-arg guards
  // -----------------------------------------------------------------------
  describe("constructor + zero guards", function () {
    it("rejects zero shares address", async function () {
      const { ethers } = await network.create();
      const Factory = await ethers.getContractFactory("ShareMarket");
      await expect(Factory.deploy(ZERO)).to.be.revertedWithCustomError(Factory, "ZeroShares");
    });
  });
});
