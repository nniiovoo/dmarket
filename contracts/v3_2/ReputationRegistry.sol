// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title ReputationRegistry (v3.2 draft)
/// @notice On-chain store + verifier for off-chain signed credit-score attestations.
/// @custom:status WIP-DRAFT — NOT AUDITED — DO NOT DEPLOY TO MAINNET
///
/// =====================================================================
/// WHY-THIS-IS-NEW-VS-EXTENDING-V3.1
/// ---------------------------------------------------------------------
/// V3.1 is an escrow marketplace; its signer key authorizes *payment*
/// authorizations bound to a specific orderId / amount / nonce per
/// buyer. Reputation attestations are a different artifact: they are
/// long-lived statements about a `subject` (any user, not necessarily a
/// buyer in any particular order), they need their own monotonic
/// `version` to defeat replay of stale scores, and they are designed to
/// be portable across marketplace deployments and chains.
///
/// Co-locating attestation verification inside V3.1 would (a) bind
/// reputation to a single marketplace's EIP-712 domain, defeating
/// portability; (b) entangle two unrelated rotation policies (the
/// payment-relayer signer vs. the platform-attestor signer); and
/// (c) bloat V3.1 — currently a focused 120-line contract — with
/// schema and storage that has nothing to do with order flow.
///
/// CLAUDE.md §1.0 lists `ReputationRegistry` as a planned standalone
/// module for exactly the "multiple consumers reading from one source
/// of truth" reason in `contracts/v2/ARCHITECTURE.md`. This draft is
/// that module: a thin verifier/store with no on-chain scoring logic.
/// Scores are computed off-chain by the platform; the contract only
/// checks EIP-712 signatures, replay-by-version, and expiry.
/// =====================================================================
contract ReputationRegistry is Ownable2Step, EIP712 {
    struct Attestation {
        address subject;
        uint16 score;
        uint64 issuedAt;
        uint64 expiry;
        uint8 version;
    }

    bytes32 private constant ATTESTATION_TYPEHASH =
        keccak256(
            "Attestation(address subject,uint16 score,uint64 issuedAt,uint64 expiry,uint8 version)"
        );

    address public signer;
    address public pendingSigner;

    mapping(address => Attestation) public latest;

    event SignerRotationProposed(address indexed currentSigner, address indexed pendingSigner);
    event SignerRotated(address indexed oldSigner, address indexed newSigner);
    event AttestationRecorded(
        address indexed subject,
        uint16 score,
        uint64 issuedAt,
        uint64 expiry,
        uint8 version
    );

    error InvalidSigner(address recovered, address expected);
    error AttestationExpired(uint64 expiry, uint64 nowTs);
    error VersionNotIncreasing(uint8 incoming, uint8 stored);
    error ZeroSubject();
    error ZeroSigner();
    error NoPendingSigner();
    error NotPendingSigner(address caller, address pending);

    constructor(address initialSigner) Ownable(msg.sender) EIP712("ChainUsReputation", "1") {
        if (initialSigner == address(0)) revert ZeroSigner();
        signer = initialSigner;
    }

    // ---------------------------------------------------------------------
    // Signer rotation (2-step, no timelock as per draft spec)
    // ---------------------------------------------------------------------
    function setPendingSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroSigner();
        pendingSigner = newSigner;
        emit SignerRotationProposed(signer, newSigner);
    }

    // The pending signer must accept, mirroring Ownable2Step's pattern: this
    // proves the new signing key is live and controllable before it becomes
    // authoritative.
    function acceptSigner() external {
        address pending = pendingSigner;
        if (pending == address(0)) revert NoPendingSigner();
        if (msg.sender != pending) revert NotPendingSigner(msg.sender, pending);

        address old = signer;
        signer = pending;
        delete pendingSigner;

        emit SignerRotated(old, pending);
    }

    // ---------------------------------------------------------------------
    // Verification + storage
    // ---------------------------------------------------------------------
    function verifyAttestation(
        Attestation calldata att,
        bytes calldata signature
    ) external view returns (bool) {
        if (att.subject == address(0)) return false;
        if (att.expiry != 0 && att.expiry < block.timestamp) return false;

        bytes32 structHash = keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                att.subject,
                att.score,
                att.issuedAt,
                att.expiry,
                att.version
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError) return false;
        return recovered == signer;
    }

    function recordAttestation(Attestation calldata att, bytes calldata signature) external {
        if (att.subject == address(0)) revert ZeroSubject();
        if (att.expiry != 0 && att.expiry < block.timestamp) {
            revert AttestationExpired(att.expiry, uint64(block.timestamp));
        }

        Attestation storage stored = latest[att.subject];
        // Strictly increasing version defeats replay of older attestations.
        // First record (stored.version == 0 && stored.issuedAt == 0) is
        // accepted for any incoming version >= 1.
        if (stored.issuedAt != 0 && att.version <= stored.version) {
            revert VersionNotIncreasing(att.version, stored.version);
        }

        bytes32 structHash = keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                att.subject,
                att.score,
                att.issuedAt,
                att.expiry,
                att.version
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != signer) revert InvalidSigner(recovered, signer);

        latest[att.subject] = att;
        emit AttestationRecorded(att.subject, att.score, att.issuedAt, att.expiry, att.version);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------
    function attestationTypehash() external pure returns (bytes32) {
        return ATTESTATION_TYPEHASH;
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function getAttestation(address subject) external view returns (Attestation memory) {
        return latest[subject];
    }
}
