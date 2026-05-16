import { expect } from "chai";
import { network } from "hardhat";

describe("V3.3 ShopShares (draft)", function () {
  const ZERO = "0x0000000000000000000000000000000000000000";
  const BASE_URI = "https://chainus.org/api/shop-shares/{id}.json";

  async function deploy() {
    const { ethers } = await network.create();
    const [owner, sellerA, sellerB, holderX, holderY, stranger] = await ethers.getSigners();
    const mintFee = ethers.parseEther("0.001");

    const shopNft = await ethers.deployContract("ShopNFT", [mintFee, owner.address], owner);
    const shares = await ethers.deployContract(
      "ShopShares",
      [await shopNft.getAddress(), BASE_URI],
      owner
    );

    // sellerA owns shopId 1; sellerB owns shopId 2. Both via self-mint
    // so the K.2 tests exercise the same path real users would.
    await shopNft.connect(sellerA).mintShop("A", "", "", { value: mintFee });
    await shopNft.connect(sellerB).mintShop("B", "", "", { value: mintFee });

    return {
      ethers,
      owner,
      sellerA,
      sellerB,
      holderX,
      holderY,
      stranger,
      shopNft,
      shares,
      mintFee,
      shopIdA: 1n,
      shopIdB: 2n
    };
  }

  // -----------------------------------------------------------------------
  // initialization
  // -----------------------------------------------------------------------
  describe("initializeShares", function () {
    it("happy path: shop owner mints TOTAL_SUPPLY to themselves and event fires", async function () {
      const fx = await deploy();
      const total: bigint = await fx.shares.TOTAL_SUPPLY();
      const tx = await fx.shares.connect(fx.sellerA).initializeShares(fx.shopIdA);
      await tx.wait();

      expect(await fx.shares.balanceOf(fx.sellerA.address, fx.shopIdA)).to.equal(total);
      expect(await fx.shares.initialized(fx.shopIdA)).to.equal(true);
      expect(await fx.shares.totalSupplyOf(fx.shopIdA)).to.equal(total);

      await expect(tx)
        .to.emit(fx.shares, "SharesInitialized")
        .withArgs(fx.shopIdA, fx.sellerA.address);
    });

    it("reverts with ShopNotFound for a shopId that has not been minted", async function () {
      const fx = await deploy();
      const missing = 999n;
      await expect(fx.shares.connect(fx.sellerA).initializeShares(missing))
        .to.be.revertedWithCustomError(fx.shares, "ShopNotFound")
        .withArgs(missing);
    });

    it("reverts with NotShopOwner when caller does not own the ShopNFT", async function () {
      const fx = await deploy();
      await expect(fx.shares.connect(fx.stranger).initializeShares(fx.shopIdA))
        .to.be.revertedWithCustomError(fx.shares, "NotShopOwner")
        .withArgs(fx.stranger.address, fx.sellerA.address);
    });

    it("re-initialize on an already-initialized shopId reverts with AlreadyInitialized", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.sellerA).initializeShares(fx.shopIdA);
      await expect(fx.shares.connect(fx.sellerA).initializeShares(fx.shopIdA))
        .to.be.revertedWithCustomError(fx.shares, "AlreadyInitialized")
        .withArgs(fx.shopIdA);
    });

    it("new ShopNFT owner can initialize when the previous owner did not", async function () {
      const fx = await deploy();
      const total: bigint = await fx.shares.TOTAL_SUPPLY();
      // sellerA transfers shopId 1 to holderX before any initialize.
      await fx.shopNft.connect(fx.sellerA).transferFrom(fx.sellerA.address, fx.holderX.address, fx.shopIdA);
      // sellerA can no longer initialize.
      await expect(fx.shares.connect(fx.sellerA).initializeShares(fx.shopIdA))
        .to.be.revertedWithCustomError(fx.shares, "NotShopOwner")
        .withArgs(fx.sellerA.address, fx.holderX.address);
      // holderX (the new ShopNFT owner) can.
      await fx.shares.connect(fx.holderX).initializeShares(fx.shopIdA);
      expect(await fx.shares.balanceOf(fx.holderX.address, fx.shopIdA)).to.equal(total);
    });
  });

  // -----------------------------------------------------------------------
  // ERC-1155 transfer surface
  // -----------------------------------------------------------------------
  describe("transfer", function () {
    async function initializedFx() {
      const fx = await deploy();
      await fx.shares.connect(fx.sellerA).initializeShares(fx.shopIdA);
      await fx.shares.connect(fx.sellerB).initializeShares(fx.shopIdB);
      return fx;
    }

    it("safeTransferFrom moves shares between holders", async function () {
      const fx = await initializedFx();
      await fx.shares
        .connect(fx.sellerA)
        .safeTransferFrom(fx.sellerA.address, fx.holderX.address, fx.shopIdA, 250n, "0x");
      expect(await fx.shares.balanceOf(fx.sellerA.address, fx.shopIdA)).to.equal(9_750n);
      expect(await fx.shares.balanceOf(fx.holderX.address, fx.shopIdA)).to.equal(250n);
    });

    it("safeBatchTransferFrom moves multiple shopIds in one tx", async function () {
      const fx = await initializedFx();
      // sellerA owns 10k of shopId 1; sellerB owns 10k of shopId 2. To
      // batch, give sellerA 100 of shopId 2 first so they hold both.
      await fx.shares
        .connect(fx.sellerB)
        .safeTransferFrom(fx.sellerB.address, fx.sellerA.address, fx.shopIdB, 100n, "0x");

      await fx.shares
        .connect(fx.sellerA)
        .safeBatchTransferFrom(
          fx.sellerA.address,
          fx.holderX.address,
          [fx.shopIdA, fx.shopIdB],
          [500n, 60n],
          "0x"
        );
      expect(await fx.shares.balanceOf(fx.holderX.address, fx.shopIdA)).to.equal(500n);
      expect(await fx.shares.balanceOf(fx.holderX.address, fx.shopIdB)).to.equal(60n);
    });

    it("setApprovalForAll lets a third party move shares on the owner's behalf", async function () {
      const fx = await initializedFx();
      await fx.shares.connect(fx.sellerA).setApprovalForAll(fx.stranger.address, true);
      await fx.shares
        .connect(fx.stranger)
        .safeTransferFrom(fx.sellerA.address, fx.holderX.address, fx.shopIdA, 75n, "0x");
      expect(await fx.shares.balanceOf(fx.holderX.address, fx.shopIdA)).to.equal(75n);
    });

    it("balanceOfBatch returns the holders' balances in input order", async function () {
      const fx = await initializedFx();
      const balances = await fx.shares.balanceOfBatch(
        [fx.sellerA.address, fx.sellerB.address, fx.holderX.address],
        [fx.shopIdA, fx.shopIdB, fx.shopIdA]
      );
      expect(balances[0]).to.equal(10_000n);
      expect(balances[1]).to.equal(10_000n);
      expect(balances[2]).to.equal(0n);
    });

    it("totalSupplyOf stays at 10_000 after transfers", async function () {
      const fx = await initializedFx();
      await fx.shares
        .connect(fx.sellerA)
        .safeTransferFrom(fx.sellerA.address, fx.holderX.address, fx.shopIdA, 3_333n, "0x");
      expect(await fx.shares.totalSupplyOf(fx.shopIdA)).to.equal(10_000n);
    });
  });

  // -----------------------------------------------------------------------
  // independence from ShopNFT ownership
  // -----------------------------------------------------------------------
  describe("decoupled from ShopNFT", function () {
    it("transferring the ShopNFT does not move shares", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.sellerA).initializeShares(fx.shopIdA);

      // sellerA hands the ShopNFT to holderX.
      await fx.shopNft.connect(fx.sellerA).transferFrom(fx.sellerA.address, fx.holderX.address, fx.shopIdA);

      // Shares stayed with sellerA.
      expect(await fx.shares.balanceOf(fx.sellerA.address, fx.shopIdA)).to.equal(10_000n);
      expect(await fx.shares.balanceOf(fx.holderX.address, fx.shopIdA)).to.equal(0n);
    });

    it("new ShopNFT owner does not receive shares automatically", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.sellerA).initializeShares(fx.shopIdA);
      await fx.shopNft.connect(fx.sellerA).transferFrom(fx.sellerA.address, fx.holderX.address, fx.shopIdA);
      // Nothing has been minted to holderX, anywhere.
      expect(await fx.shares.balanceOf(fx.holderX.address, fx.shopIdA)).to.equal(0n);
    });

    it("new ShopNFT owner cannot re-initialize an already-initialized shopId", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.sellerA).initializeShares(fx.shopIdA);
      await fx.shopNft.connect(fx.sellerA).transferFrom(fx.sellerA.address, fx.holderX.address, fx.shopIdA);
      await expect(fx.shares.connect(fx.holderX).initializeShares(fx.shopIdA))
        .to.be.revertedWithCustomError(fx.shares, "AlreadyInitialized")
        .withArgs(fx.shopIdA);
    });
  });

  // -----------------------------------------------------------------------
  // owner admin
  // -----------------------------------------------------------------------
  describe("owner admin", function () {
    it("setURI by non-owner reverts", async function () {
      const fx = await deploy();
      await expect(
        fx.shares.connect(fx.stranger).setURI("https://chainus.org/api/v2/{id}")
      ).to.be.revertedWithCustomError(fx.shares, "OwnableUnauthorizedAccount");
    });
  });

  // -----------------------------------------------------------------------
  // invariants
  // -----------------------------------------------------------------------
  describe("supply invariants", function () {
    it("the contract exposes no mint/burn entry point — sum of balances == 10_000 across an arbitrary holder set", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.sellerA).initializeShares(fx.shopIdA);

      // Split shopA across 4 holders. Sum must stay at 10_000.
      await fx.shares
        .connect(fx.sellerA)
        .safeTransferFrom(fx.sellerA.address, fx.holderX.address, fx.shopIdA, 4_000n, "0x");
      await fx.shares
        .connect(fx.sellerA)
        .safeTransferFrom(fx.sellerA.address, fx.holderY.address, fx.shopIdA, 1_500n, "0x");
      await fx.shares
        .connect(fx.sellerA)
        .safeTransferFrom(fx.sellerA.address, fx.stranger.address, fx.shopIdA, 500n, "0x");

      const sum =
        (await fx.shares.balanceOf(fx.sellerA.address, fx.shopIdA)) +
        (await fx.shares.balanceOf(fx.holderX.address, fx.shopIdA)) +
        (await fx.shares.balanceOf(fx.holderY.address, fx.shopIdA)) +
        (await fx.shares.balanceOf(fx.stranger.address, fx.shopIdA));
      expect(sum).to.equal(10_000n);
    });

    it("multiple shopIds coexist with their own 10_000 supplies", async function () {
      const fx = await deploy();
      await fx.shares.connect(fx.sellerA).initializeShares(fx.shopIdA);
      await fx.shares.connect(fx.sellerB).initializeShares(fx.shopIdB);
      expect(await fx.shares.totalSupplyOf(fx.shopIdA)).to.equal(10_000n);
      expect(await fx.shares.totalSupplyOf(fx.shopIdB)).to.equal(10_000n);
      // Sums are independent.
      expect(await fx.shares.balanceOf(fx.sellerA.address, fx.shopIdA)).to.equal(10_000n);
      expect(await fx.shares.balanceOf(fx.sellerA.address, fx.shopIdB)).to.equal(0n);
      expect(await fx.shares.balanceOf(fx.sellerB.address, fx.shopIdB)).to.equal(10_000n);
      expect(await fx.shares.balanceOf(fx.sellerB.address, fx.shopIdA)).to.equal(0n);
    });
  });

  // -----------------------------------------------------------------------
  // constructor guard
  // -----------------------------------------------------------------------
  describe("constructor", function () {
    it("rejects a zero ShopNFT address", async function () {
      const { ethers } = await network.create();
      const Factory = await ethers.getContractFactory("ShopShares");
      await expect(Factory.deploy(ZERO, BASE_URI)).to.be.revertedWithCustomError(
        Factory,
        "ZeroShopNFT"
      );
    });
  });

  // -----------------------------------------------------------------------
  // settler hook (K.3a)
  // -----------------------------------------------------------------------
  describe("settler hook", function () {
    it("setSettler by owner updates the field and emits SettlerUpdated", async function () {
      const fx = await deploy();
      const mock = await fx.ethers.deployContract("MockShareSettler", [], fx.owner);
      const mockAddress = await mock.getAddress();
      await expect(fx.shares.connect(fx.owner).setSettler(mockAddress))
        .to.emit(fx.shares, "SettlerUpdated")
        .withArgs(ZERO, mockAddress);
      expect(await fx.shares.settler()).to.equal(mockAddress);
    });

    it("setSettler by non-owner reverts", async function () {
      const fx = await deploy();
      await expect(fx.shares.connect(fx.stranger).setSettler(fx.stranger.address))
        .to.be.revertedWithCustomError(fx.shares, "OwnableUnauthorizedAccount");
    });

    it("transfer with settler set: settle() is called for from and to pre-balance change", async function () {
      const fx = await deploy();
      const mock = await fx.ethers.deployContract("MockShareSettler", [], fx.owner);
      await fx.shares.connect(fx.owner).setSettler(await mock.getAddress());

      // sellerA initializes shopId 1 → triggers settle for `to=sellerA`
      // (mint side); `from` is address(0) so it is skipped.
      await fx.shares.connect(fx.sellerA).initializeShares(fx.shopIdA);
      expect(await mock.callCount()).to.equal(1n);
      {
        const [shopId, holder] = await mock.getCall(0);
        expect(shopId).to.equal(fx.shopIdA);
        expect(holder).to.equal(fx.sellerA.address);
      }

      // Real transfer: both sides must be settled.
      await fx.shares
        .connect(fx.sellerA)
        .safeTransferFrom(fx.sellerA.address, fx.holderX.address, fx.shopIdA, 500n, "0x");
      expect(await mock.callCount()).to.equal(3n);
      const [shop1, h1] = await mock.getCall(1);
      const [shop2, h2] = await mock.getCall(2);
      expect(shop1).to.equal(fx.shopIdA);
      expect(h1).to.equal(fx.sellerA.address);
      expect(shop2).to.equal(fx.shopIdA);
      expect(h2).to.equal(fx.holderX.address);
    });
  });
});
