import { expect } from "chai";
import { network } from "hardhat";

describe("V3.3 ShareMarket (draft)", function () {
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
    // K.3a wiring is NOT needed for K.4 tests; transfers work without a
    // settler. We deploy the distributor + wire for the "settle is
    // triggered on fill" test, but most tests run without it.
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

    // seller mints shop #1 + initialises 10 000 shares.
    await shopNft.connect(seller).mintShop("S Shop", "", "", { value: SHOP_MINT_FEE });
    const shopId: bigint = await shopNft.shopIdOf(seller.address);
    await shares.connect(seller).initializeShares(shopId);
    // Move 5 000 to alice so seller has a meaningful balance left.
    await shares
      .connect(seller)
      .safeTransferFrom(seller.address, alice.address, shopId, 5_000n, "0x");

    const token = await ethers.deployContract("TestERC20", ["Mock USDC", "mUSDC", 6], owner);
    const tokenAddr = await token.getAddress();
    await token.mint(buyer.address, 10_000_000n);

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
  // Lifecycle
  // -----------------------------------------------------------------------
  describe("createListing + fillListing happy paths", function () {
    it("create + fill native: seller gets ETH, buyer gets shares, market untouched", async function () {
      const fx = await deploy();
      const price = fx.ethers.parseEther("0.5");
      const amount = 2_000n;
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);

      await expect(
        fx.market.connect(fx.seller).createListing(fx.shopId, amount, ZERO, price)
      )
        .to.emit(fx.market, "ListingCreated")
        .withArgs(1n, fx.seller.address, fx.shopId, amount, ZERO, price);

      const sellerBefore = await fx.ethers.provider.getBalance(fx.seller.address);
      await expect(
        fx.market.connect(fx.buyer).fillListing(1n, { value: price })
      )
        .to.emit(fx.market, "ListingFilled")
        .withArgs(1n, fx.buyer.address, fx.seller.address, fx.shopId, amount, ZERO, price);
      const sellerAfter = await fx.ethers.provider.getBalance(fx.seller.address);

      expect(sellerAfter - sellerBefore).to.equal(price);
      expect(await fx.shares.balanceOf(fx.buyer.address, fx.shopId)).to.equal(amount);
      const listing = await fx.market.getListing(1n);
      expect(listing.status).to.equal(ListingStatus.Filled);
      expect(await fx.ethers.provider.getBalance(fx.marketAddr)).to.equal(0n);
    });

    it("create + fill ERC-20: seller gets tokens, buyer gets shares, market untouched", async function () {
      const fx = await deploy();
      const price = 5_000_000n; // 5 mUSDC
      const amount = 1_500n;
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, amount, fx.tokenAddr, price);

      await fx.token.connect(fx.buyer).approve(fx.marketAddr, price);
      await fx.market.connect(fx.buyer).fillListing(1n);

      expect(await fx.token.balanceOf(fx.seller.address)).to.equal(price);
      expect(await fx.shares.balanceOf(fx.buyer.address, fx.shopId)).to.equal(amount);
      expect(await fx.token.balanceOf(fx.marketAddr)).to.equal(0n);
    });

    it("cancel by seller moves status to Cancelled, emits event", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 1_000n, ZERO, 100n);
      await expect(fx.market.connect(fx.seller).cancelListing(1n))
        .to.emit(fx.market, "ListingCancelled")
        .withArgs(1n, fx.seller.address);
      const listing = await fx.market.getListing(1n);
      expect(listing.status).to.equal(ListingStatus.Cancelled);
    });

    it("createListing without setApprovalForAll reverts MarketNotApproved", async function () {
      const fx = await deploy();
      await expect(
        fx.market.connect(fx.seller).createListing(fx.shopId, 100n, ZERO, 1n)
      )
        .to.be.revertedWithCustomError(fx.market, "MarketNotApproved")
        .withArgs(fx.seller.address);
    });

    it("createListing for more shares than seller holds reverts InsufficientShares", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      // seller currently holds 5 000 — list 6 000.
      await expect(
        fx.market.connect(fx.seller).createListing(fx.shopId, 6_000n, ZERO, 1n)
      )
        .to.be.revertedWithCustomError(fx.market, "InsufficientShares")
        .withArgs(fx.seller.address, fx.shopId, 5_000n, 6_000n);
    });
  });

  // -----------------------------------------------------------------------
  // Fill failure modes
  // -----------------------------------------------------------------------
  describe("fillListing failure modes", function () {
    async function listed(fx: Awaited<ReturnType<typeof deploy>>, price = 100n, amount = 1_000n, paymentToken = ZERO) {
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, amount, paymentToken, price);
      return { price, amount };
    }

    it("native fill: msg.value mismatch reverts PaymentAmountMismatch", async function () {
      const fx = await deploy();
      const { price } = await listed(fx, fx.ethers.parseEther("0.5"));
      await expect(
        fx.market.connect(fx.buyer).fillListing(1n, { value: price - 1n })
      )
        .to.be.revertedWithCustomError(fx.market, "PaymentAmountMismatch")
        .withArgs(price, price - 1n);
    });

    it("ERC-20 fill: msg.value > 0 reverts PaymentAmountMismatch(0, value)", async function () {
      const fx = await deploy();
      await listed(fx, 5_000_000n, 1_000n, fx.tokenAddr);
      await fx.token.connect(fx.buyer).approve(fx.marketAddr, 5_000_000n);
      await expect(fx.market.connect(fx.buyer).fillListing(1n, { value: 1n }))
        .to.be.revertedWithCustomError(fx.market, "PaymentAmountMismatch")
        .withArgs(0n, 1n);
    });

    it("fillListing on a non-existent id reverts ListingNotFound", async function () {
      const fx = await deploy();
      await expect(fx.market.connect(fx.buyer).fillListing(999n))
        .to.be.revertedWithCustomError(fx.market, "ListingNotFound")
        .withArgs(999n);
    });

    it("fillListing on a Filled listing reverts ListingNotActive", async function () {
      const fx = await deploy();
      const { price } = await listed(fx, fx.ethers.parseEther("0.1"));
      await fx.market.connect(fx.buyer).fillListing(1n, { value: price });
      await expect(fx.market.connect(fx.stranger).fillListing(1n, { value: price }))
        .to.be.revertedWithCustomError(fx.market, "ListingNotActive")
        .withArgs(1n, ListingStatus.Filled);
    });

    it("fillListing on a Cancelled listing reverts ListingNotActive", async function () {
      const fx = await deploy();
      const { price } = await listed(fx, 100n);
      await fx.market.connect(fx.seller).cancelListing(1n);
      await expect(fx.market.connect(fx.buyer).fillListing(1n, { value: price }))
        .to.be.revertedWithCustomError(fx.market, "ListingNotActive")
        .withArgs(1n, ListingStatus.Cancelled);
    });
  });

  // -----------------------------------------------------------------------
  // Cancel failure modes
  // -----------------------------------------------------------------------
  describe("cancelListing failure modes", function () {
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
      await fx.market.connect(fx.buyer).fillListing(1n, { value: 1n });
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
    it("fill transfers shares from seller to buyer (balance assertion)", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 1_234n, ZERO, 1n);
      const sellerSharesBefore: bigint = await fx.shares.balanceOf(fx.seller.address, fx.shopId);
      await fx.market.connect(fx.buyer).fillListing(1n, { value: 1n });
      expect(await fx.shares.balanceOf(fx.seller.address, fx.shopId)).to.equal(
        sellerSharesBefore - 1_234n
      );
      expect(await fx.shares.balanceOf(fx.buyer.address, fx.shopId)).to.equal(1_234n);
    });

    it("fill triggers ShopShares._update → distributor.settle (userIndex moves)", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      // Make sure the distributor knows about the native token for this
      // shopId — otherwise the settle loop is a no-op and we can't
      // observe the userIndex move. We do it by sending a tiny deposit
      // from the owner who is implicitly authorised.
      await fx.distributor.connect(fx.owner).deposit(fx.shopId, { value: 1_000n });

      const indexBefore: bigint = await fx.distributor.cumulativeIndex(fx.shopId, ZERO);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 1_000n, ZERO, 1n);
      await fx.market.connect(fx.buyer).fillListing(1n, { value: 1n });

      // After settle, seller's userIndex should match cumulativeIndex —
      // proof the settler was reached during _update.
      expect(await fx.distributor.userIndex(fx.shopId, ZERO, fx.seller.address)).to.equal(
        indexBefore
      );
      expect(await fx.distributor.userIndex(fx.shopId, ZERO, fx.buyer.address)).to.equal(
        indexBefore
      );
    });

    it("phantom listing: seller moves shares away after listing → fill reverts", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 4_000n, ZERO, 1n);
      // seller dumps everything to alice — balance now 0.
      await fx.shares
        .connect(fx.seller)
        .safeTransferFrom(fx.seller.address, fx.alice.address, fx.shopId, 5_000n, "0x");
      await expect(
        fx.market.connect(fx.buyer).fillListing(1n, { value: 1n })
      ).to.be.revertedWithCustomError(fx.shares, "ERC1155InsufficientBalance");
    });

    it("phantom listing: seller revokes approval → fill reverts", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 1_000n, ZERO, 1n);
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, false);
      await expect(
        fx.market.connect(fx.buyer).fillListing(1n, { value: 1n })
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
    it("native fill: market ETH balance stays at 0", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      const price = fx.ethers.parseEther("0.25");
      await fx.market.connect(fx.seller).createListing(fx.shopId, 100n, ZERO, price);
      await fx.market.connect(fx.buyer).fillListing(1n, { value: price });
      expect(await fx.ethers.provider.getBalance(fx.marketAddr)).to.equal(0n);
    });

    it("ERC-20 fill: market token balance stays at 0", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await fx.market.connect(fx.seller).createListing(fx.shopId, 100n, fx.tokenAddr, 100n);
      await fx.token.connect(fx.buyer).approve(fx.marketAddr, 100n);
      await fx.market.connect(fx.buyer).fillListing(1n);
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
        fx.market.connect(fx.buyer).fillListing(1n, { value: 1n })
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

    it("createListing(amount=0) reverts AmountZero", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await expect(
        fx.market.connect(fx.seller).createListing(fx.shopId, 0n, ZERO, 1n)
      ).to.be.revertedWithCustomError(fx.market, "AmountZero");
    });

    it("createListing(totalPrice=0) reverts PriceZero", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.seller).setApprovalForAll(fx.marketAddr, true);
      await expect(
        fx.market.connect(fx.seller).createListing(fx.shopId, 100n, ZERO, 0n)
      ).to.be.revertedWithCustomError(fx.market, "PriceZero");
    });
  });
});
