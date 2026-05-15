// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {FunctionsClient} from "@chainlink/contracts/src/v0.8/functions/v1_0_0/FunctionsClient.sol";
import {FunctionsRequest} from "@chainlink/contracts/src/v0.8/functions/v1_0_0/libraries/FunctionsRequest.sol";
import {EscrowVaultV3} from "./EscrowVaultV3.sol";

interface IEvidenceRegistryV3 {
    function marketplace() external view returns (address);
}

contract EscrowMarketplaceV3 is Ownable2Step, Pausable, ReentrancyGuard, FunctionsClient {
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
        uint64 disputedAt;
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
    uint64 public constant DELIVERY_REQUEST_COOLDOWN = 1 hours;
    mapping(uint256 => uint64) public lastDeliveryRequestAt;
    struct PendingSource {
        bytes32 sourceHash;
        uint64 readyAt;
    }

    uint64 public constant REQUEST_SOURCE_DELAY = 7 days;
    uint64 public constant EMERGENCY_REFUND_PAID_DELAY = 30 days;
    uint64 public constant EMERGENCY_REFUND_SHIPPED_DELAY = 60 days;
    uint64 public constant DISPUTE_RESOLUTION_DELAY = 3 days;
    PendingSource public pendingRequestSource;
    address public evidenceRegistry;

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
    event SubscriptionIdUpdated(uint64 oldSubscriptionId, uint64 newSubscriptionId);
    event DonIdUpdated(bytes32 oldDonId, bytes32 newDonId);
    event CallbackGasLimitUpdated(uint32 oldCallbackGasLimit, uint32 newCallbackGasLimit);
    event RequestSourceUpdated(bytes32 indexed sourceHash, uint256 length);
    event EncryptedSecretsReferenceUpdated(bytes32 indexed referenceHash, uint256 length);
    event RequestSourceProposed(bytes32 indexed sourceHash, uint256 length, uint64 readyAt);
    event RequestSourceProposalCancelled(bytes32 indexed sourceHash);
    event EvidenceRegistryUpdated(address indexed oldRegistry, address indexed newRegistry);

    modifier orderExists(uint256 orderId) {
        require(orderId > 0 && orderId < nextOrderId, "Order does not exist");
        _;
    }

    constructor(
        address vaultAddress,
        address routerAddress,
        string memory initialRequestSource
    ) Ownable(msg.sender) FunctionsClient(routerAddress) {
        require(vaultAddress != address(0), "Vault cannot be zero address");
        require(routerAddress != address(0), "Router cannot be zero address");
        require(bytes(initialRequestSource).length > 0, "Initial request source cannot be empty");

        nextOrderId = 1;
        vault = EscrowVaultV3(payable(vaultAddress));
        functionsRouter = routerAddress;
        callbackGasLimit = 300_000;
        requestSource = initialRequestSource;
    }

    receive() external payable {
        revert("Direct ETH transfers are not allowed");
    }

    // Owner-only emergency brake. When paused, new payments / shipments / receipts /
    // disputes / delivery requests are rejected. cancelOrder, resolveDispute, and
    // ownerEmergencyRefund stay available so locked funds can always be unwound.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function createOrder(address seller, uint256 productId, uint256 amount) external whenNotPaused returns (uint256) {
        return _createOrderFor(msg.sender, seller, productId, amount);
    }

    function createAndPay(address seller, uint256 productId) external payable nonReentrant whenNotPaused returns (uint256) {
        require(msg.value > 0, "Amount must be greater than zero");

        uint256 orderId = _createOrderFor(msg.sender, seller, productId, msg.value);
        _payOrderFor(msg.sender, orderId, msg.value);

        return orderId;
    }

    // Internal so V3.1 (signed-auth payment) can reuse the same logic while
    // supplying the buyer explicitly (the relayer is msg.sender, not the buyer).
    function _createOrderFor(
        address buyer,
        address seller,
        uint256 productId,
        uint256 amount
    ) internal returns (uint256) {
        require(seller != address(0), "Seller cannot be zero address");
        require(seller != buyer, "Seller cannot be buyer");
        require(amount > 0, "Amount must be greater than zero");

        uint256 orderId = nextOrderId;
        nextOrderId++;

        orders[orderId] = Order({
            id: orderId,
            buyer: buyer,
            seller: seller,
            productId: productId,
            amount: amount,
            status: OrderStatus.Created,
            createdAt: uint64(block.timestamp),
            paidAt: 0,
            shippedAt: 0,
            completedAt: 0,
            deliveredAt: 0,
            disputedAt: 0
        });

        buyerOrders[buyer].push(orderId);
        sellerOrders[seller].push(orderId);

        emit OrderCreated(orderId, buyer, seller, productId, amount);

        return orderId;
    }

    function payOrder(uint256 orderId) external payable nonReentrant whenNotPaused orderExists(orderId) {
        _payOrderFor(msg.sender, orderId, msg.value);
    }

    function _payOrderFor(address buyer, uint256 orderId, uint256 value) internal {
        Order storage order = orders[orderId];

        require(buyer == order.buyer, "Only buyer can pay this order");
        require(order.status == OrderStatus.Created, "Order must be Created");
        require(value == order.amount, "Payment amount must equal order amount");

        order.status = OrderStatus.Paid;
        order.paidAt = uint64(block.timestamp);

        emit OrderPaid(orderId, buyer, value);

        vault.lockFunds{value: value}(orderId, order.buyer, order.seller);
    }

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

    function resolveDispute(uint256 orderId, bool refundBuyer) external nonReentrant onlyOwner orderExists(orderId) {
        Order storage order = orders[orderId];

        require(order.status == OrderStatus.Disputed, "Order must be Disputed");
        require(
            block.timestamp >= uint256(order.disputedAt) + DISPUTE_RESOLUTION_DELAY,
            "Dispute resolution delay has not elapsed"
        );

        uint256 amount = order.amount;

        emit DisputeResolved(orderId, refundBuyer);

        if (refundBuyer) {
            address buyer = order.buyer;

            order.status = OrderStatus.Refunded;

            emit OrderRefunded(orderId, buyer, amount);

            vault.releaseToBuyer(orderId);
        } else {
            _completeOrder(orderId, order);
        }
    }

    function ownerEmergencyRefund(uint256 orderId) external nonReentrant onlyOwner orderExists(orderId) {
        Order storage order = orders[orderId];

        if (order.status == OrderStatus.Paid) {
            require(
                block.timestamp >= uint256(order.paidAt) + EMERGENCY_REFUND_PAID_DELAY,
                "Order not stale enough for emergency refund"
            );
        } else if (order.status == OrderStatus.Shipped) {
            require(
                block.timestamp >= uint256(order.shippedAt) + EMERGENCY_REFUND_SHIPPED_DELAY,
                "Order not stale enough for emergency refund"
            );
        } else {
            revert("Order must be Paid or Shipped");
        }

        uint256 amount = order.amount;
        address buyer = order.buyer;

        order.status = OrderStatus.Refunded;

        emit OrderEmergencyRefunded(orderId, buyer, amount);

        vault.releaseToBuyer(orderId);
    }

    function requestDelivery(uint256 orderId) external whenNotPaused orderExists(orderId) returns (bytes32) {
        Order storage order = orders[orderId];

        require(order.status == OrderStatus.Shipped, "Order must be Shipped");
        require(order.deliveredAt == 0, "Delivery already recorded");
        require(
            block.timestamp >= uint256(lastDeliveryRequestAt[orderId]) + DELIVERY_REQUEST_COOLDOWN,
            "Delivery request cooldown"
        );
        lastDeliveryRequestAt[orderId] = uint64(block.timestamp);

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
        uint64 oldSubscriptionId = subscriptionId;
        subscriptionId = newSubscriptionId;
        emit SubscriptionIdUpdated(oldSubscriptionId, newSubscriptionId);
    }

    function setDonId(bytes32 newDonId) external onlyOwner {
        bytes32 oldDonId = donID;
        donID = newDonId;
        emit DonIdUpdated(oldDonId, newDonId);
    }

    function setCallbackGasLimit(uint32 newCallbackGasLimit) external onlyOwner {
        require(newCallbackGasLimit > 0, "Callback gas limit cannot be zero");
        uint32 oldCallbackGasLimit = callbackGasLimit;
        callbackGasLimit = newCallbackGasLimit;
        emit CallbackGasLimitUpdated(oldCallbackGasLimit, newCallbackGasLimit);
    }

    function setEvidenceRegistry(address newRegistry) external onlyOwner {
        if (newRegistry != address(0)) {
            require(
                IEvidenceRegistryV3(newRegistry).marketplace() == address(this),
                "Registry marketplace mismatch"
            );
        }
        address oldRegistry = evidenceRegistry;
        evidenceRegistry = newRegistry;
        emit EvidenceRegistryUpdated(oldRegistry, newRegistry);
    }

    function proposeRequestSource(string calldata newRequestSource) external onlyOwner {
        require(bytes(newRequestSource).length > 0, "Request source cannot be empty");
        require(pendingRequestSource.sourceHash == bytes32(0), "Existing proposal must be cancelled first");

        bytes32 hash = keccak256(bytes(newRequestSource));
        uint64 readyAt = uint64(block.timestamp) + REQUEST_SOURCE_DELAY;

        pendingRequestSource = PendingSource({ sourceHash: hash, readyAt: readyAt });

        emit RequestSourceProposed(hash, bytes(newRequestSource).length, readyAt);
    }

    function commitRequestSource(string calldata newRequestSource) external onlyOwner {
        bytes32 hash = keccak256(bytes(newRequestSource));
        require(pendingRequestSource.sourceHash == hash, "Source does not match pending proposal");
        require(block.timestamp >= pendingRequestSource.readyAt, "Proposal delay has not elapsed");

        requestSource = newRequestSource;
        delete pendingRequestSource;

        emit RequestSourceUpdated(hash, bytes(newRequestSource).length);
    }

    function cancelPendingRequestSource() external onlyOwner {
        bytes32 hash = pendingRequestSource.sourceHash;
        require(hash != bytes32(0), "No pending proposal");

        delete pendingRequestSource;

        emit RequestSourceProposalCancelled(hash);
    }

    function setEncryptedSecretsReference(bytes calldata newEncryptedSecretsReference) external onlyOwner {
        encryptedSecretsReference = newEncryptedSecretsReference;
        emit EncryptedSecretsReferenceUpdated(
            keccak256(newEncryptedSecretsReference),
            newEncryptedSecretsReference.length
        );
    }

    function autoConfirmAfterDelivery(uint256 orderId) external nonReentrant whenNotPaused orderExists(orderId) {
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

        vault.releaseToSeller(orderId);
    }

    function fulfillRequest(bytes32 requestId, bytes memory response, bytes memory err) internal override {
        uint256 orderId = deliveryRequestToOrderId[requestId];

        if (orderId == 0) {
            // Unknown or already-handled requestId — drop silently.
            return;
        }

        delete deliveryRequestToOrderId[requestId];

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

        // M2: sanity-check the DON-supplied timestamp. Must be no earlier than
        // shippedAt and no later than the current block.
        if (deliveredTimestamp < order.shippedAt || deliveredTimestamp > uint64(block.timestamp)) {
            emit DeliveryQueryFailed(orderId, requestId, "Invalid delivered timestamp");
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
