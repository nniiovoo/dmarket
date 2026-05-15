// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title EscrowMarketplaceERC20 (v3.2 draft)
/// @notice Stablecoin-aware escrow marketplace, mirrors V3.1 lifecycle.
/// @custom:status WIP-DRAFT — NOT AUDITED — DO NOT DEPLOY TO MAINNET
///
/// =====================================================================
/// WHY-THIS-IS-NEW-VS-EXTENDING-V3.1
/// ---------------------------------------------------------------------
/// V3 and V3.1 are bound to native-only payments and pipe every payment
/// through `EscrowVaultV3`, whose surface (`lockFunds`, `releaseToBuyer`,
/// `releaseToSeller`) is hard-coded to `payable` ETH transfers indexed by
/// orderId. Retrofitting that path to support ERC-20 (USDC/USDT/DAI) would
/// require either (a) editing the frozen V3 vault to add token branches
/// — which CLAUDE.md §8 forbids — or (b) layering an adapter that pulls
/// ERC-20 into the marketplace, wraps it, and somehow round-trips through
/// a payable vault. Both options leak ERC-20 concerns into V3.
///
/// Inheriting from `EscrowMarketplaceV3_1` is also a dead end: its
/// constructor mandates a `EscrowVaultV3` address and a Chainlink
/// Functions router, both of which are native-only / oracle-coupled and
/// unrelated to the ERC-20 payment problem. A WIP draft that pretends to
/// be V3.1+ would inherit dead state (subscriptionId, donID, requestSource,
/// pending source proposals) that has no meaning for an ERC-20 lane.
///
/// Therefore V3.2 is a *parallel* lane: a self-contained marketplace that
/// keeps the V3.1 signed-auth UX (EIP-712 PaymentAuth + nonces) and the
/// V3.1 state machine, but custodies funds itself (native or ERC-20) and
/// drops the Chainlink delivery oracle. The V3.1 contract on Sepolia stays
/// the canonical native lane; V3.2 is only deployed if/when the team
/// decides to open a stablecoin lane.
/// =====================================================================
contract EscrowMarketplaceERC20 is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    enum OrderStatus {
        Created,
        Paid,
        Shipped,
        Completed,
        Cancelled,
        Disputed,
        Refunded
    }

    struct Order {
        uint256 id;
        address buyer;
        OrderStatus status;
        uint64 createdAt;
        address seller;
        uint64 paidAt;
        address paymentToken; // address(0) => native gas token
        uint64 shippedAt;
        uint64 completedAt;
        uint64 disputedAt;
        uint256 productId;
        uint256 amount;
    }

    struct PaymentAuth {
        address buyer;
        address seller;
        address paymentToken;
        uint256 productId;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 private constant PAYMENT_AUTH_TYPEHASH =
        keccak256(
            "PaymentAuth(address buyer,address seller,address paymentToken,uint256 productId,uint256 amount,uint256 nonce,uint256 deadline)"
        );

    uint64 public constant DISPUTE_RESOLUTION_DELAY = 3 days;

    uint256 public nextOrderId;
    mapping(uint256 => Order) public orders;
    mapping(address => uint256[]) private buyerOrders;
    mapping(address => uint256[]) private sellerOrders;
    mapping(address => uint256) public authNonces;
    mapping(address => bool) public acceptedToken;

    event OrderCreated(
        uint256 indexed orderId,
        address indexed buyer,
        address indexed seller,
        address paymentToken,
        uint256 productId,
        uint256 amount
    );
    event OrderPaid(uint256 indexed orderId, address indexed buyer, address paymentToken, uint256 amount);
    event OrderShipped(uint256 indexed orderId, address indexed seller);
    event OrderCompleted(uint256 indexed orderId, address indexed seller, uint256 amount);
    event OrderCancelled(uint256 indexed orderId);
    event DisputeOpened(uint256 indexed orderId, address indexed openedBy);
    event DisputeResolved(uint256 indexed orderId, bool refundBuyer);
    event OrderRefunded(uint256 indexed orderId, address indexed buyer, uint256 amount);
    event AcceptedTokenUpdated(address indexed token, bool accepted);
    event PaymentAuthExecuted(uint256 indexed orderId, address indexed buyer, address indexed relayer, uint256 nonce);
    event NonceInvalidated(address indexed buyer, uint256 invalidatedNonce, uint256 newNonce);

    error TokenNotAccepted(address token);
    error WrongPaymentMode();
    error AuthExpired(uint256 deadline, uint256 nowTs);
    error AuthAmountMismatch(uint256 authAmount, uint256 sentValue);
    error AuthNonceMismatch(uint256 authNonce, uint256 expectedNonce);
    error AuthInvalidSignature(address recovered, address expected);
    error AuthZeroBuyer();

    modifier orderExists(uint256 orderId) {
        require(orderId > 0 && orderId < nextOrderId, "Order does not exist");
        _;
    }

    constructor() Ownable(msg.sender) EIP712("ChainUsEscrowERC20", "3.2") {
        nextOrderId = 1;
    }

    // Marketplace custodies funds itself for the ERC-20 lane (see header).
    // Stray native sends are still rejected — all native payments must come
    // through payOrder / createAndPay where they are paired with order state.
    receive() external payable {
        revert("Direct ETH transfers are not allowed");
    }

    // ---------------------------------------------------------------------
    // Owner: emergency brake + allowlist
    // ---------------------------------------------------------------------
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setAcceptedToken(address token, bool accepted) external onlyOwner {
        require(token != address(0), "Token cannot be zero address");
        acceptedToken[token] = accepted;
        emit AcceptedTokenUpdated(token, accepted);
    }

    // ---------------------------------------------------------------------
    // Order creation
    // ---------------------------------------------------------------------
    function createOrder(
        address seller,
        address paymentToken,
        uint256 productId,
        uint256 amount
    ) external whenNotPaused returns (uint256) {
        return _createOrderFor(msg.sender, seller, paymentToken, productId, amount);
    }

    // Native one-click: msg.value becomes the order amount, and paymentToken=address(0).
    function createAndPayNative(
        address seller,
        uint256 productId
    ) external payable nonReentrant whenNotPaused returns (uint256) {
        require(msg.value > 0, "Amount must be greater than zero");

        uint256 orderId = _createOrderFor(msg.sender, seller, address(0), productId, msg.value);
        _payNative(msg.sender, orderId, msg.value);
        return orderId;
    }

    function _createOrderFor(
        address buyer,
        address seller,
        address paymentToken,
        uint256 productId,
        uint256 amount
    ) internal returns (uint256) {
        require(seller != address(0), "Seller cannot be zero address");
        require(seller != buyer, "Seller cannot be buyer");
        require(amount > 0, "Amount must be greater than zero");
        if (paymentToken != address(0) && !acceptedToken[paymentToken]) {
            revert TokenNotAccepted(paymentToken);
        }

        uint256 orderId = nextOrderId;
        nextOrderId++;

        orders[orderId] = Order({
            id: orderId,
            buyer: buyer,
            seller: seller,
            paymentToken: paymentToken,
            productId: productId,
            amount: amount,
            status: OrderStatus.Created,
            createdAt: uint64(block.timestamp),
            paidAt: 0,
            shippedAt: 0,
            completedAt: 0,
            disputedAt: 0
        });

        buyerOrders[buyer].push(orderId);
        sellerOrders[seller].push(orderId);

        emit OrderCreated(orderId, buyer, seller, paymentToken, productId, amount);
        return orderId;
    }

    // ---------------------------------------------------------------------
    // Payment paths
    // ---------------------------------------------------------------------
    // Native: msg.value must equal order.amount, and the order must be native.
    function payOrder(uint256 orderId) external payable nonReentrant whenNotPaused orderExists(orderId) {
        Order storage order = orders[orderId];
        if (order.paymentToken != address(0)) revert WrongPaymentMode();
        _payNative(msg.sender, orderId, msg.value);
    }

    function _payNative(address buyer, uint256 orderId, uint256 value) internal {
        Order storage order = orders[orderId];
        require(buyer == order.buyer, "Only buyer can pay this order");
        require(order.status == OrderStatus.Created, "Order must be Created");
        require(value == order.amount, "Payment amount must equal order amount");

        order.status = OrderStatus.Paid;
        order.paidAt = uint64(block.timestamp);

        emit OrderPaid(orderId, buyer, address(0), value);
    }

    // ERC-20: buyer must IERC20.approve(marketplace, amount) first. The
    // contract then pulls via safeTransferFrom. msg.value must be zero.
    function payOrderERC20(uint256 orderId) external nonReentrant whenNotPaused orderExists(orderId) {
        Order storage order = orders[orderId];
        address token = order.paymentToken;
        if (token == address(0)) revert WrongPaymentMode();

        require(msg.sender == order.buyer, "Only buyer can pay this order");
        require(order.status == OrderStatus.Created, "Order must be Created");

        uint256 amount = order.amount;

        order.status = OrderStatus.Paid;
        order.paidAt = uint64(block.timestamp);

        emit OrderPaid(orderId, msg.sender, token, amount);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    // ---------------------------------------------------------------------
    // Signed payment authorization (V3.1 pattern, extended with paymentToken)
    // ---------------------------------------------------------------------
    function createAndPayWithAuth(
        PaymentAuth calldata auth,
        bytes calldata signature
    ) external payable nonReentrant whenNotPaused returns (uint256) {
        if (auth.buyer == address(0)) revert AuthZeroBuyer();
        if (block.timestamp > auth.deadline) revert AuthExpired(auth.deadline, block.timestamp);

        uint256 expectedNonce = authNonces[auth.buyer];
        if (auth.nonce != expectedNonce) revert AuthNonceMismatch(auth.nonce, expectedNonce);

        bytes32 structHash = keccak256(
            abi.encode(
                PAYMENT_AUTH_TYPEHASH,
                auth.buyer,
                auth.seller,
                auth.paymentToken,
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

        uint256 orderId = _createOrderFor(auth.buyer, auth.seller, auth.paymentToken, auth.productId, auth.amount);

        if (auth.paymentToken == address(0)) {
            if (msg.value != auth.amount) revert AuthAmountMismatch(auth.amount, msg.value);
            _payNative(auth.buyer, orderId, msg.value);
        } else {
            if (msg.value != 0) revert AuthAmountMismatch(auth.amount, msg.value);

            Order storage order = orders[orderId];
            order.status = OrderStatus.Paid;
            order.paidAt = uint64(block.timestamp);
            emit OrderPaid(orderId, auth.buyer, auth.paymentToken, auth.amount);

            IERC20(auth.paymentToken).safeTransferFrom(auth.buyer, address(this), auth.amount);
        }

        emit PaymentAuthExecuted(orderId, auth.buyer, msg.sender, auth.nonce);
        return orderId;
    }

    function invalidateNonce() external {
        uint256 old = authNonces[msg.sender];
        authNonces[msg.sender] = old + 1;
        emit NonceInvalidated(msg.sender, old, old + 1);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function paymentAuthTypehash() external pure returns (bytes32) {
        return PAYMENT_AUTH_TYPEHASH;
    }

    // ---------------------------------------------------------------------
    // Order lifecycle transitions (lifecycle identical to V3.1)
    // ---------------------------------------------------------------------
    function markShipped(uint256 orderId) external whenNotPaused orderExists(orderId) {
        Order storage order = orders[orderId];
        require(msg.sender == order.seller, "Only seller can mark shipped");
        require(order.status == OrderStatus.Paid, "Order must be Paid");

        order.status = OrderStatus.Shipped;
        order.shippedAt = uint64(block.timestamp);

        emit OrderShipped(orderId, msg.sender);
    }

    function confirmReceived(uint256 orderId) external nonReentrant whenNotPaused orderExists(orderId) {
        Order storage order = orders[orderId];
        require(msg.sender == order.buyer, "Only buyer can confirm receipt");
        require(order.status == OrderStatus.Shipped, "Order must be Shipped");

        _completeOrder(orderId, order);
    }

    function cancelOrder(uint256 orderId) external orderExists(orderId) {
        Order storage order = orders[orderId];
        require(msg.sender == order.buyer, "Only buyer can cancel this order");
        require(order.status == OrderStatus.Created, "Only Created orders can be cancelled");

        order.status = OrderStatus.Cancelled;
        emit OrderCancelled(orderId);
    }

    function openDispute(uint256 orderId) external whenNotPaused orderExists(orderId) {
        Order storage order = orders[orderId];
        require(msg.sender == order.buyer || msg.sender == order.seller, "Only buyer or seller can open dispute");
        require(
            order.status == OrderStatus.Paid || order.status == OrderStatus.Shipped,
            "Order must be Paid or Shipped"
        );

        order.status = OrderStatus.Disputed;
        order.disputedAt = uint64(block.timestamp);

        emit DisputeOpened(orderId, msg.sender);
    }

    function resolveDispute(
        uint256 orderId,
        bool refundBuyer
    ) external nonReentrant onlyOwner orderExists(orderId) {
        Order storage order = orders[orderId];
        require(order.status == OrderStatus.Disputed, "Order must be Disputed");
        require(
            block.timestamp >= uint256(order.disputedAt) + DISPUTE_RESOLUTION_DELAY,
            "Dispute resolution delay has not elapsed"
        );

        if (refundBuyer) {
            address buyer = order.buyer;
            address token = order.paymentToken;
            uint256 amount = order.amount;

            order.status = OrderStatus.Refunded;

            emit DisputeResolved(orderId, refundBuyer);
            emit OrderRefunded(orderId, buyer, amount);

            _payout(token, buyer, amount);
        } else {
            emit DisputeResolved(orderId, refundBuyer);
            _completeOrder(orderId, order);
        }
    }

    function _completeOrder(uint256 orderId, Order storage order) private {
        uint256 amount = order.amount;
        address seller = order.seller;
        address token = order.paymentToken;

        order.status = OrderStatus.Completed;
        order.completedAt = uint64(block.timestamp);

        emit OrderCompleted(orderId, seller, amount);

        _payout(token, seller, amount);
    }

    // Native: low-level call. ERC-20: SafeERC20. CEI is already enforced by
    // callers — every caller flips state before invoking _payout.
    function _payout(address token, address to, uint256 amount) private {
        if (token == address(0)) {
            (bool ok, ) = payable(to).call{value: amount}("");
            require(ok, "Native transfer failed");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------
    function getOrder(uint256 orderId) external view orderExists(orderId) returns (Order memory) {
        return orders[orderId];
    }

    function getBuyerOrders(address buyer) external view returns (uint256[] memory) {
        return buyerOrders[buyer];
    }

    function getSellerOrders(address seller) external view returns (uint256[] memory) {
        return sellerOrders[seller];
    }
}
