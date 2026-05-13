import { expect } from "chai";
import { network } from "hardhat";

describe("EvidenceRegistryV3", function () {
  const PLACEHOLDER_SOURCE = "return Functions.encodeString('pending')";
  const ORACLE_QUERY_COOLDOWN = 60 * 60;
  const PAID_DELAY = 30 * 24 * 60 * 60;

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

    const vault = await ethers.deployContract("EscrowVaultV3", [owner.address], owner);
    const router = await ethers.deployContract("FunctionsRouterMock", [], owner);
    const marketplace = await ethers.deployContract(
      "EscrowMarketplaceV3",
      [await vault.getAddress(), await router.getAddress(), PLACEHOLDER_SOURCE],
      owner
    );
    await vault.connect(owner).setMarketplace(await marketplace.getAddress());

    const registry = await ethers.deployContract(
      "EvidenceRegistryV3",
      [await marketplace.getAddress(), await router.getAddress(), PLACEHOLDER_SOURCE],
      owner
    );

    const amount = ethers.parseEther("1");
    const productId = 42n;

    return { ethers, owner, buyer, seller, other, router, vault, marketplace, registry, amount, productId };
  }

  async function deployWithPaidOrder() {
    const ctx = await deploy();
    await ctx.marketplace.connect(ctx.buyer).createAndPay(ctx.seller.address, ctx.productId, { value: ctx.amount });
    return { ...ctx, orderId: 1n };
  }

  async function deployWithShippedOrder() {
    const ctx = await deployWithPaidOrder();
    await ctx.marketplace.connect(ctx.seller).markShipped(ctx.orderId);
    return ctx;
  }

  async function deployWithDisputedOrder() {
    const ctx = await deployWithShippedOrder();
    await ctx.marketplace.connect(ctx.buyer).openDispute(ctx.orderId);
    return ctx;
  }

  describe("constructor", function () {
    it("rejects zero marketplace address", async function () {
      const { ethers } = await network.create();
      const [deployer] = await ethers.getSigners();
      const router = await ethers.deployContract("FunctionsRouterMock", [], deployer);

      await expect(
        ethers.deployContract(
          "EvidenceRegistryV3",
          [ethers.ZeroAddress, await router.getAddress(), PLACEHOLDER_SOURCE],
          deployer
        )
      ).to.be.revertedWith("Zero marketplace");
    });

    it("rejects zero router address", async function () {
      const { ethers } = await network.create();
      const [deployer] = await ethers.getSigners();
      const vault = await ethers.deployContract("EscrowVaultV3", [deployer.address], deployer);
      const router = await ethers.deployContract("FunctionsRouterMock", [], deployer);
      const marketplace = await ethers.deployContract(
        "EscrowMarketplaceV3",
        [await vault.getAddress(), await router.getAddress(), PLACEHOLDER_SOURCE],
        deployer
      );

      await expect(
        ethers.deployContract(
          "EvidenceRegistryV3",
          [await marketplace.getAddress(), ethers.ZeroAddress, PLACEHOLDER_SOURCE],
          deployer
        )
      ).to.be.revertedWith("Zero router");
    });

    it("rejects empty initial source", async function () {
      const { ethers } = await network.create();
      const [deployer] = await ethers.getSigners();
      const vault = await ethers.deployContract("EscrowVaultV3", [deployer.address], deployer);
      const router = await ethers.deployContract("FunctionsRouterMock", [], deployer);
      const marketplace = await ethers.deployContract(
        "EscrowMarketplaceV3",
        [await vault.getAddress(), await router.getAddress(), PLACEHOLDER_SOURCE],
        deployer
      );

      await expect(
        ethers.deployContract(
          "EvidenceRegistryV3",
          [await marketplace.getAddress(), await router.getAddress(), ""],
          deployer
        )
      ).to.be.revertedWith("Empty request source");
    });

    it("sets immutable marketplace + router, callbackGasLimit=300_000, initial source", async function () {
      const { marketplace, router, registry } = await deploy();
      expect(await registry.marketplace()).to.equal(await marketplace.getAddress());
      expect(await registry.functionsRouter()).to.equal(await router.getAddress());
      expect(await registry.callbackGasLimit()).to.equal(300_000);
      expect(await registry.requestSource()).to.equal(PLACEHOLDER_SOURCE);
    });
  });

  describe("submitEvidence (passive)", function () {
    it("buyer can submit on Paid order, emits ERC-1497 Evidence + EvidenceRecorded", async function () {
      const { ethers, buyer, marketplace, registry, orderId } = await deployWithPaidOrder();
      const uri = "ipfs://QmBuyerEvidence";
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes(uri));

      await expect(registry.connect(buyer).submitEvidence(orderId, uri))
        .to.emit(registry, "Evidence")
        .withArgs(await marketplace.getAddress(), orderId, buyer.address, uri)
        .and.to.emit(registry, "EvidenceRecorded")
        .withArgs(orderId, 0n, buyer.address, contentHash, 0n);

      expect(await registry.getEvidenceCount(orderId)).to.equal(1n);
      const rec = await registry.getEvidence(orderId, 0n);
      expect(rec.party).to.equal(buyer.address);
      expect(rec.contentHash).to.equal(contentHash);
      expect(rec.marketplaceDeliveredAtSnapshot).to.equal(0n);
      expect(rec.oracleRequestId).to.equal(ethers.ZeroHash);
    });

    it("seller can submit on Shipped order, snapshots deliveredAt=0", async function () {
      const { seller, registry, orderId } = await deployWithShippedOrder();

      await registry.connect(seller).submitEvidence(orderId, "ipfs://QmSeller");
      const rec = await registry.getEvidence(orderId, 0n);
      expect(rec.party).to.equal(seller.address);
      expect(rec.marketplaceDeliveredAtSnapshot).to.equal(0n);
    });

    it("both parties can submit on Disputed order, evidenceIndex increments", async function () {
      const { buyer, seller, registry, orderId } = await deployWithDisputedOrder();

      await registry.connect(buyer).submitEvidence(orderId, "ipfs://b");
      await registry.connect(seller).submitEvidence(orderId, "ipfs://s");

      expect(await registry.getEvidenceCount(orderId)).to.equal(2n);
      expect((await registry.getEvidence(orderId, 0n)).party).to.equal(buyer.address);
      expect((await registry.getEvidence(orderId, 1n)).party).to.equal(seller.address);
    });

    it("rejects empty URI", async function () {
      const { buyer, registry, orderId } = await deployWithPaidOrder();
      await expect(registry.connect(buyer).submitEvidence(orderId, "")).to.be.revertedWithCustomError(
        registry,
        "EmptyEvidence"
      );
    });

    it("rejects non-party (NotPartyOfOrder)", async function () {
      const { other, registry, orderId } = await deployWithPaidOrder();
      await expect(registry.connect(other).submitEvidence(orderId, "ipfs://x")).to.be.revertedWithCustomError(
        registry,
        "NotPartyOfOrder"
      );
    });

    it("rejects Created / Completed / Cancelled / Refunded status", async function () {
      const { ethers, owner, buyer, seller, marketplace, registry, amount, productId } = await deploy();

      // Created order (orderId 1)
      await marketplace.connect(buyer).createOrder(seller.address, productId, amount);
      await expect(registry.connect(buyer).submitEvidence(1n, "ipfs://x")).to.be.revertedWithCustomError(
        registry,
        "OrderStatusNotEligible"
      );

      // Cancelled order (orderId 2)
      await marketplace.connect(buyer).createOrder(seller.address, productId, amount);
      await marketplace.connect(buyer).cancelOrder(2n);
      await expect(registry.connect(buyer).submitEvidence(2n, "ipfs://x")).to.be.revertedWithCustomError(
        registry,
        "OrderStatusNotEligible"
      );

      // Completed order (orderId 3)
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      await marketplace.connect(seller).markShipped(3n);
      await marketplace.connect(buyer).confirmReceived(3n);
      await expect(registry.connect(buyer).submitEvidence(3n, "ipfs://x")).to.be.revertedWithCustomError(
        registry,
        "OrderStatusNotEligible"
      );

      // Refunded order (orderId 4)
      await marketplace.connect(buyer).createAndPay(seller.address, productId, { value: amount });
      await ethers.provider.send("evm_increaseTime", [PAID_DELAY + 1]);
      await ethers.provider.send("evm_mine", []);
      await marketplace.connect(owner).ownerEmergencyRefund(4n);
      await expect(registry.connect(buyer).submitEvidence(4n, "ipfs://x")).to.be.revertedWithCustomError(
        registry,
        "OrderStatusNotEligible"
      );
    });

    it("snapshots non-zero deliveredAt after oracle fulfilled it", async function () {
      const { ethers, buyer, marketplace, router, registry, orderId } = await deployWithShippedOrder();

      const marketplaceRequestId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint256"],
          [await router.getAddress(), await marketplace.getAddress(), 1n]
        )
      );

      await marketplace.connect(buyer).requestDelivery(orderId);
      const orderBefore = await marketplace.getOrder(orderId);
      const deliveredAt = orderBefore.shippedAt;

      await router.fulfill(
        await marketplace.getAddress(),
        marketplaceRequestId,
        ethers.AbiCoder.defaultAbiCoder().encode(["bool", "uint64"], [true, deliveredAt]),
        "0x"
      );

      await registry.connect(buyer).submitEvidence(orderId, "ipfs://after-delivery");
      const rec = await registry.getEvidence(orderId, 0n);
      expect(rec.marketplaceDeliveredAtSnapshot).to.equal(deliveredAt);
    });

    it("blocked when paused", async function () {
      const { owner, buyer, registry, orderId } = await deployWithPaidOrder();
      await registry.connect(owner).pause();

      await expect(registry.connect(buyer).submitEvidence(orderId, "ipfs://x")).to.be.revertedWithCustomError(
        registry,
        "EnforcedPause"
      );
    });
  });

  describe("submitEvidenceWithOracleQuery (active)", function () {
    it("records evidence + fires request + emits OracleQueryRequested", async function () {
      const { ethers, buyer, router, registry, orderId } = await deployWithDisputedOrder();

      const expectedRequestId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint256"],
          [await router.getAddress(), await registry.getAddress(), 1n]
        )
      );

      await expect(registry.connect(buyer).submitEvidenceWithOracleQuery(orderId, "ipfs://q"))
        .to.emit(registry, "EvidenceRecorded")
        .and.to.emit(registry, "OracleQueryRequested")
        .withArgs(orderId, 0n, expectedRequestId)
        .and.to.emit(router, "MockRequestSent");

      const rec = await registry.getEvidence(orderId, 0n);
      expect(rec.oracleRequestId).to.equal(expectedRequestId);
    });

    it("respects ORACLE_QUERY_COOLDOWN within 1h", async function () {
      const { buyer, registry, orderId } = await deployWithDisputedOrder();
      await registry.connect(buyer).submitEvidenceWithOracleQuery(orderId, "ipfs://a");

      await expect(
        registry.connect(buyer).submitEvidenceWithOracleQuery(orderId, "ipfs://b")
      ).to.be.revertedWithCustomError(registry, "OracleQueryCooldown");
    });

    it("allows another query after 1h elapsed", async function () {
      const { ethers, buyer, registry, orderId } = await deployWithDisputedOrder();
      await registry.connect(buyer).submitEvidenceWithOracleQuery(orderId, "ipfs://a");

      await ethers.provider.send("evm_increaseTime", [ORACLE_QUERY_COOLDOWN + 1]);
      await ethers.provider.send("evm_mine", []);

      await registry.connect(buyer).submitEvidenceWithOracleQuery(orderId, "ipfs://b");
      expect(await registry.getEvidenceCount(orderId)).to.equal(2n);
    });

    it("fulfillRequest stores OracleResult and emits OracleQueryFulfilled", async function () {
      const { ethers, buyer, router, registry, orderId } = await deployWithDisputedOrder();

      const requestId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint256"],
          [await router.getAddress(), await registry.getAddress(), 1n]
        )
      );
      await registry.connect(buyer).submitEvidenceWithOracleQuery(orderId, "ipfs://q");

      const deliveredTs = 1_800_000_000n;
      await expect(
        router.fulfill(
          await registry.getAddress(),
          requestId,
          ethers.AbiCoder.defaultAbiCoder().encode(["bool", "uint64"], [true, deliveredTs]),
          "0x"
        )
      )
        .to.emit(registry, "OracleQueryFulfilled")
        .withArgs(orderId, 0n, true, deliveredTs);

      const result = await registry.oracleResults(orderId, 0n);
      expect(result.fulfilled).to.equal(true);
      expect(result.delivered).to.equal(true);
      expect(result.deliveredTimestamp).to.equal(deliveredTs);
    });

    it("fulfillRequest on unknown requestId is a no-op", async function () {
      const { ethers, seller, router, registry, orderId } = await deployWithDisputedOrder();
      const unknownRequestId = ethers.id("never-issued");

      const tx = await router.connect(seller).fulfill(
        await registry.getAddress(),
        unknownRequestId,
        ethers.AbiCoder.defaultAbiCoder().encode(["bool", "uint64"], [true, 12345n]),
        "0x"
      );
      const receipt = await tx.wait();

      const ourLogs = receipt?.logs
        .map((log: any) => {
          try {
            return registry.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .filter((log: any) =>
          log?.name === "OracleQueryFulfilled" ||
          log?.name === "OracleQueryFailed" ||
          log?.name === "EvidenceRecorded"
        );

      expect(ourLogs).to.deep.equal([]);
      const result = await registry.oracleResults(orderId, 0n);
      expect(result.fulfilled).to.equal(false);
    });

    it("fulfillRequest with err.length > 0 emits OracleQueryFailed, no state write", async function () {
      const { ethers, buyer, router, registry, orderId } = await deployWithDisputedOrder();

      const requestId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint256"],
          [await router.getAddress(), await registry.getAddress(), 1n]
        )
      );
      await registry.connect(buyer).submitEvidenceWithOracleQuery(orderId, "ipfs://q");

      await expect(
        router.fulfill(
          await registry.getAddress(),
          requestId,
          "0x",
          ethers.toUtf8Bytes("17track failed")
        )
      )
        .to.emit(registry, "OracleQueryFailed")
        .withArgs(orderId, 0n, "17track failed");

      const result = await registry.oracleResults(orderId, 0n);
      expect(result.fulfilled).to.equal(false);
    });
  });

  describe("owner config setters", function () {
    it("all 5 setters emit M1-style events", async function () {
      const { ethers, owner, registry } = await deploy();
      const donId = ethers.encodeBytes32String("fun-sepolia");
      const newSource = "return Functions.encodeString('v2');";
      const sourceHash = ethers.keccak256(ethers.toUtf8Bytes(newSource));
      const secretsRef = "0x1234567890abcdef";
      const secretsHash = ethers.keccak256(secretsRef);

      await expect(registry.connect(owner).setSubscriptionId(7n))
        .to.emit(registry, "SubscriptionIdUpdated")
        .withArgs(0n, 7n);

      await expect(registry.connect(owner).setDonId(donId))
        .to.emit(registry, "DonIdUpdated")
        .withArgs(ethers.ZeroHash, donId);

      await expect(registry.connect(owner).setCallbackGasLimit(250_000))
        .to.emit(registry, "CallbackGasLimitUpdated")
        .withArgs(300_000, 250_000);

      await expect(registry.connect(owner).setRequestSource(newSource))
        .to.emit(registry, "RequestSourceUpdated")
        .withArgs(sourceHash, newSource.length);

      await expect(registry.connect(owner).setEncryptedSecretsReference(secretsRef))
        .to.emit(registry, "EncryptedSecretsReferenceUpdated")
        .withArgs(secretsHash, ethers.getBytes(secretsRef).length);
    });

    it("non-owner setters revert", async function () {
      const { ethers, other, registry } = await deploy();

      await expect(registry.connect(other).setSubscriptionId(1n)).to.be.revertedWithCustomError(
        registry,
        "OwnableUnauthorizedAccount"
      );
      await expect(registry.connect(other).setDonId(ethers.ZeroHash)).to.be.revertedWithCustomError(
        registry,
        "OwnableUnauthorizedAccount"
      );
      await expect(registry.connect(other).setCallbackGasLimit(123)).to.be.revertedWithCustomError(
        registry,
        "OwnableUnauthorizedAccount"
      );
      await expect(registry.connect(other).setRequestSource("x")).to.be.revertedWithCustomError(
        registry,
        "OwnableUnauthorizedAccount"
      );
      await expect(registry.connect(other).setEncryptedSecretsReference("0x")).to.be.revertedWithCustomError(
        registry,
        "OwnableUnauthorizedAccount"
      );
    });

    it("transferOwnership requires acceptOwnership (Ownable2Step)", async function () {
      const { ethers, owner, other, registry } = await deploy();
      await registry.connect(owner).transferOwnership(other.address);

      expect(await registry.owner()).to.equal(owner.address);
      expect(await registry.pendingOwner()).to.equal(other.address);

      await expect(registry.connect(owner).acceptOwnership()).to.be.revertedWithCustomError(
        registry,
        "OwnableUnauthorizedAccount"
      );

      await registry.connect(other).acceptOwnership();
      expect(await registry.owner()).to.equal(other.address);
      expect(await registry.pendingOwner()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("misc", function () {
    it("direct ETH transfer reverts", async function () {
      const { ethers, owner, registry } = await deploy();
      await expect(
        owner.sendTransaction({ to: await registry.getAddress(), value: ethers.parseEther("0.1") })
      ).to.be.revertedWith("Direct ETH transfers are not allowed");
    });

    it("getEvidence index out of range reverts", async function () {
      const { registry, orderId } = await deployWithPaidOrder();
      await expect(registry.getEvidence(orderId, 0n)).to.be.revertedWith("Index out of range");
    });
  });
});
