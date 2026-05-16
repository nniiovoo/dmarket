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

interface IShopNFTMinimal {
    function shopIdOf(address seller) external view returns (uint256);
}

interface IRevenueDistributor {
    function deposit(uint256 shopId) external payable;

    function depositERC20(uint256 shopId, address token, uint256 amount) external;
}

/// @title EscrowMarketplaceV3_3 (Phase K.3b draft)
/// @notice Stablecoin-aware escrow marketplace that routes a platform
///         fee into the RevenueDistributor on every completed order.
///         All v3.2 lifecycle semantics are preserved.
/// @custom:status WIP-DRAFT — NOT AUDITED — DO NOT DEPLOY TO MAINNET
///
/// =====================================================================
/// WHY THIS IS A FRESH CONTRACT, NOT AN UPGRADE / INHERITANCE OF V3.2
/// ---------------------------------------------------------------------
/// V3.2 is frozen (see contracts/v3_2/EscrowMarketplaceERC20.sol header).
/// V3.3 adds two pieces of new state every order needs (`shopId` snapshot,
/// `distributor` wiring) and a new external call on order completion.
/// Inheriting v3.2 would force us to either (a) keep the `Order` struct
/// shape and shoehorn shopId into a side mapping — bad for invariants,
/// good for nothing — or (b) override functions that touch internal
/// state and rely on the override surviving every v3.2 patch. v3.2 is
/// frozen, so (b) is OK in principle, but the contract is small enough
/// that a flat copy with explicit, easy-to-audit diffs is preferable.
///
/// Diffs vs v3.2:
///   - constructor takes (shopNft, distributor); EIP-712 domain is
///     `ChainUsEscrowV3_3` / `"3.3"` so v3.2 signatures DO NOT cross-
///     authenticate against v3.3 and vice versa.
///   - `Order` carries a `shopId` snapshot recorded at create time.
///     If the seller transfers their ShopNFT after the order is
///     created, revenue still routes to the *historical* shopId —
///     this is the investor invariant: shareholders are insulated
///     from operator transfers on already-in-flight orders.
///   - `_createOrderFor` reads `shopNft.shopIdOf(seller)` and reverts
///     `NoShopAssociated(seller)` if the seller has no ShopNFT.
///   - `_completeOrder` splits the order amount into a configurable
///     fee (default 100 bps = 1 %) and a seller payout. Fee goes via
///     `distributor.deposit{value: fee}(shopId)` (native) or
///     `forceApprove + depositERC20(shopId, token, fee)` (ERC-20).
///   - Cancel / refund paths do NOT route to the distributor —
///     refunds are full-amount returns to the buyer.
///   - `feeRateBps` is owner-tunable up to `MAX_FEE_BPS = 1000` (10 %).
/// =====================================================================
contract EscrowMarketplaceV3_3 is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
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

    /// `shopId` is the v3.3-specific field. It is set once at create
    /// time and never updated, so dispute / refund flows agree on the
    /// same revenue destination they would have used at completion.
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
        uint256 shopId;
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
    uint16 public constant MAX_FEE_BPS = 1000; // 10 %

    IShopNFTMinimal public immutable shopNft;
    IRevenueDistributor public distributor;
    address public feeRecipient;
    uint16 public feeRateBps;

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
        uint256 shopId,
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
    event DistributorUpdated(address indexed oldDistributor, address indexed newDistributor);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event FeeRateUpdated(uint16 oldBps, uint16 newBps);
    event RevenueDistributed(
        uint256 indexed orderId,
        uint256 indexed shopId,
        address token,
        uint256 fee,
        uint256 sellerAmount
    );

    error TokenNotAccepted(address token);
    error WrongPaymentMode();
    error AuthExpired(uint256 deadline, uint256 nowTs);
    error AuthAmountMismatch(uint256 authAmount, uint256 sentValue);
    error AuthNonceMismatch(uint256 authNonce, uint256 expectedNonce);
    error AuthInvalidSignature(address recovered, address expected);
    error AuthZeroBuyer();
    error NoShopAssociated(address seller);
    error InvalidFeeBps(uint16 bps);
    error ZeroDistributor();
    error ZeroShopNFT();

    modifier orderExists(uint256 orderId) {
        require(orderId > 0 && orderId < nextOrderId, "Order does not exist");
        _;
    }

    constructor(address _shopNft, address _distributor)
        Ownable(msg.sender)
        EIP712("ChainUsEscrowV3_3", "3.3")
    {
        if (_shopNft == address(0)) revert ZeroShopNFT();
        if (_distributor == address(0)) revert ZeroDistributor();
        shopNft = IShopNFTMinimal(_shopNft);
        distributor = IRevenueDistributor(_distributor);
        feeRecipient = msg.sender;
        feeRateBps = 100; // 1 %
        nextOrderId = 1;
    }

    // Marketplace custodies funds itself for the ERC-20 lane (mirrors v3.2).
    // Direct sends are rejected so every native payment is paired with an
    // explicit order-state transition.
    receive() external payable {
        revert("Direct ETH transfers are not allowed");
    }

    // ---------------------------------------------------------------------
    // Owner: emergency brake + allowlist + v3.3 admin
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

    function setDistributor(address newDistributor) external onlyOwner {
        if (newDistributor == address(0)) revert ZeroDistributor();
        emit DistributorUpdated(address(distributor), newDistributor);
        distributor = IRevenueDistributor(newDistributor);
    }

    function setFeeRateBps(uint16 newBps) external onlyOwner {
        if (newBps > MAX_FEE_BPS) revert InvalidFeeBps(newBps);
        emit FeeRateUpdated(feeRateBps, newBps);
        feeRateBps = newBps;
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        require(newRecipient != address(0), "Recipient cannot be zero");
        emit FeeRecipientUpdated(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
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

        uint256 shopId = shopNft.shopIdOf(seller);
        if (shopId == 0) revert NoShopAssociated(seller);

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
            disputedAt: 0,
            shopId: shopId
        });

        buyerOrders[buyer].push(orderId);
        sellerOrders[seller].push(orderId);

        emit OrderCreated(orderId, buyer, seller, shopId, paymentToken, productId, amount);
        return orderId;
    }

    // ---------------------------------------------------------------------
    // Payment paths
    // ---------------------------------------------------------------------
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
    // Signed payment authorization (v3.1 / v3.2 pattern)
    // Note: EIP-712 domain name "ChainUsEscrowV3_3" / version "3.3" so a
    // v3.2 PaymentAuth signature CANNOT be replayed against a v3.3
    // deployment and vice versa.
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
    // Order lifecycle transitions (identical to v3.2 except _completeOrder
    // routes a fee to the distributor)
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
            // Refund path: no fee, no distributor call. Buyer is made whole.
            address buyer = order.buyer;
            address token = order.paymentToken;
            uint256 amount = order.amount;

            order.status = OrderStatus.Refunded;

            emit DisputeResolved(orderId, refundBuyer);
            emit OrderRefunded(orderId, buyer, amount);

            _payout(token, buyer, amount);
        } else {
            // Award-seller path: same revenue split as voluntary completion.
            emit DisputeResolved(orderId, refundBuyer);
            _completeOrder(orderId, order);
        }
    }

    function _completeOrder(uint256 orderId, Order storage order) private {
        uint256 amount = order.amount;
        address seller = order.seller;
        address token = order.paymentToken;
        uint256 shopId = order.shopId;

        order.status = OrderStatus.Completed;
        order.completedAt = uint64(block.timestamp);

        emit OrderCompleted(orderId, seller, amount);

        uint256 fee = (amount * feeRateBps) / 10_000;
        uint256 sellerAmount = amount - fee;

        // Seller payout first. _payout reverts on failure, which rolls
        // the whole tx back including the fee route below.
        _payout(token, seller, sellerAmount);

        if (fee > 0) {
            if (token == address(0)) {
                // Distributor receives via plain `deposit{value}` —
                // its `_accrue` updates the per-share index.
                distributor.deposit{value: fee}(shopId);
            } else {
                // Pull pattern. forceApprove handles USDT-style tokens
                // that require allowance == 0 before re-approval, and
                // we rely on distributor.depositERC20 to consume the
                // full allowance via safeTransferFrom — but we still
                // clear the residual to address(0) below in case a
                // future distributor implementation pulls less.
                IERC20(token).forceApprove(address(distributor), fee);
                distributor.depositERC20(shopId, token, fee);
                IERC20(token).forceApprove(address(distributor), 0);
            }
            emit RevenueDistributed(orderId, shopId, token, fee, sellerAmount);
        }
    }

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
