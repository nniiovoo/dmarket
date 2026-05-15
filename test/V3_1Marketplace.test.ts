import { expect } from "chai";
import { network } from "hardhat";

describe("V3.1 Marketplace (createAndPayWithAuth)", function () {
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

  async function deploy() {
    const { ethers } = await network.create();
    const [owner, buyer, seller, relayer, stranger] = await ethers.getSigners();

    const vault = await ethers.deployContract("EscrowVaultV3", [owner.address], owner);
    const router = await ethers.deployContract("FunctionsRouterMock", [], owner);
    const marketplace = await ethers.deployContract(
      "EscrowMarketplaceV3_1",
      [await vault.getAddress(), await router.getAddress(), PLACEHOLDER_SOURCE],
      owner
    );
    await vault.connect(owner).setMarketplace(await marketplace.getAddress());

    const amount = ethers.parseEther("1");
    const productId = 42n;
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const marketplaceAddr = await marketplace.getAddress();

    const domain = {
      name: "ChainUsEscrow",
      version: "3.1",
      chainId,
      verifyingContract: marketplaceAddr
    };

    const types = {
      PaymentAuth: [
        { name: "buyer", type: "address" },
        { name: "seller", type: "address" },
        { name: "productId", type: "uint256" },
        { name: "amount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" }
      ]
    };

    return {
      ethers,
      owner,
      buyer,
      seller,
      relayer,
      stranger,
      router,
      vault,
      marketplace,
      amount,
      productId,
      domain,
      types
    };
  }

  async function buildAuthAndSig(
    fixture: Awaited<ReturnType<typeof deploy>>,
    overrides: Partial<{
      buyer: string;
      seller: string;
      productId: bigint;
      amount: bigint;
      nonce: bigint;
      deadline: bigint;
      signer: any;
    }> = {}
  ) {
    const { ethers, buyer, seller, amount, productId, domain, types, marketplace } = fixture;

    const nowSecs = BigInt(Math.floor(Date.now() / 1000));
    const auth = {
      buyer: overrides.buyer ?? buyer.address,
      seller: overrides.seller ?? seller.address,
      productId: overrides.productId ?? productId,
      amount: overrides.amount ?? amount,
      nonce: overrides.nonce ?? (await marketplace.authNonces(overrides.buyer ?? buyer.address)),
      deadline: overrides.deadline ?? nowSecs + 3600n
    };

    const signer = overrides.signer ?? buyer;
    const signature = await signer.signTypedData(domain, types, auth);

    return { auth, signature };
  }

  describe("constructor + domain", function () {
    it("inherits all V3 lifecycle (createAndPay still works without auth)", async function () {
      const { buyer, seller, marketplace, amount, productId } = await deploy();

      await expect(marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount }))
        .to.emit(marketplace, "OrderCreated")
        .withArgs(1n, buyer.address, seller.address, productId, amount);

      const order = await marketplace.getOrder(1n);
      expect(order.status).to.equal(OrderStatus.Paid);
    });

    it("exposes the EIP-712 domain separator and typehash", async function () {
      const { ethers, marketplace } = await deploy();

      const sep = await marketplace.domainSeparator();
      const typehash = await marketplace.paymentAuthTypehash();

      expect(sep).to.match(/^0x[0-9a-f]{64}$/);
      expect(typehash).to.match(/^0x[0-9a-f]{64}$/);
      expect(typehash).to.equal(
        ethers.keccak256(
          ethers.toUtf8Bytes(
            "PaymentAuth(address buyer,address seller,uint256 productId,uint256 amount,uint256 nonce,uint256 deadline)"
          )
        )
      );
    });
  });

  describe("happy path", function () {
    it("relayer can submit buyer's signed auth + matching value → order created with buyer recorded", async function () {
      const fx = await deploy();
      const { auth, signature } = await buildAuthAndSig(fx);

      await expect(
        fx.marketplace.connect(fx.relayer).createAndPayWithAuth(auth, signature, { value: fx.amount })
      )
        .to.emit(fx.marketplace, "OrderCreated")
        .withArgs(1n, fx.buyer.address, fx.seller.address, fx.productId, fx.amount)
        .and.to.emit(fx.marketplace, "OrderPaid")
        .withArgs(1n, fx.buyer.address, fx.amount)
        .and.to.emit(fx.marketplace, "PaymentAuthExecuted")
        .withArgs(1n, fx.buyer.address, fx.relayer.address, 0n);

      const order = await fx.marketplace.getOrder(1n);
      expect(order.buyer).to.equal(fx.buyer.address);
      expect(order.seller).to.equal(fx.seller.address);
      expect(order.status).to.equal(OrderStatus.Paid);

      // Vault recorded buyer correctly (H5)
      const parties = await fx.vault.partiesByOrder(1n);
      expect(parties.buyer).to.equal(fx.buyer.address);
      expect(parties.seller).to.equal(fx.seller.address);

      // Nonce incremented
      expect(await fx.marketplace.authNonces(fx.buyer.address)).to.equal(1n);
    });

    it("after auth-paid order, buyer can confirmReceived and seller withdraws as usual", async function () {
      const fx = await deploy();
      const { auth, signature } = await buildAuthAndSig(fx);

      await fx.marketplace.connect(fx.relayer).createAndPayWithAuth(auth, signature, { value: fx.amount });
      await fx.marketplace.connect(fx.seller).markShipped(1n);
      await fx.marketplace.connect(fx.buyer).confirmReceived(1n);

      const order = await fx.marketplace.getOrder(1n);
      expect(order.status).to.equal(OrderStatus.Completed);
      expect(await fx.vault.pendingWithdrawal(fx.seller.address)).to.equal(fx.amount);
    });

    it("multiple auth orders increment nonce and assign sequential orderIds", async function () {
      const fx = await deploy();

      const { auth: a1, signature: s1 } = await buildAuthAndSig(fx, { nonce: 0n, productId: 100n });
      await fx.marketplace.connect(fx.relayer).createAndPayWithAuth(a1, s1, { value: fx.amount });

      const { auth: a2, signature: s2 } = await buildAuthAndSig(fx, { nonce: 1n, productId: 200n });
      await fx.marketplace.connect(fx.relayer).createAndPayWithAuth(a2, s2, { value: fx.amount });

      expect(await fx.marketplace.authNonces(fx.buyer.address)).to.equal(2n);
      const o1 = await fx.marketplace.getOrder(1n);
      const o2 = await fx.marketplace.getOrder(2n);
      expect(o1.productId).to.equal(100n);
      expect(o2.productId).to.equal(200n);
    });
  });

  describe("rejection paths", function () {
    it("rejects expired authorization", async function () {
      const fx = await deploy();
      const past = BigInt(Math.floor(Date.now() / 1000)) - 10n;
      const { auth, signature } = await buildAuthAndSig(fx, { deadline: past });

      await expect(
        fx.marketplace.connect(fx.relayer).createAndPayWithAuth(auth, signature, { value: fx.amount })
      ).to.be.revertedWithCustomError(fx.marketplace, "AuthExpired");
    });

    it("rejects msg.value != auth.amount", async function () {
      const fx = await deploy();
      const { auth, signature } = await buildAuthAndSig(fx);

      const wrongValue = fx.amount + 1n;
      await expect(
        fx.marketplace.connect(fx.relayer).createAndPayWithAuth(auth, signature, { value: wrongValue })
      ).to.be.revertedWithCustomError(fx.marketplace, "AuthAmountMismatch");
    });

    it("rejects nonce mismatch (replay attempt)", async function () {
      const fx = await deploy();

      // First use of nonce=0 succeeds
      const { auth, signature } = await buildAuthAndSig(fx, { nonce: 0n });
      await fx.marketplace.connect(fx.relayer).createAndPayWithAuth(auth, signature, { value: fx.amount });

      // Replay same (nonce=0) signature
      await expect(
        fx.marketplace.connect(fx.relayer).createAndPayWithAuth(auth, signature, { value: fx.amount })
      ).to.be.revertedWithCustomError(fx.marketplace, "AuthNonceMismatch");
    });

    it("rejects out-of-order nonce (jumping ahead)", async function () {
      const fx = await deploy();
      const { auth, signature } = await buildAuthAndSig(fx, { nonce: 5n });

      await expect(
        fx.marketplace.connect(fx.relayer).createAndPayWithAuth(auth, signature, { value: fx.amount })
      ).to.be.revertedWithCustomError(fx.marketplace, "AuthNonceMismatch");
    });

    it("rejects signature from stranger pretending to be buyer", async function () {
      const fx = await deploy();
      // Stranger signs but auth.buyer is the real buyer
      const { auth, signature } = await buildAuthAndSig(fx, { signer: fx.stranger });

      await expect(
        fx.marketplace.connect(fx.relayer).createAndPayWithAuth(auth, signature, { value: fx.amount })
      ).to.be.revertedWithCustomError(fx.marketplace, "AuthInvalidSignature");
    });

    it("rejects tampered amount (signature was for different amount)", async function () {
      const fx = await deploy();
      const { auth, signature } = await buildAuthAndSig(fx, { amount: fx.amount });

      const tampered = { ...auth, amount: fx.amount * 2n };
      await expect(
        fx.marketplace.connect(fx.relayer).createAndPayWithAuth(tampered, signature, { value: tampered.amount })
      ).to.be.revertedWithCustomError(fx.marketplace, "AuthInvalidSignature");
    });

    it("rejects tampered seller (signature was for different seller)", async function () {
      const fx = await deploy();
      const { auth, signature } = await buildAuthAndSig(fx);

      const tampered = { ...auth, seller: fx.stranger.address };
      await expect(
        fx.marketplace.connect(fx.relayer).createAndPayWithAuth(tampered, signature, { value: fx.amount })
      ).to.be.revertedWithCustomError(fx.marketplace, "AuthInvalidSignature");
    });

    it("rejects buyer == zero address", async function () {
      const fx = await deploy();
      const { ethers } = fx;
      const { auth, signature } = await buildAuthAndSig(fx, { buyer: ethers.ZeroAddress });

      await expect(
        fx.marketplace.connect(fx.relayer).createAndPayWithAuth(auth, signature, { value: fx.amount })
      ).to.be.revertedWithCustomError(fx.marketplace, "AuthZeroBuyer");
    });

    it("rejects when paused", async function () {
      const fx = await deploy();
      const { owner } = fx;
      await fx.marketplace.connect(owner).pause();

      const { auth, signature } = await buildAuthAndSig(fx);
      await expect(
        fx.marketplace.connect(fx.relayer).createAndPayWithAuth(auth, signature, { value: fx.amount })
      ).to.be.revertedWithCustomError(fx.marketplace, "EnforcedPause");
    });

    it("rejects seller == buyer in auth", async function () {
      const fx = await deploy();
      // buyer signs an auth where seller is itself
      const { auth, signature } = await buildAuthAndSig(fx, { seller: fx.buyer.address });

      await expect(
        fx.marketplace.connect(fx.relayer).createAndPayWithAuth(auth, signature, { value: fx.amount })
      ).to.be.revertedWith("Seller cannot be buyer");
    });

    it("rejects amount == 0 in auth", async function () {
      const fx = await deploy();
      const { auth, signature } = await buildAuthAndSig(fx, { amount: 0n });

      // msg.value=0 will mismatch the amount=0... actually equal. Then the
      // internal _payOrderFor → vault.lockFunds rejects msg.value > 0. But
      // first _createOrderFor rejects amount > 0.
      await expect(
        fx.marketplace.connect(fx.relayer).createAndPayWithAuth(auth, signature, { value: 0n })
      ).to.be.revertedWith("Amount must be greater than zero");
    });
  });

  describe("invalidateNonce", function () {
    it("increments nonce and emits NonceInvalidated", async function () {
      const fx = await deploy();
      expect(await fx.marketplace.authNonces(fx.buyer.address)).to.equal(0n);

      await expect(fx.marketplace.connect(fx.buyer).invalidateNonce())
        .to.emit(fx.marketplace, "NonceInvalidated")
        .withArgs(fx.buyer.address, 0n, 1n);

      expect(await fx.marketplace.authNonces(fx.buyer.address)).to.equal(1n);
    });

    it("invalidated nonce cannot be used — prior signature is rejected", async function () {
      const fx = await deploy();
      const { auth, signature } = await buildAuthAndSig(fx, { nonce: 0n });

      // Buyer invalidates nonce=0 before the relayer submits.
      await fx.marketplace.connect(fx.buyer).invalidateNonce();

      await expect(
        fx.marketplace.connect(fx.relayer).createAndPayWithAuth(auth, signature, { value: fx.amount })
      ).to.be.revertedWithCustomError(fx.marketplace, "AuthNonceMismatch");
    });

    it("can transact with new nonce after invalidation", async function () {
      const fx = await deploy();
      await fx.marketplace.connect(fx.buyer).invalidateNonce(); // nonce is now 1

      const { auth, signature } = await buildAuthAndSig(fx, { nonce: 1n });
      await expect(
        fx.marketplace.connect(fx.relayer).createAndPayWithAuth(auth, signature, { value: fx.amount })
      ).to.emit(fx.marketplace, "PaymentAuthExecuted");
    });

    it("each buyer invalidates their own nonce independently", async function () {
      const fx = await deploy();
      await fx.marketplace.connect(fx.buyer).invalidateNonce();

      expect(await fx.marketplace.authNonces(fx.buyer.address)).to.equal(1n);
      expect(await fx.marketplace.authNonces(fx.stranger.address)).to.equal(0n);
    });
  });

  describe("cross-signer replay isolation", function () {
    it("two different buyers maintain independent nonces", async function () {
      const fx = await deploy();
      // Use stranger as a second buyer
      const buyer2 = fx.stranger;

      const { auth: a1, signature: s1 } = await buildAuthAndSig(fx, { buyer: fx.buyer.address, signer: fx.buyer });
      await fx.marketplace.connect(fx.relayer).createAndPayWithAuth(a1, s1, { value: fx.amount });

      // Buyer 2 starts at nonce 0
      const { auth: a2, signature: s2 } = await buildAuthAndSig(fx, {
        buyer: buyer2.address,
        signer: buyer2,
        nonce: 0n
      });
      await fx.marketplace.connect(fx.relayer).createAndPayWithAuth(a2, s2, { value: fx.amount });

      expect(await fx.marketplace.authNonces(fx.buyer.address)).to.equal(1n);
      expect(await fx.marketplace.authNonces(buyer2.address)).to.equal(1n);

      const o1 = await fx.marketplace.getOrder(1n);
      const o2 = await fx.marketplace.getOrder(2n);
      expect(o1.buyer).to.equal(fx.buyer.address);
      expect(o2.buyer).to.equal(buyer2.address);
    });

    it("signature from wrong chainId is rejected (domain separator binds chain)", async function () {
      const fx = await deploy();

      // Build a domain with a fake chainId
      const fakeDomain = { ...fx.domain, chainId: 999999n };
      const nowSecs = BigInt(Math.floor(Date.now() / 1000));
      const auth = {
        buyer: fx.buyer.address,
        seller: fx.seller.address,
        productId: fx.productId,
        amount: fx.amount,
        nonce: 0n,
        deadline: nowSecs + 3600n
      };
      const signature = await fx.buyer.signTypedData(fakeDomain, fx.types, auth);

      await expect(
        fx.marketplace.connect(fx.relayer).createAndPayWithAuth(auth, signature, { value: fx.amount })
      ).to.be.revertedWithCustomError(fx.marketplace, "AuthInvalidSignature");
    });

    it("signature for a different verifyingContract is rejected", async function () {
      const fx = await deploy();

      const fakeDomain = { ...fx.domain, verifyingContract: fx.stranger.address };
      const auth = {
        buyer: fx.buyer.address,
        seller: fx.seller.address,
        productId: fx.productId,
        amount: fx.amount,
        nonce: 0n,
        deadline: BigInt(Math.floor(Date.now() / 1000)) + 3600n
      };
      const signature = await fx.buyer.signTypedData(fakeDomain, fx.types, auth);

      await expect(
        fx.marketplace.connect(fx.relayer).createAndPayWithAuth(auth, signature, { value: fx.amount })
      ).to.be.revertedWithCustomError(fx.marketplace, "AuthInvalidSignature");
    });
  });
});
