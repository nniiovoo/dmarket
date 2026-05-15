import { expect } from "chai";
import { network } from "hardhat";

describe("V3.2 ReputationRegistry (draft)", function () {
  async function deploy() {
    const { ethers } = await network.create();
    const [owner, attestor, newAttestor, subject, stranger] = await ethers.getSigners();

    const registry = await ethers.deployContract("ReputationRegistry", [attestor.address], owner);
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const domain = {
      name: "ChainUsReputation",
      version: "1",
      chainId,
      verifyingContract: await registry.getAddress()
    };
    const types = {
      Attestation: [
        { name: "subject", type: "address" },
        { name: "score", type: "uint16" },
        { name: "issuedAt", type: "uint64" },
        { name: "expiry", type: "uint64" },
        { name: "version", type: "uint8" }
      ]
    };

    return {
      ethers,
      owner,
      attestor,
      newAttestor,
      subject,
      stranger,
      registry,
      domain,
      types
    };
  }

  async function makeAtt(
    fx: Awaited<ReturnType<typeof deploy>>,
    overrides: Partial<{
      subject: string;
      score: number;
      issuedAt: bigint;
      expiry: bigint;
      version: number;
      signer: any;
    }> = {}
  ) {
    const nowSecs = BigInt(Math.floor(Date.now() / 1000));
    const att = {
      subject: overrides.subject ?? fx.subject.address,
      score: overrides.score ?? 720,
      issuedAt: overrides.issuedAt ?? nowSecs,
      expiry: overrides.expiry ?? nowSecs + 30n * 24n * 3600n,
      version: overrides.version ?? 1
    };
    const signer = overrides.signer ?? fx.attestor;
    const signature = await signer.signTypedData(fx.domain, fx.types, att);
    return { att, signature };
  }

  describe("verifyAttestation", function () {
    it("returns true for a valid signature", async function () {
      const fx = await deploy();
      const { att, signature } = await makeAtt(fx);
      expect(await fx.registry.verifyAttestation(att, signature)).to.equal(true);
    });

    it("returns false for an expired attestation", async function () {
      const fx = await deploy();
      const past = BigInt(Math.floor(Date.now() / 1000)) - 3600n;
      const { att, signature } = await makeAtt(fx, { expiry: past });
      expect(await fx.registry.verifyAttestation(att, signature)).to.equal(false);
    });

    it("returns false when signed by stranger", async function () {
      const fx = await deploy();
      const { att, signature } = await makeAtt(fx, { signer: fx.stranger });
      expect(await fx.registry.verifyAttestation(att, signature)).to.equal(false);
    });
  });

  describe("recordAttestation", function () {
    it("records a valid attestation and emits AttestationRecorded", async function () {
      const fx = await deploy();
      const { att, signature } = await makeAtt(fx, { score: 800, version: 1 });

      await expect(fx.registry.connect(fx.stranger).recordAttestation(att, signature))
        .to.emit(fx.registry, "AttestationRecorded")
        .withArgs(att.subject, 800, att.issuedAt, att.expiry, 1);

      const stored = await fx.registry.getAttestation(att.subject);
      expect(stored.score).to.equal(800);
      expect(stored.version).to.equal(1);
    });

    it("rejects an expired attestation", async function () {
      const fx = await deploy();
      const past = BigInt(Math.floor(Date.now() / 1000)) - 1n;
      const { att, signature } = await makeAtt(fx, { expiry: past });
      await expect(fx.registry.recordAttestation(att, signature)).to.be.revertedWithCustomError(
        fx.registry,
        "AttestationExpired"
      );
    });

    it("rejects an older (replay) version", async function () {
      const fx = await deploy();
      const v2 = await makeAtt(fx, { version: 2, score: 700 });
      await fx.registry.recordAttestation(v2.att, v2.signature);

      const v1 = await makeAtt(fx, { version: 1, score: 999 });
      await expect(fx.registry.recordAttestation(v1.att, v1.signature)).to.be.revertedWithCustomError(
        fx.registry,
        "VersionNotIncreasing"
      );

      const stored = await fx.registry.getAttestation(fx.subject.address);
      expect(stored.score).to.equal(700);
      expect(stored.version).to.equal(2);
    });

    it("rejects replay of the SAME version", async function () {
      const fx = await deploy();
      const v1 = await makeAtt(fx, { version: 1 });
      await fx.registry.recordAttestation(v1.att, v1.signature);
      await expect(fx.registry.recordAttestation(v1.att, v1.signature)).to.be.revertedWithCustomError(
        fx.registry,
        "VersionNotIncreasing"
      );
    });

    it("rejects a signature from a non-signer", async function () {
      const fx = await deploy();
      const { att, signature } = await makeAtt(fx, { signer: fx.stranger });
      await expect(fx.registry.recordAttestation(att, signature)).to.be.revertedWithCustomError(
        fx.registry,
        "InvalidSigner"
      );
    });
  });

  describe("signer rotation", function () {
    it("only owner can propose pending signer", async function () {
      const fx = await deploy();
      await expect(
        fx.registry.connect(fx.stranger).setPendingSigner(fx.newAttestor.address)
      ).to.be.revertedWithCustomError(fx.registry, "OwnableUnauthorizedAccount");
    });

    it("acceptSigner switches the signer and old signer is rejected after rotation", async function () {
      const fx = await deploy();

      // Old signer works pre-rotation.
      const before = await makeAtt(fx, { version: 1, signer: fx.attestor });
      await fx.registry.recordAttestation(before.att, before.signature);

      await fx.registry.connect(fx.owner).setPendingSigner(fx.newAttestor.address);
      // Stranger cannot accept.
      await expect(fx.registry.connect(fx.stranger).acceptSigner()).to.be.revertedWithCustomError(
        fx.registry,
        "NotPendingSigner"
      );

      await expect(fx.registry.connect(fx.newAttestor).acceptSigner())
        .to.emit(fx.registry, "SignerRotated")
        .withArgs(fx.attestor.address, fx.newAttestor.address);

      expect(await fx.registry.signer()).to.equal(fx.newAttestor.address);

      // Old signer is now rejected.
      const stillOld = await makeAtt(fx, { version: 2, signer: fx.attestor });
      await expect(
        fx.registry.recordAttestation(stillOld.att, stillOld.signature)
      ).to.be.revertedWithCustomError(fx.registry, "InvalidSigner");

      // New signer is accepted.
      const fresh = await makeAtt(fx, { version: 2, signer: fx.newAttestor });
      await expect(fx.registry.recordAttestation(fresh.att, fresh.signature)).to.emit(
        fx.registry,
        "AttestationRecorded"
      );
    });

    it("acceptSigner reverts when there is no pending signer", async function () {
      const fx = await deploy();
      await expect(fx.registry.connect(fx.attestor).acceptSigner()).to.be.revertedWithCustomError(
        fx.registry,
        "NoPendingSigner"
      );
    });
  });

  describe("domain", function () {
    it("exposes attestationTypehash matching the schema", async function () {
      const fx = await deploy();
      const got = await fx.registry.attestationTypehash();
      const expected = fx.ethers.keccak256(
        fx.ethers.toUtf8Bytes(
          "Attestation(address subject,uint16 score,uint64 issuedAt,uint64 expiry,uint8 version)"
        )
      );
      expect(got).to.equal(expected);
    });

    it("rejects a signature bound to a different chainId", async function () {
      const fx = await deploy();
      const wrongDomain = { ...fx.domain, chainId: 9999n };
      const nowSecs = BigInt(Math.floor(Date.now() / 1000));
      const att = {
        subject: fx.subject.address,
        score: 500,
        issuedAt: nowSecs,
        expiry: nowSecs + 3600n,
        version: 1
      };
      const signature = await fx.attestor.signTypedData(wrongDomain, fx.types, att);
      expect(await fx.registry.verifyAttestation(att, signature)).to.equal(false);
    });
  });
});
