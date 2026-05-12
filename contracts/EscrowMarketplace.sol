// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract EscrowMarketplace {
    // Order lifecycle:
    // Created -> Paid -> Shipped -> Completed
    // Created -> Cancelled
    // Paid/Shipped -> Disputed -> Refunded/Completed
    enum OrderStatus {
        Created, // 已创建，未付款
        Paid, // 已付款，资金在合约中
        Shipped, // 卖家已发货
        Completed, // 买家确认收货，资金已给卖家
        Cancelled, // 未付款前取消
        Disputed, // 争议中
        Refunded // 已退款给买家
    }

    struct Order {
        uint256 id;
        address buyer;
        address seller;
        uint256 productId;
        uint256 amount;
        OrderStatus status;
        uint256 createdAt;
        uint256 paidAt;
        uint256 shippedAt;
        uint256 completedAt;
    }

    address public owner;
    uint256 public nextOrderId;

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

    constructor() {
        owner = msg.sender;
        nextOrderId = 1;
    }

    // 禁止用户绕过订单流程直接给合约转 ETH。
    receive() external payable {
        revert("Direct ETH transfers are not allowed");
    }

    // OrderManager: buyer creates an unpaid order.
    function createOrder(address seller, uint256 productId, uint256 amount) external returns (uint256) {
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
            createdAt: block.timestamp,
            paidAt: 0,
            shippedAt: 0,
            completedAt: 0
        });

        buyerOrders[msg.sender].push(orderId);
        sellerOrders[seller].push(orderId);

        emit OrderCreated(orderId, msg.sender, seller, productId, amount);

        return orderId;
    }

    // Escrow: buyer pays exact ETH amount into contract custody.
    function payOrder(uint256 orderId) external payable orderExists(orderId) {
        Order storage order = orders[orderId];

        require(msg.sender == order.buyer, "Only buyer can pay this order");
        require(order.status == OrderStatus.Created, "Order must be Created");
        require(msg.value == order.amount, "Payment amount must equal order amount");

        order.status = OrderStatus.Paid;
        order.paidAt = block.timestamp;

        emit OrderPaid(orderId, msg.sender, msg.value);
    }

    // OrderManager: seller marks a paid order as shipped.
    function markShipped(uint256 orderId) external orderExists(orderId) {
        Order storage order = orders[orderId];

        require(msg.sender == order.seller, "Only seller can mark shipped");
        require(order.status == OrderStatus.Paid, "Order must be Paid");

        order.status = OrderStatus.Shipped;
        order.shippedAt = block.timestamp;

        emit OrderShipped(orderId, msg.sender);
    }

    // Escrow: buyer confirms receipt, then the contract releases ETH to seller.
    function confirmReceived(uint256 orderId) external orderExists(orderId) {
        Order storage order = orders[orderId];

        require(msg.sender == order.buyer, "Only buyer can confirm receipt");
        require(order.status == OrderStatus.Shipped, "Order must be Shipped");

        uint256 amount = order.amount;
        address seller = order.seller;

        // Update state before external call to reduce reentrancy risk.
        order.status = OrderStatus.Completed;
        order.completedAt = block.timestamp;

        (bool success, ) = seller.call{value: amount}("");
        require(success, "ETH transfer to seller failed");

        emit OrderCompleted(orderId, seller, amount);
    }

    // OrderManager: buyer can cancel only before payment.
    function cancelOrder(uint256 orderId) external orderExists(orderId) {
        Order storage order = orders[orderId];

        require(msg.sender == order.buyer, "Only buyer can cancel this order");
        require(order.status == OrderStatus.Created, "Only Created orders can be cancelled");

        order.status = OrderStatus.Cancelled;

        emit OrderCancelled(orderId);
    }

    // SimpleDisputeManager: buyer or seller can open a dispute while funds are escrowed.
    function openDispute(uint256 orderId) external orderExists(orderId) {
        Order storage order = orders[orderId];

        require(msg.sender == order.buyer || msg.sender == order.seller, "Only buyer or seller can open dispute");
        require(
            order.status == OrderStatus.Paid || order.status == OrderStatus.Shipped,
            "Order must be Paid or Shipped"
        );

        order.status = OrderStatus.Disputed;

        emit DisputeOpened(orderId, msg.sender);
    }

    // SimpleDisputeManager: owner decides whether to refund buyer or release ETH to seller.
    function resolveDispute(uint256 orderId, bool refundBuyer) external onlyOwner orderExists(orderId) {
        Order storage order = orders[orderId];

        require(order.status == OrderStatus.Disputed, "Order must be Disputed");

        uint256 amount = order.amount;

        if (refundBuyer) {
            address buyer = order.buyer;

            // Update state before external call to reduce reentrancy risk.
            order.status = OrderStatus.Refunded;

            (bool success, ) = buyer.call{value: amount}("");
            require(success, "ETH refund to buyer failed");

            emit OrderRefunded(orderId, buyer, amount);
        } else {
            address seller = order.seller;

            // Update state before external call to reduce reentrancy risk.
            order.status = OrderStatus.Completed;
            order.completedAt = block.timestamp;

            (bool success, ) = seller.call{value: amount}("");
            require(success, "ETH transfer to seller failed");

            emit OrderCompleted(orderId, seller, amount);
        }

        emit DisputeResolved(orderId, refundBuyer);
    }

    // Escrow/Admin: owner can refund stuck escrowed funds without buyer/seller opening a dispute.
    function ownerEmergencyRefund(uint256 orderId) external onlyOwner orderExists(orderId) {
        Order storage order = orders[orderId];

        require(
            order.status == OrderStatus.Paid || order.status == OrderStatus.Shipped || order.status == OrderStatus.Disputed,
            "Order must have escrowed funds"
        );

        uint256 amount = order.amount;
        address buyer = order.buyer;

        // Update state before external call to reduce reentrancy risk.
        order.status = OrderStatus.Refunded;

        (bool success, ) = buyer.call{value: amount}("");
        require(success, "ETH refund to buyer failed");

        emit OrderEmergencyRefunded(orderId, buyer, amount);
    }

    // OrderManager: return full order details.
    function getOrder(uint256 orderId) external view orderExists(orderId) returns (Order memory) {
        return orders[orderId];
    }

    // OrderManager: return every order id created by a buyer.
    function getBuyerOrders(address buyer) external view returns (uint256[] memory) {
        return buyerOrders[buyer];
    }

    // OrderManager: return every order id assigned to a seller.
    function getSellerOrders(address seller) external view returns (uint256[] memory) {
        return sellerOrders[seller];
    }
}
