// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {FunctionsClient} from "@chainlink/contracts/src/v0.8/functions/v1_0_0/FunctionsClient.sol";
import {FunctionsRequest} from "@chainlink/contracts/src/v0.8/functions/v1_0_0/libraries/FunctionsRequest.sol";
import {EscrowVaultV3} from "./EscrowVaultV3.sol";

contract EscrowMarketplaceV3 is Ownable, FunctionsClient {
    using FunctionsRequest for FunctionsRequest.Request;

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
        uint256 productId;
        uint256 amount;
        uint64 shippedAt;
        uint64 completedAt;
        uint64 deliveredAt;
    }

    uint256 public nextOrderId;
    EscrowVaultV3 public immutable vault;
    address public immutable functionsRouter;
    uint64 public subscriptionId;
    bytes32 public donID;
    uint32 public callbackGasLimit;
    string public requestSource;
    bytes public encryptedSecretsReference;

    mapping(uint256 => Order) public orders;
    mapping(address => uint256[]) private buyerOrders;
    mapping(address => uint256[]) private sellerOrders;
    mapping(bytes32 => uint256) public deliveryRequestToOrderId;

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
    event DeliveryRequested(uint256 indexed orderId, bytes32 indexed requestId);
    event DeliveryRecorded(uint256 indexed orderId, uint64 timestamp);
    event DeliveryQueryFailed(uint256 indexed orderId, bytes32 indexed requestId, string reason);
    event OrderAutoCompleted(uint256 indexed orderId);

    modifier orderExists(uint256 orderId) {
        require(orderId > 0 && orderId < nextOrderId, "Order does not exist");
        _;
    }

    constructor(address vaultAddress, address routerAddress) Ownable(msg.sender) FunctionsClient(routerAddress) {
        require(vaultAddress != address(0), "Vault cannot be zero address");
        require(routerAddress != address(0), "Router cannot be zero address");

        nextOrderId = 1;
        vault = EscrowVaultV3(payable(vaultAddress));
        functionsRouter = routerAddress;
        callbackGasLimit = 300_000;
        requestSource = "return Functions.encodeString('pending')";
    }

    receive() external payable {
        revert("Direct ETH transfers are not allowed");
    }

    function createOrder(address seller, uint256 productId, uint256 amount) external returns (uint256) {
        return _createOrderInternal(seller, productId, amount);
    }

    function createAndPay(address seller, uint256 productId) external payable returns (uint256) {
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
            completedAt: 0,
            deliveredAt: 0
        });

        buyerOrders[msg.sender].push(orderId);
        sellerOrders[seller].push(orderId);

        emit OrderCreated(orderId, msg.sender, seller, productId, amount);

        return orderId;
    }

    function payOrder(uint256 orderId) external payable orderExists(orderId) {
        _payOrderInternal(orderId);
    }

    function _payOrderInternal(uint256 orderId) private {
        Order storage order = orders[orderId];

        require(msg.sender == order.buyer, "Only buyer can pay this order");
        require(order.status == OrderStatus.Created, "Order must be Created");
        require(msg.value == order.amount, "Payment amount must equal order amount");

        order.status = OrderStatus.Paid;
        order.paidAt = uint64(block.timestamp);

        emit OrderPaid(orderId, msg.sender, msg.value);

        vault.lockFunds{value: msg.value}(orderId);
    }

    function markShipped(uint256 orderId) external orderExists(orderId) {
        Order storage order = orders[orderId];

        require(msg.sender == order.seller, "Only seller can mark shipped");
        require(order.status == OrderStatus.Paid, "Order must be Paid");

        order.status = OrderStatus.Shipped;
        order.shippedAt = uint64(block.timestamp);

        emit OrderShipped(orderId, msg.sender);
    }

    function confirmReceived(uint256 orderId) external orderExists(orderId) {
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

    function resolveDispute(uint256 orderId, bool refundBuyer) external onlyOwner orderExists(orderId) {
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
            _completeOrder(orderId, order);
        }
    }

    function ownerEmergencyRefund(uint256 orderId) external onlyOwner orderExists(orderId) {
        Order storage order = orders[orderId];

        require(
            order.status == OrderStatus.Paid || order.status == OrderStatus.Shipped || order.status == OrderStatus.Disputed,
            "Order must have escrowed funds"
        );

        uint256 amount = order.amount;
        address buyer = order.buyer;

        order.status = OrderStatus.Refunded;

        emit OrderEmergencyRefunded(orderId, buyer, amount);

        vault.releaseTo(orderId, payable(buyer));
    }

    function requestDelivery(uint256 orderId) external orderExists(orderId) returns (bytes32) {
        Order storage order = orders[orderId];

        require(order.status == OrderStatus.Shipped, "Order must be Shipped");
        require(order.deliveredAt == 0, "Delivery already recorded");

        FunctionsRequest.Request memory request;
        request.initializeRequestForInlineJavaScript(requestSource);

        string[] memory args = new string[](1);
        args[0] = Strings.toString(orderId);
        request.setArgs(args);

        if (encryptedSecretsReference.length > 0) {
            request.addSecretsReference(encryptedSecretsReference);
        }

        bytes32 requestId = _sendRequest(request.encodeCBOR(), subscriptionId, callbackGasLimit, donID);
        deliveryRequestToOrderId[requestId] = orderId;

        emit DeliveryRequested(orderId, requestId);

        return requestId;
    }

    function setSubscriptionId(uint64 newSubscriptionId) external onlyOwner {
        subscriptionId = newSubscriptionId;
    }

    function setDonId(bytes32 newDonId) external onlyOwner {
        donID = newDonId;
    }

    function setCallbackGasLimit(uint32 newCallbackGasLimit) external onlyOwner {
        require(newCallbackGasLimit > 0, "Callback gas limit cannot be zero");
        callbackGasLimit = newCallbackGasLimit;
    }

    function setRequestSource(string calldata newRequestSource) external onlyOwner {
        require(bytes(newRequestSource).length > 0, "Request source cannot be empty");
        requestSource = newRequestSource;
    }

    function setEncryptedSecretsReference(bytes calldata newEncryptedSecretsReference) external onlyOwner {
        encryptedSecretsReference = newEncryptedSecretsReference;
    }

    function autoConfirmAfterDelivery(uint256 orderId) external orderExists(orderId) {
        Order storage order = orders[orderId];

        require(order.status == OrderStatus.Shipped, "Order must be Shipped");
        require(order.deliveredAt > 0, "Delivery not recorded");
        require(block.timestamp >= uint256(order.deliveredAt) + 10 days, "Auto-confirm delay has not passed");

        _completeOrder(orderId, order);

        emit OrderAutoCompleted(orderId);
    }

    function _completeOrder(uint256 orderId, Order storage order) private {
        uint256 amount = order.amount;
        address seller = order.seller;

        order.status = OrderStatus.Completed;
        order.completedAt = uint64(block.timestamp);

        emit OrderCompleted(orderId, seller, amount);

        vault.releaseTo(orderId, payable(seller));
    }

    function fulfillRequest(bytes32 requestId, bytes memory response, bytes memory err) internal override {
        uint256 orderId = deliveryRequestToOrderId[requestId];

        if (err.length > 0) {
            emit DeliveryQueryFailed(orderId, requestId, string(err));
            return;
        }

        (bool delivered, uint64 deliveredTimestamp) = abi.decode(response, (bool, uint64));

        if (!delivered) {
            return;
        }

        Order storage order = orders[orderId];

        if (order.status != OrderStatus.Shipped || order.deliveredAt != 0) {
            return;
        }

        order.deliveredAt = deliveredTimestamp;

        emit DeliveryRecorded(orderId, deliveredTimestamp);
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
