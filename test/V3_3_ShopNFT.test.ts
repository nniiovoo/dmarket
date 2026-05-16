import { expect } from "chai";
import { network } from "hardhat";

describe("V3.3 ShopNFT (draft)", function () {
  const ZERO = "0x0000000000000000000000000000000000000000";

  async function deploy() {
    const { ethers } = await network.create();
    const [owner, seller, buyer, recipient, stranger] = await ethers.getSigners();
    const mintFee = ethers.parseEther("0.001");
    const shopNft = await ethers.deployContract("ShopNFT", [mintFee, owner.address], owner);
    return { ethers, owner, seller, buyer, recipient, stranger, shopNft, mintFee };
  }

  // -----------------------------------------------------------------------
  // mintShop
  // -----------------------------------------------------------------------
  describe("mintShop", function () {
    it("happy path: pays fee, mints, sets ownerOf / shopIdOf / shops[]", async function () {
      const fx = await deploy();
      const tx = await fx.shopNft
        .connect(fx.seller)
        .mintShop("Smoke Shop", "test desc", "ipfs://img", { value: fx.mintFee });
      await tx.wait();

      expect(await fx.shopNft.ownerOf(1)).to.equal(fx.seller.address);
      expect(await fx.shopNft.shopIdOf(fx.seller.address)).to.equal(1n);
      expect(await fx.shopNft.nextShopId()).to.equal(2n);

      const meta = await fx.shopNft.shops(1);
      expect(meta.creator).to.equal(fx.seller.address);
      expect(meta.name).to.equal("Smoke Shop");
      expect(meta.description).to.equal("test desc");
      expect(meta.imageUrl).to.equal("ipfs://img");
      expect(meta.createdAt).to.be.greaterThan(0n);

      await expect(tx).to.emit(fx.shopNft, "ShopCreated").withArgs(1n, fx.seller.address, "Smoke Shop");
    });

    it("reverts when msg.value < mintFeeWei", async function () {
      const fx = await deploy();
      await expect(
        fx.shopNft.connect(fx.seller).mintShop("X", "", "", { value: fx.mintFee - 1n })
      ).to.be.revertedWithCustomError(fx.shopNft, "InsufficientMintFee");
    });

    it("refunds over-payment to msg.sender", async function () {
      const fx = await deploy();
      const overPay = fx.mintFee + fx.ethers.parseEther("0.5");

      const balBefore = await fx.ethers.provider.getBalance(fx.seller.address);
      const tx = await fx.shopNft
        .connect(fx.seller)
        .mintShop("X", "", "", { value: overPay });
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;
      const balAfter = await fx.ethers.provider.getBalance(fx.seller.address);

      // Spent = mintFee + gas; over-payment is refunded.
      expect(balBefore - balAfter).to.equal(fx.mintFee + gasCost);
    });

    it("reverts when the caller already owns a shop (AlreadyOwnsShop)", async function () {
      const fx = await deploy();
      await fx.shopNft.connect(fx.seller).mintShop("S1", "", "", { value: fx.mintFee });
      await expect(
        fx.shopNft.connect(fx.seller).mintShop("S2", "", "", { value: fx.mintFee })
      )
        .to.be.revertedWithCustomError(fx.shopNft, "AlreadyOwnsShop")
        .withArgs(fx.seller.address);
    });

    it("forwards the mint fee to feeRecipient", async function () {
      const fx = await deploy();
      // Swap feeRecipient to a fresh signer so we can isolate the credit.
      await fx.shopNft.connect(fx.owner).setFeeRecipient(fx.recipient.address);

      const balBefore = await fx.ethers.provider.getBalance(fx.recipient.address);
      await fx.shopNft.connect(fx.seller).mintShop("S", "", "", { value: fx.mintFee });
      const balAfter = await fx.ethers.provider.getBalance(fx.recipient.address);

      expect(balAfter - balBefore).to.equal(fx.mintFee);
    });
  });

  // -----------------------------------------------------------------------
  // adminMint
  // -----------------------------------------------------------------------
  describe("adminMint", function () {
    it("owner can adminMint with no fee", async function () {
      const fx = await deploy();
      const tx = await fx.shopNft
        .connect(fx.owner)
        .adminMint(fx.seller.address, "Imported", "from v3.2", "");
      await tx.wait();

      expect(await fx.shopNft.shopIdOf(fx.seller.address)).to.equal(1n);
      expect(await fx.shopNft.ownerOf(1)).to.equal(fx.seller.address);
      const meta = await fx.shopNft.shops(1);
      expect(meta.creator).to.equal(fx.seller.address);
      expect(meta.name).to.equal("Imported");
    });

    it("non-owner cannot adminMint", async function () {
      const fx = await deploy();
      await expect(
        fx.shopNft.connect(fx.stranger).adminMint(fx.seller.address, "S", "", "")
      ).to.be.revertedWithCustomError(fx.shopNft, "OwnableUnauthorizedAccount");
    });

    it("adminMint reverts when recipient already owns a shop", async function () {
      const fx = await deploy();
      await fx.shopNft.connect(fx.owner).adminMint(fx.seller.address, "S1", "", "");
      await expect(
        fx.shopNft.connect(fx.owner).adminMint(fx.seller.address, "S2", "", "")
      ).to.be.revertedWithCustomError(fx.shopNft, "AlreadyOwnsShop");
    });
  });

  // -----------------------------------------------------------------------
  // Transfer
  // -----------------------------------------------------------------------
  describe("transfer", function () {
    it("transferFrom: shopIdOf migrates from sender to recipient", async function () {
      const fx = await deploy();
      await fx.shopNft.connect(fx.seller).mintShop("S", "", "", { value: fx.mintFee });

      await fx.shopNft
        .connect(fx.seller)
        .transferFrom(fx.seller.address, fx.recipient.address, 1n);

      expect(await fx.shopNft.ownerOf(1)).to.equal(fx.recipient.address);
      expect(await fx.shopNft.shopIdOf(fx.seller.address)).to.equal(0n);
      expect(await fx.shopNft.shopIdOf(fx.recipient.address)).to.equal(1n);
    });

    it("safeTransferFrom: shopIdOf migrates", async function () {
      const fx = await deploy();
      await fx.shopNft.connect(fx.seller).mintShop("S", "", "", { value: fx.mintFee });

      await fx.shopNft
        .connect(fx.seller)
        ["safeTransferFrom(address,address,uint256)"](fx.seller.address, fx.recipient.address, 1n);

      expect(await fx.shopNft.shopIdOf(fx.seller.address)).to.equal(0n);
      expect(await fx.shopNft.shopIdOf(fx.recipient.address)).to.equal(1n);
    });

    it("transfer to an address that already owns a shop reverts", async function () {
      const fx = await deploy();
      await fx.shopNft.connect(fx.seller).mintShop("S1", "", "", { value: fx.mintFee });
      await fx.shopNft.connect(fx.recipient).mintShop("S2", "", "", { value: fx.mintFee });

      await expect(
        fx.shopNft
          .connect(fx.seller)
          .transferFrom(fx.seller.address, fx.recipient.address, 1n)
      )
        .to.be.revertedWithCustomError(fx.shopNft, "AlreadyOwnsShop")
        .withArgs(fx.recipient.address);
    });

    it("approve + transferFrom by a third-party spender still migrates shopIdOf", async function () {
      const fx = await deploy();
      await fx.shopNft.connect(fx.seller).mintShop("S", "", "", { value: fx.mintFee });
      await fx.shopNft.connect(fx.seller).approve(fx.buyer.address, 1n);

      await fx.shopNft
        .connect(fx.buyer)
        .transferFrom(fx.seller.address, fx.recipient.address, 1n);

      expect(await fx.shopNft.shopIdOf(fx.seller.address)).to.equal(0n);
      expect(await fx.shopNft.shopIdOf(fx.recipient.address)).to.equal(1n);
      expect(await fx.shopNft.shopIdOf(fx.buyer.address)).to.equal(0n);
    });

    it("transfer to zero address reverts (ERC-721 default)", async function () {
      const fx = await deploy();
      await fx.shopNft.connect(fx.seller).mintShop("S", "", "", { value: fx.mintFee });
      await expect(
        fx.shopNft.connect(fx.seller).transferFrom(fx.seller.address, ZERO, 1n)
      ).to.be.revertedWithCustomError(fx.shopNft, "ERC721InvalidReceiver");
    });
  });

  // -----------------------------------------------------------------------
  // updateShopMeta
  // -----------------------------------------------------------------------
  describe("updateShopMeta", function () {
    it("owner can update mutable fields", async function () {
      const fx = await deploy();
      await fx.shopNft.connect(fx.seller).mintShop("Old", "old desc", "old.png", { value: fx.mintFee });
      const tx = await fx.shopNft.connect(fx.seller).updateShopMeta(1n, "New", "new desc", "new.png");
      await tx.wait();

      const meta = await fx.shopNft.shops(1);
      expect(meta.name).to.equal("New");
      expect(meta.description).to.equal("new desc");
      expect(meta.imageUrl).to.equal("new.png");

      await expect(tx)
        .to.emit(fx.shopNft, "ShopMetadataUpdated")
        .withArgs(1n, "New", "new desc", "new.png");
    });

    it("non-owner cannot update", async function () {
      const fx = await deploy();
      await fx.shopNft.connect(fx.seller).mintShop("X", "", "", { value: fx.mintFee });
      await expect(
        fx.shopNft.connect(fx.stranger).updateShopMeta(1n, "Hijacked", "", "")
      )
        .to.be.revertedWithCustomError(fx.shopNft, "NotShopOwner")
        .withArgs(fx.stranger.address, 1n);
    });

    it("does not modify creator or createdAt", async function () {
      const fx = await deploy();
      await fx.shopNft.connect(fx.seller).mintShop("X", "", "", { value: fx.mintFee });
      const before = await fx.shopNft.shops(1);
      await fx.shopNft.connect(fx.seller).updateShopMeta(1n, "Y", "z", "u");
      const after = await fx.shopNft.shops(1);
      expect(after.creator).to.equal(before.creator);
      expect(after.createdAt).to.equal(before.createdAt);
    });
  });

  // -----------------------------------------------------------------------
  // Owner admin
  // -----------------------------------------------------------------------
  describe("owner admin", function () {
    it("setMintFee updates the fee and emits MintFeeUpdated", async function () {
      const fx = await deploy();
      const newFee = fx.ethers.parseEther("0.01");
      await expect(fx.shopNft.connect(fx.owner).setMintFee(newFee))
        .to.emit(fx.shopNft, "MintFeeUpdated")
        .withArgs(fx.mintFee, newFee);
      expect(await fx.shopNft.mintFeeWei()).to.equal(newFee);
    });

    it("setFeeRecipient rejects zero address", async function () {
      const fx = await deploy();
      await expect(
        fx.shopNft.connect(fx.owner).setFeeRecipient(ZERO)
      ).to.be.revertedWithCustomError(fx.shopNft, "ZeroAddress");
    });

    it("Ownable2Step requires acceptOwnership", async function () {
      const fx = await deploy();
      await fx.shopNft.connect(fx.owner).transferOwnership(fx.stranger.address);
      // Until acceptOwnership runs, the original owner is still in control.
      expect(await fx.shopNft.owner()).to.equal(fx.owner.address);
      await fx.shopNft.connect(fx.stranger).acceptOwnership();
      expect(await fx.shopNft.owner()).to.equal(fx.stranger.address);
    });
  });

  // -----------------------------------------------------------------------
  // Funds accounting
  // -----------------------------------------------------------------------
  describe("funds accounting", function () {
    it("after a successful mint, the contract holds zero balance", async function () {
      const fx = await deploy();
      // Direct fee to a non-owner so the owner's gas accounting doesn't
      // confuse the balance read.
      await fx.shopNft.connect(fx.owner).setFeeRecipient(fx.recipient.address);
      await fx.shopNft.connect(fx.seller).mintShop("S", "", "", { value: fx.mintFee });
      expect(await fx.ethers.provider.getBalance(await fx.shopNft.getAddress())).to.equal(0n);
    });

    it("feeRecipient receives the cumulative fees from multiple mints", async function () {
      const fx = await deploy();
      await fx.shopNft.connect(fx.owner).setFeeRecipient(fx.recipient.address);
      const before = await fx.ethers.provider.getBalance(fx.recipient.address);

      await fx.shopNft.connect(fx.seller).mintShop("A", "", "", { value: fx.mintFee });
      await fx.shopNft.connect(fx.buyer).mintShop("B", "", "", { value: fx.mintFee });
      await fx.shopNft.connect(fx.stranger).mintShop("C", "", "", { value: fx.mintFee });

      const after = await fx.ethers.provider.getBalance(fx.recipient.address);
      expect(after - before).to.equal(fx.mintFee * 3n);
    });
  });
});
