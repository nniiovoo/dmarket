// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EscrowVault} from "./EscrowVault.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// EscrowMarketplace v2: a single contract that owns all order lifecycle logic.
//
// Order state, status transitions, buyer/seller actions, dispute logic, and admin
// emergency paths all live here. They are kept together deliberately — they change
// together, fail together, and are understood together.
//
// Custody of ETH is delegated to a separate EscrowVault contract. The vault is the
// only contract in the system that holds funds, which isolates the single
// risk-classified concern from the rest of the product logic.
//
// Wiring requirement: after deployment, the vault owner must call
// vault.setMarketplace(<this contract's address>). Without that step, payOrder will
// revert because the vault refuses unauthorised callers.
contract EscrowMarketplaceV2 is Pausable, ReentrancyGuard {
    enum OrderStatus {
        Created, // 已创建，未付款
        Paid, // 已付款，资金锁在 vault
        Shipped, // 卖家已发货
        Completed, // 买家确认收货，资金已给卖家
        Cancelled, // 未付款前取消
        Disputed, // 争议中
        Refunded // 已退款给买家
    }

    // Struct fields are ordered to pack into 6 storage slots instead of the naive 10.
    //   slot 0: id
    //   slot 1: buyer (20) + status (1) + createdAt (8)   = 29 bytes
    //   slot 2: seller (20) + paidAt (8)                  = 28 bytes
    //   slot 3: productId
    //   slot 4: amount
    //   slot 5: shippedAt (8) + completedAt (8)           = 16 bytes
    // uint64 timestamps overflow at year ~584942417355, which is acceptable.
    struct Order {
        uint256 id;
        address buyer;
        OrderStatus status;
        uint64 createdAt;
        address seller;
        uint64 paidAt;
        uint256 productId;
        uint256 amount;
        uint64 shippedAt;
        uint64 completedAt;
    }

    address public immutable owner;
    uint256 public nextOrderId;
    EscrowVault public immutable vault;

    mapping(uint256 => Order) public orders;
    mapping(address => uint256[]) private buyerOrders;
    mapping(address => uint256[]) private sellerOrders;

    event OrderCreated(
        uint256 indexed orderId,
        address indexed buyer,
        address indexed seller,
        uint256 productId,
        uint256 amount
    );
    event OrderPaid(uint256 indexed orderId, address indexed buyer, uint256 amount);
    event OrderShipped(uint256 indexed orderId, address indexed seller);
    event OrderCompleted(uint256 indexed orderId, address indexed seller, uint256 amount);
    event OrderCancelled(uint256 indexed orderId);
    event DisputeOpened(uint256 indexed orderId, address indexed openedBy);
    event DisputeResolved(uint256 indexed orderId, bool refundBuyer);
    event OrderRefunded(uint256 indexed orderId, address indexed buyer, uint256 amount);
    event OrderEmergencyRefunded(uint256 indexed orderId, address indexed buyer, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call this function");
        _;
    }

    modifier orderExists(uint256 orderId) {
        require(orderId > 0 && orderId < nextOrderId, "Order does not exist");
        _;
    }

    constructor(address vaultAddress) {
        require(vaultAddress != address(0), "Vault cannot be zero address");

        owner = msg.sender;
        nextOrderId = 1;
        vault = EscrowVault(payable(vaultAddress));
    }

    // Owner-only emergency brake. When paused, new payments / shipments / receipts / disputes
    // are rejected. Existing escrowed orders can still be cancelled (if unpaid), refunded by
    // admin, or have their disputes resolved — these escape hatches must remain available.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // The marketplace itself never holds ETH. Funds always flow through the vault.
    receive() external payable {
        revert("Direct ETH transfers are not allowed");
    }

    // Buyer creates an unpaid order.
    function createOrder(address seller, uint256 productId, uint256 amount) external whenNotPaused returns (uint256) {
        return _createOrderInternal(seller, productId, amount);
    }

    // One-click buy: create the order and escrow funds in one transaction.
    // msg.value becomes the order amount.
    function createAndPay(address seller, uint256 productId) external payable nonReentrant whenNotPaused returns (uint256) {
        require(msg.value > 0, "Amount must be greater than zero");

        uint256 orderId = _createOrderInternal(seller, productId, msg.value);
        _payOrderInternal(orderId);

        return orderId;
    }

    function _createOrderInternal(address seller, uint256 productId, uint256 amount) private returns (uint256) {
        require(seller != address(0), "Seller cannot be zero address");
        require(seller != msg.sender, "Seller cannot be buyer");
        require(amount > 0, "Amount must be greater than zero");

        uint256 orderId = nextOrderId;
        nextOrderId++;

        orders[orderId] = Order({
            id: orderId,
            buyer: msg.sender,
            seller: seller,
            productId: productId,
            amount: amount,
            status: OrderStatus.Created,
            createdAt: uint64(block.timestamp),
            paidAt: 0,
            shippedAt: 0,
            completedAt: 0
        });

        buyerOrders[msg.sender].push(orderId);
        sellerOrders[seller].push(orderId);

        emit OrderCreated(orderId, msg.sender, seller, productId, amount);

        return orderId;
    }

    // Buyer pays for an order. The marketplace forwards the exact ETH to the vault.
    function payOrder(uint256 orderId) external payable nonReentrant whenNotPaused orderExists(orderId) {
        _payOrderInternal(orderId);
    }

    function _payOrderInternal(uint256 orderId) private {
        Order storage order = orders[orderId];

        require(msg.sender == order.buyer, "Only buyer can pay this order");
        require(order.status == OrderStatus.Created, "Order must be Created");
        require(msg.value == order.amount, "Payment amount must equal order amount");

        // CEI: update state before forwarding to vault.
        order.status = OrderStatus.Paid;
        order.paidAt = uint64(block.timestamp);

        emit OrderPaid(orderId, msg.sender, msg.value);

        vault.lockFunds{value: msg.value}(orderId);
    }

    // Seller marks a paid order as shipped.
    function markShipped(uint256 orderId) external whenNotPaused orderExists(orderId) {
        Order storage order = orders[orderId];

        require(msg.sender == order.seller, "Only seller can mark shipped");
        require(order.status == OrderStatus.Paid, "Order must be Paid");

        order.status = OrderStatus.Shipped;
        order.shippedAt = uint64(block.timestamp);

        emit OrderShipped(orderId, msg.sender);
    }

    // Buyer confirms receipt — the vault releases ETH to the seller.
    function confirmReceived(uint256 orderId) external nonReentrant whenNotPaused orderExists(orderId) {
        Order storage order = orders[orderId];

        require(msg.sender == order.buyer, "Only buyer can confirm receipt");
        require(order.status == OrderStatus.Shipped, "Order must be Shipped");

        uint256 amount = order.amount;
        address seller = order.seller;

        // CEI: order status flipped before the vault transfer.
        order.status = OrderStatus.Completed;
        order.completedAt = uint64(block.timestamp);

        emit OrderCompleted(orderId, seller, amount);

        vault.releaseTo(orderId, payable(seller));
    }

    // Buyer cancels their order before payment.
    function cancelOrder(uint256 orderId) external orderExists(orderId) {
        Order storage order = orders[orderId];

        require(msg.sender == order.buyer, "Only buyer can cancel this order");
        require(order.status == OrderStatus.Created, "Only Created orders can be cancelled");

        order.status = OrderStatus.Cancelled;

        emit OrderCancelled(orderId);
    }

    // Buyer or seller opens a dispute while funds are escrowed.
    function openDispute(uint256 orderId) external whenNotPaused orderExists(orderId) {
        Order storage order = orders[orderId];

        require(msg.sender == order.buyer || msg.sender == order.seller, "Only buyer or seller can open dispute");
        require(
            order.status == OrderStatus.Paid || order.status == OrderStatus.Shipped,
            "Order must be Paid or Shipped"
        );

        order.status = OrderStatus.Disputed;

        emit DisputeOpened(orderId, msg.sender);
    }

    // Owner resolves a dispute by either refunding the buyer or paying the seller.
    function resolveDispute(uint256 orderId, bool refundBuyer) external nonReentrant onlyOwner orderExists(orderId) {
        Order storage order = orders[orderId];

        require(order.status == OrderStatus.Disputed, "Order must be Disputed");

        uint256 amount = order.amount;

        emit DisputeResolved(orderId, refundBuyer);

        if (refundBuyer) {
            address buyer = order.buyer;

            order.status = OrderStatus.Refunded;

            emit OrderRefunded(orderId, buyer, amount);

            vault.releaseTo(orderId, payable(buyer));
        } else {
            address seller = order.seller;

            order.status = OrderStatus.Completed;
            order.completedAt = uint64(block.timestamp);

            emit OrderCompleted(orderId, seller, amount);

            vault.releaseTo(orderId, payable(seller));
        }
    }

    // Owner-only escape hatch: refund a buyer directly without requiring a dispute.
    // Valid in any state where the vault still holds the order's funds.
    function ownerEmergencyRefund(uint256 orderId) external nonReentrant onlyOwner orderExists(orderId) {
        Order storage order = orders[orderId];

        require(
            order.status == OrderStatus.Paid ||
                order.status == OrderStatus.Shipped ||
                order.status == OrderStatus.Disputed,
            "Order must have escrowed funds"
        );

        uint256 amount = order.amount;
        address buyer = order.buyer;

        order.status = OrderStatus.Refunded;

        emit OrderEmergencyRefunded(orderId, buyer, amount);

        vault.releaseTo(orderId, payable(buyer));
    }

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
