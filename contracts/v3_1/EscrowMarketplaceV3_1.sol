// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EscrowMarketplaceV3} from "../v3/EscrowMarketplaceV3.sol";

// V3.1 = V3 + signed payment authorization.
//
// Motivation: cross-chain purchases via a bridge (e.g. LI.FI) require the
// buyer to send two transactions today — bridge ETH to Arbitrum, then sign a
// second tx on Arbitrum to call createAndPay. With V3.1, the buyer signs an
// EIP-712 PaymentAuth off-chain once; any relayer (the destination side of
// the bridge, an automated executor, or a paid forwarder) can submit the
// signed auth + matching msg.value to actually create and pay the order.
//
// Trust model: the relayer is untrusted. The contract verifies the buyer's
// signature against the typed-data hash; the buyer recorded in the order is
// the EIP-712 signer, never msg.sender. Nonces prevent replay, deadlines
// prevent indefinite reuse.
contract EscrowMarketplaceV3_1 is EscrowMarketplaceV3, EIP712 {
    struct PaymentAuth {
        address buyer;
        address seller;
        uint256 productId;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 private constant PAYMENT_AUTH_TYPEHASH =
        keccak256(
            "PaymentAuth(address buyer,address seller,uint256 productId,uint256 amount,uint256 nonce,uint256 deadline)"
        );

    mapping(address => uint256) public authNonces;

    event PaymentAuthExecuted(
        uint256 indexed orderId,
        address indexed buyer,
        address indexed relayer,
        uint256 nonce
    );

    error AuthExpired(uint256 deadline, uint256 now_);
    error AuthAmountMismatch(uint256 authAmount, uint256 sentValue);
    error AuthNonceMismatch(uint256 authNonce, uint256 expectedNonce);
    error AuthInvalidSignature(address recovered, address expected);
    error AuthZeroBuyer();

    event NonceInvalidated(address indexed buyer, uint256 invalidatedNonce, uint256 newNonce);

    constructor(
        address vaultAddress,
        address routerAddress,
        string memory initialRequestSource
    )
        EscrowMarketplaceV3(vaultAddress, routerAddress, initialRequestSource)
        EIP712("ChainUsEscrow", "3.1")
    {}

    // Anyone can call. The buyer recorded in the order is always auth.buyer
    // (the EIP-712 signer), regardless of who relays the tx. msg.value must
    // exactly match auth.amount; gas is paid by msg.sender, the purchase
    // funds come from msg.value.
    function createAndPayWithAuth(
        PaymentAuth calldata auth,
        bytes calldata signature
    ) external payable nonReentrant whenNotPaused returns (uint256) {
        if (auth.buyer == address(0)) revert AuthZeroBuyer();
        if (block.timestamp > auth.deadline) revert AuthExpired(auth.deadline, block.timestamp);
        if (msg.value != auth.amount) revert AuthAmountMismatch(auth.amount, msg.value);

        uint256 expectedNonce = authNonces[auth.buyer];
        if (auth.nonce != expectedNonce) revert AuthNonceMismatch(auth.nonce, expectedNonce);

        bytes32 structHash = keccak256(
            abi.encode(
                PAYMENT_AUTH_TYPEHASH,
                auth.buyer,
                auth.seller,
                auth.productId,
                auth.amount,
                auth.nonce,
                auth.deadline
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != auth.buyer) revert AuthInvalidSignature(recovered, auth.buyer);

        authNonces[auth.buyer] = expectedNonce + 1;

        uint256 orderId = _createOrderFor(auth.buyer, auth.seller, auth.productId, auth.amount);
        _payOrderFor(auth.buyer, orderId, msg.value);

        emit PaymentAuthExecuted(orderId, auth.buyer, msg.sender, auth.nonce);

        return orderId;
    }

    /// Buyer can skip their current nonce to invalidate a pending (e.g. expired
    /// but not yet consumed) authorization. Prevents re-use if the signed auth
    /// was shared with an untrusted relayer.
    function invalidateNonce() external {
        uint256 old = authNonces[msg.sender];
        authNonces[msg.sender] = old + 1;
        emit NonceInvalidated(msg.sender, old, old + 1);
    }

    // Exposed so the frontend / SDK can show the user the exact EIP-712
    // domain to sign against.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function paymentAuthTypehash() external pure returns (bytes32) {
        return PAYMENT_AUTH_TYPEHASH;
    }
}
