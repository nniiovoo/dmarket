import { expect } from "chai";
import { network } from "hardhat";

describe("V3.3 RevenueDistributor (draft)", function () {
  const ZERO = "0x0000000000000000000000000000000000000000";
  const BASE_URI = "https://chainus.org/api/shop-shares/{id}.json";

  async function deploy() {
    const { ethers } = await network.create();
    const [owner, alice, bob, carol, stranger, depositor] = await ethers.getSigners();
    const mintFee = ethers.parseEther("0.001");

    const shopNft = await ethers.deployContract("ShopNFT", [mintFee, owner.address], owner);
    const shares = await ethers.deployContract(
      "ShopShares",
      [await shopNft.getAddress(), BASE_URI],
      owner
    );
    const distributor = await ethers.deployContract(
      "RevenueDistributor",
      [await shares.getAddress()],
      owner
    );

    // Wire: shares → distributor.settle on every transfer.
    await shares.connect(owner).setSettler(await distributor.getAddress());

    // Authorise the dedicated `depositor` signer (mirrors how K.3b will
    // authorise the marketplace contract).
    await distributor.connect(owner).setAuthorizedDepositor(depositor.address, true);

    // Two shops:
    //   shopId 1: alice owns the NFT, alice initializes shares (10000 to alice)
    //   shopId 2: bob owns the NFT, bob initializes shares (10000 to bob)
    await shopNft.connect(alice).mintShop("Alice's Shop", "", "", { value: mintFee });
    await shopNft.connect(bob).mintShop("Bob's Shop", "", "", { value: mintFee });
    await shares.connect(alice).initializeShares(1n);
    await shares.connect(bob).initializeShares(2n);

    const erc20 = await ethers.deployContract("MockERC20", ["Mock USDC", "mUSDC", 6], owner);
    await erc20.connect(owner).mint(depositor.address, 1_000_000n * 10n ** 6n);
    // depositor must approve the distributor for ERC-20 deposits.
    await erc20.connect(depositor).approve(await distributor.getAddress(), 2n ** 256n - 1n);

    return {
      ethers,
      owner,
      alice,
      bob,
      carol,
      stranger,
      depositor,
      shopNft,
      shares,
      distributor,
      erc20,
      tokenAddr: await erc20.getAddress(),
      shopA: 1n,
      shopB: 2n,
      total: 10_000n
    };
  }

  // -----------------------------------------------------------------------
  // Deposits
  // -----------------------------------------------------------------------
  describe("deposit", function () {
    it("authorized deposit increments cumulativeIndex by amount * PRECISION / TOTAL_SUPPLY and emits Deposited", async function () {
      const fx = await deploy();
      const amount = fx.ethers.parseEther("1");
      const tx = await fx.distributor.connect(fx.depositor).deposit(fx.shopA, { value: amount });
      await tx.wait();
      const PRECISION: bigint = await fx.distributor.PRECISION();
      const expected = (amount * PRECISION) / fx.total;
      expect(await fx.distributor.cumulativeIndex(fx.shopA, ZERO)).to.equal(expected);
      await expect(tx)
        .to.emit(fx.distributor, "Deposited")
        .withArgs(fx.shopA, ZERO, amount, fx.depositor.address);
    });

    it("unauthorized deposit reverts with UnauthorizedDepositor", async function () {
      const fx = await deploy();
      await expect(
        fx.distributor.connect(fx.stranger).deposit(fx.shopA, { value: fx.ethers.parseEther("1") })
      )
        .to.be.revertedWithCustomError(fx.distributor, "UnauthorizedDepositor")
        .withArgs(fx.stranger.address);
    });

    it("depositERC20 pulls tokens via safeTransferFrom and updates index", async function () {
      const fx = await deploy();
      const amount = 5_000_000n; // 5 mUSDC at 6 decimals
      const tx = await fx.distributor
        .connect(fx.depositor)
        .depositERC20(fx.shopA, fx.tokenAddr, amount);
      await tx.wait();
      expect(await fx.erc20.balanceOf(await fx.distributor.getAddress())).to.equal(amount);
      const PRECISION: bigint = await fx.distributor.PRECISION();
      expect(await fx.distributor.cumulativeIndex(fx.shopA, fx.tokenAddr)).to.equal(
        (amount * PRECISION) / fx.total
      );
    });

    it("_depositedTokens is deduplicated across repeated deposits", async function () {
      const fx = await deploy();
      await fx.distributor.connect(fx.depositor).deposit(fx.shopA, { value: 100n });
      await fx.distributor.connect(fx.depositor).deposit(fx.shopA, { value: 200n });
      await fx.distributor.connect(fx.depositor).depositERC20(fx.shopA, fx.tokenAddr, 300n);
      await fx.distributor.connect(fx.depositor).depositERC20(fx.shopA, fx.tokenAddr, 400n);
      const tokens = await fx.distributor.depositedTokensOf(fx.shopA);
      expect(tokens.length).to.equal(2);
      expect(tokens).to.deep.equal([ZERO, fx.tokenAddr]);
    });
  });

  // -----------------------------------------------------------------------
  // Settle + Claim — baseline cases (no transfers in between)
  // -----------------------------------------------------------------------
  describe("settle + claim (single holder)", function () {
    it("100% holder claims the full deposit", async function () {
      const fx = await deploy();
      const amount = fx.ethers.parseEther("1");
      await fx.distributor.connect(fx.depositor).deposit(fx.shopA, { value: amount });

      const balBefore = await fx.ethers.provider.getBalance(fx.alice.address);
      const tx = await fx.distributor.connect(fx.alice).claim(fx.shopA, ZERO);
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice;
      const balAfter = await fx.ethers.provider.getBalance(fx.alice.address);
      expect(balAfter - balBefore).to.equal(amount - gas);
    });

    it("two holders at 50/50 each claim half", async function () {
      const fx = await deploy();
      // alice → bob: 5000 shares (settler hook is wired, but no deposits
      // yet so settle is a no-op).
      await fx.shares
        .connect(fx.alice)
        .safeTransferFrom(fx.alice.address, fx.bob.address, fx.shopA, 5_000n, "0x");

      const amount = fx.ethers.parseEther("1");
      await fx.distributor.connect(fx.depositor).deposit(fx.shopA, { value: amount });

      expect(await fx.distributor.pendingClaim(fx.shopA, ZERO, fx.alice.address)).to.equal(
        amount / 2n
      );
      expect(await fx.distributor.pendingClaim(fx.shopA, ZERO, fx.bob.address)).to.equal(
        amount / 2n
      );
    });

    it("ERC-20 single-holder path", async function () {
      const fx = await deploy();
      const amount = 3_000_000n; // 3 mUSDC
      await fx.distributor.connect(fx.depositor).depositERC20(fx.shopA, fx.tokenAddr, amount);
      await fx.distributor.connect(fx.alice).claim(fx.shopA, fx.tokenAddr);
      expect(await fx.erc20.balanceOf(fx.alice.address)).to.equal(amount);
    });
  });

  // -----------------------------------------------------------------------
  // Transfers between deposits (the K.3a hot-path)
  // -----------------------------------------------------------------------
  describe("settle on share transfer", function () {
    it("native: deposit → transfer → deposit credits holders correctly", async function () {
      // alice 1000 + bob 0  (after we move alice from 10000 down to 1000)
      // Setup: alice transfers 9000 to carol to leave herself with 1000.
      // Actually the spec example used alice 1000 + bob 0; let me use the
      // simpler shape: alice has 100% (10000) initially. Deposit 1 ETH.
      // Then transfer 5000 → bob. Deposit another 1 ETH. Expected:
      //   alice: 1 ETH * 10000/10000 + 1 ETH * 5000/10000 = 1.5 ETH
      //   bob:   0 + 1 ETH * 5000/10000 = 0.5 ETH
      const fx = await deploy();
      const PRECISION: bigint = await fx.distributor.PRECISION();
      const oneEth = fx.ethers.parseEther("1");

      // Deposit #1: alice 100%
      await fx.distributor.connect(fx.depositor).deposit(fx.shopA, { value: oneEth });

      // Transfer triggers settle for alice (10000 balance, full credit).
      await fx.shares
        .connect(fx.alice)
        .safeTransferFrom(fx.alice.address, fx.bob.address, fx.shopA, 5_000n, "0x");

      // Deposit #2: alice 50%, bob 50%
      await fx.distributor.connect(fx.depositor).deposit(fx.shopA, { value: oneEth });

      // Now each must be claimable correctly. Use pendingClaim.
      const aliceExpected = oneEth + oneEth / 2n;
      const bobExpected = oneEth / 2n;
      expect(await fx.distributor.pendingClaim(fx.shopA, ZERO, fx.alice.address)).to.equal(
        aliceExpected
      );
      expect(await fx.distributor.pendingClaim(fx.shopA, ZERO, fx.bob.address)).to.equal(
        bobExpected
      );

      // Cumulative invariant: pending(alice) + pending(bob) + already-claimed = total deposits.
      const totalIn = oneEth * 2n;
      expect(aliceExpected + bobExpected).to.equal(totalIn);

      // Cumulative index ≡ (oneEth * 1e18 / 10000) + (oneEth * 1e18 / 10000) = oneEth * 2e14.
      expect(await fx.distributor.cumulativeIndex(fx.shopA, ZERO)).to.equal(
        (totalIn * PRECISION) / fx.total
      );
    });

    it("ERC-20: deposit → transfer → deposit credits holders correctly", async function () {
      const fx = await deploy();
      await fx.distributor
        .connect(fx.depositor)
        .depositERC20(fx.shopA, fx.tokenAddr, 1_000_000n); // 1 mUSDC

      await fx.shares
        .connect(fx.alice)
        .safeTransferFrom(fx.alice.address, fx.bob.address, fx.shopA, 5_000n, "0x");

      await fx.distributor
        .connect(fx.depositor)
        .depositERC20(fx.shopA, fx.tokenAddr, 1_000_000n);

      expect(
        await fx.distributor.pendingClaim(fx.shopA, fx.tokenAddr, fx.alice.address)
      ).to.equal(1_500_000n);
      expect(
        await fx.distributor.pendingClaim(fx.shopA, fx.tokenAddr, fx.bob.address)
      ).to.equal(500_000n);
    });

    it("multiple transfers between deposits stay in sync", async function () {
      // alice → bob 5000, deposit 1 ETH, bob → carol 2500, deposit 1 ETH
      //   After tx1: alice=5000, bob=5000
      //   Deposit#1 (1 ETH @ 5000/5000): alice +0.5, bob +0.5
      //   After tx2: alice=5000, bob=2500, carol=2500
      //   Deposit#2 (1 ETH @ 5000/2500/2500): alice +0.5, bob +0.25, carol +0.25
      //   Total claimable: alice 1.0, bob 0.75, carol 0.25
      const fx = await deploy();
      const oneEth = fx.ethers.parseEther("1");

      await fx.shares
        .connect(fx.alice)
        .safeTransferFrom(fx.alice.address, fx.bob.address, fx.shopA, 5_000n, "0x");
      await fx.distributor.connect(fx.depositor).deposit(fx.shopA, { value: oneEth });

      await fx.shares
        .connect(fx.bob)
        .safeTransferFrom(fx.bob.address, fx.carol.address, fx.shopA, 2_500n, "0x");
      await fx.distributor.connect(fx.depositor).deposit(fx.shopA, { value: oneEth });

      expect(await fx.distributor.pendingClaim(fx.shopA, ZERO, fx.alice.address)).to.equal(
        oneEth
      );
      expect(await fx.distributor.pendingClaim(fx.shopA, ZERO, fx.bob.address)).to.equal(
        (oneEth * 3n) / 4n
      );
      expect(await fx.distributor.pendingClaim(fx.shopA, ZERO, fx.carol.address)).to.equal(
        oneEth / 4n
      );
    });
  });

  // -----------------------------------------------------------------------
  // Multi-shop isolation
  // -----------------------------------------------------------------------
  describe("multi-shop isolation", function () {
    it("a deposit to shop A does not credit holders of shop B", async function () {
      const fx = await deploy();
      const oneEth = fx.ethers.parseEther("1");
      await fx.distributor.connect(fx.depositor).deposit(fx.shopA, { value: oneEth });

      // bob holds 100% of shopB shares and 0 of shopA shares.
      expect(await fx.distributor.pendingClaim(fx.shopA, ZERO, fx.bob.address)).to.equal(0n);
      expect(await fx.distributor.pendingClaim(fx.shopB, ZERO, fx.bob.address)).to.equal(0n);

      await fx.distributor.connect(fx.depositor).deposit(fx.shopB, { value: oneEth });
      expect(await fx.distributor.pendingClaim(fx.shopB, ZERO, fx.bob.address)).to.equal(oneEth);
      expect(await fx.distributor.pendingClaim(fx.shopA, ZERO, fx.alice.address)).to.equal(
        oneEth
      );
      // Alice still has nothing for shopB.
      expect(await fx.distributor.pendingClaim(fx.shopB, ZERO, fx.alice.address)).to.equal(0n);
    });

    it("a holder of shares in two shops accrues independently", async function () {
      const fx = await deploy();
      const oneEth = fx.ethers.parseEther("1");
      // Give carol 1000 of each shop's shares.
      await fx.shares
        .connect(fx.alice)
        .safeTransferFrom(fx.alice.address, fx.carol.address, fx.shopA, 1_000n, "0x");
      await fx.shares
        .connect(fx.bob)
        .safeTransferFrom(fx.bob.address, fx.carol.address, fx.shopB, 1_000n, "0x");

      await fx.distributor.connect(fx.depositor).deposit(fx.shopA, { value: oneEth });
      await fx.distributor.connect(fx.depositor).deposit(fx.shopB, { value: oneEth * 2n });

      expect(await fx.distributor.pendingClaim(fx.shopA, ZERO, fx.carol.address)).to.equal(
        oneEth / 10n
      );
      expect(await fx.distributor.pendingClaim(fx.shopB, ZERO, fx.carol.address)).to.equal(
        oneEth / 5n
      );
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe("edge cases", function () {
    it("deposit 0 native reverts with InvalidAmount", async function () {
      const fx = await deploy();
      await expect(
        fx.distributor.connect(fx.depositor).deposit(fx.shopA, { value: 0n })
      ).to.be.revertedWithCustomError(fx.distributor, "InvalidAmount");
    });

    it("claim with nothing accrued reverts with NothingToClaim", async function () {
      const fx = await deploy();
      // alice owns 100% but no deposits → claimable = 0.
      await expect(fx.distributor.connect(fx.alice).claim(fx.shopA, ZERO))
        .to.be.revertedWithCustomError(fx.distributor, "NothingToClaim");
    });

    it("settle called by anyone other than shares reverts with NotShares", async function () {
      const fx = await deploy();
      await expect(fx.distributor.connect(fx.stranger).settle(fx.shopA, fx.alice.address))
        .to.be.revertedWithCustomError(fx.distributor, "NotShares")
        .withArgs(fx.stranger.address);
    });
  });

  // -----------------------------------------------------------------------
  // View functions
  // -----------------------------------------------------------------------
  describe("views", function () {
    it("pendingClaim returns the same value before and after settleToken (no state drift)", async function () {
      const fx = await deploy();
      const oneEth = fx.ethers.parseEther("1");
      await fx.distributor.connect(fx.depositor).deposit(fx.shopA, { value: oneEth });

      const beforeSettle = await fx.distributor.pendingClaim(fx.shopA, ZERO, fx.alice.address);
      expect(beforeSettle).to.equal(oneEth);

      await fx.distributor.settleToken(fx.shopA, ZERO, fx.alice.address);
      const afterSettle = await fx.distributor.pendingClaim(fx.shopA, ZERO, fx.alice.address);
      expect(afterSettle).to.equal(beforeSettle);
    });

    it("depositedTokensOf returns insertion order", async function () {
      const fx = await deploy();
      await fx.distributor.connect(fx.depositor).deposit(fx.shopA, { value: 100n });
      await fx.distributor.connect(fx.depositor).depositERC20(fx.shopA, fx.tokenAddr, 100n);
      const tokens = await fx.distributor.depositedTokensOf(fx.shopA);
      expect(tokens).to.deep.equal([ZERO, fx.tokenAddr]);
    });
  });

  // -----------------------------------------------------------------------
  // claimAll
  // -----------------------------------------------------------------------
  describe("claimAll", function () {
    it("claims native + ERC-20 in one transaction", async function () {
      const fx = await deploy();
      const eth = fx.ethers.parseEther("1");
      const usdc = 1_000_000n;
      await fx.distributor.connect(fx.depositor).deposit(fx.shopA, { value: eth });
      await fx.distributor.connect(fx.depositor).depositERC20(fx.shopA, fx.tokenAddr, usdc);

      const ethBefore = await fx.ethers.provider.getBalance(fx.alice.address);
      const tx = await fx.distributor.connect(fx.alice).claimAll(fx.shopA);
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice;
      const ethAfter = await fx.ethers.provider.getBalance(fx.alice.address);
      expect(ethAfter - ethBefore).to.equal(eth - gas);
      expect(await fx.erc20.balanceOf(fx.alice.address)).to.equal(usdc);
    });
  });
});
