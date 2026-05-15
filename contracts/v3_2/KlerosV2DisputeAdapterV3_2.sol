// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IArbitratorV2} from "../v3/IArbitratorV2.sol";
import {IArbitrableV2} from "../v3/IArbitrableV2.sol";

// Minimal interface to the v3.2 marketplace. Mirrors the Order struct
// shape so we can read getOrder() without importing the full marketplace.
// Field order MUST match EscrowMarketplaceERC20.Order exactly — the ABI
// decoder is positional.
interface IEscrowMarketplaceERC20Adapter {
    enum OrderStatus { Created, Paid, Shipped, Completed, Cancelled, Disputed, Refunded }
    struct Order {
        uint256 id;
        address buyer;
        OrderStatus status;
        uint64 createdAt;
        address seller;
        uint64 paidAt;
        address paymentToken;
        uint64 shippedAt;
        uint64 completedAt;
        uint64 disputedAt;
        uint256 productId;
        uint256 amount;
    }
    function getOrder(uint256 orderId) external view returns (Order memory);
    function resolveDispute(uint256 orderId, bool refundBuyer) external;
    function acceptOwnership() external;
}

/// @title KlerosV2DisputeAdapterV3_2
/// @notice Pull-mode Kleros integration for EscrowMarketplaceERC20.
/// @custom:status WIP-DRAFT — NOT AUDITED — DO NOT DEPLOY TO MAINNET
///
/// =====================================================================
/// WHY-PULL-MODE
/// ---------------------------------------------------------------------
/// EscrowMarketplaceERC20 (v3.2) is frozen and has no hook to notify an
/// external arbitrator on openDispute. The v3 adapter relies on the v3
/// marketplace calling adapter.createDispute() inline — we cannot
/// replicate that without modifying v3.2.
///
/// Pull-mode: any party calls adapter.escalateToKleros(orderId). The
/// adapter reads marketplace.getOrder(orderId), asserts status ==
/// Disputed, pays the Kleros arbitration cost, and tracks orderId ↔
/// klerosDisputeId. When Kleros rules, adapter.rule(disputeId, ruling)
/// → adapter calls marketplace.resolveDispute(orderId, refundBuyer).
///
/// CONSTRAINT: marketplace ownership MUST be transferred to this
/// adapter for resolveDispute to succeed. Once transferred, the only
/// ways the marketplace owner role can resolve a dispute are:
///   1. Kleros rule() callback (the happy path).
///   2. This adapter's propose/execute timelocked emergencyRefund flow
///      (only after KLEROS_TIMEOUT since escalation).
///   3. The adapter owner's `executeOnMarketplace` pass-through, which
///      lets the owner invoke any marketplace owner-only function. This
///      is the equivalent of "trust the owner" and is gated by the
///      Ownable2Step admin chain (multisig in production).
/// =====================================================================
contract KlerosV2DisputeAdapterV3_2 is Ownable2Step, IArbitrableV2 {
    IArbitratorV2 public immutable arbitrator;
    IEscrowMarketplaceERC20Adapter public immutable marketplace;

    // Kleros ruling encoding for our 2-choice dispute:
    // 0 = RefuseToArbitrate (jurors decline) — defaults to refund buyer
    //     (conservative: protect buyer when arbitration outcome is unclear).
    // 1 = BuyerWins (refund buyer).
    // 2 = SellerWins (release to seller).
    uint256 public constant RULING_REFUSE = 0;
    uint256 public constant RULING_BUYER = 1;
    uint256 public constant RULING_SELLER = 2;

    // Time gates for the emergency refund path. KLEROS_TIMEOUT keeps the
    // owner from racing Kleros; EMERGENCY_TIMELOCK gives the public a
    // window to react if the owner proposes a malicious resolution.
    uint64 public constant KLEROS_TIMEOUT = 30 days;
    uint64 public constant EMERGENCY_TIMELOCK = 7 days;

    bytes public arbitratorExtraData;
    uint256 public templateId;
    string public templateRegistryURI;

    // klerosDisputeIdByOrder stores the raw Kleros disputeId (may be 0).
    // Use orderEscalated to check "has this order been escalated?" — not
    // klerosDisputeIdByOrder != 0, because Kleros V2 can legitimately
    // assign disputeId 0 to the first dispute on a fresh court.
    mapping(uint256 => uint256) public klerosDisputeIdByOrder;
    mapping(uint256 => bool) public orderEscalated;
    mapping(uint256 => uint256) public orderIdByDispute;
    mapping(uint256 => uint256) public escalatedAt;

    // Pending ruling waiting to be applied — used if Kleros rules within
    // the marketplace's 3-day DISPUTE_RESOLUTION_DELAY window. v3.2's
    // resolveDispute reverts on early calls, so we defer-and-retry.
    mapping(uint256 => uint256) public pendingRulings;

    // Emergency refund proposals (separate from Kleros).
    mapping(uint256 => uint256) public emergencyProposedAt;
    mapping(uint256 => bool) public emergencyRefundBuyer;

    // Pull-payment refunds for over-paid escalation fees.
    mapping(address => uint256) public pendingRefunds;

    event DisputeEscalated(uint256 indexed orderId, uint256 indexed klerosDisputeId, address indexed by, uint256 feePaid);
    event DisputeRuled(uint256 indexed orderId, uint256 indexed klerosDisputeId, uint256 ruling);
    event RulingDeferred(uint256 indexed orderId, uint256 indexed klerosDisputeId, uint256 ruling, string reason);
    event EmergencyRefundProposed(uint256 indexed orderId, bool refundBuyer, uint256 unlocksAt);
    event EmergencyRefundExecuted(uint256 indexed orderId, bool refundBuyer);
    event EmergencyRefundCancelled(uint256 indexed orderId);
    event ArbitratorExtraDataUpdated(bytes oldData, bytes newData);
    event TemplateIdUpdated(uint256 oldId, uint256 newId);
    event TemplateRegistryURIUpdated(string newURI);
    event RefundWithdrawn(address indexed recipient, uint256 amount);
    event BalanceWithdrawn(address indexed to, uint256 amount);
    event MarketplaceCallExecuted(bytes4 indexed selector, uint256 valueSent);

    error ZeroAddress();
    error OrderNotDisputed();
    error AlreadyEscalated();
    error NotPartyOfOrder();
    error InsufficientArbitrationFee(uint256 required, uint256 provided);
    error OnlyArbitrator();
    error UnknownDispute();
    error InvalidRuling();
    error NotEscalated();
    error KlerosTimeoutNotElapsed(uint256 elapsedAt, uint256 readyAt);
    error EmergencyAlreadyProposed();
    error EmergencyNotProposed();
    error EmergencyTimelockNotElapsed(uint256 nowTs, uint256 unlocksAt);
    error NoRefundPending();
    error MarketplaceCallFailed(bytes returndata);

    constructor(
        address marketplaceAddr,
        address arbitratorAddr,
        bytes memory _arbitratorExtraData,
        uint256 _templateId
    ) Ownable(msg.sender) {
        if (marketplaceAddr == address(0) || arbitratorAddr == address(0)) revert ZeroAddress();
        marketplace = IEscrowMarketplaceERC20Adapter(marketplaceAddr);
        arbitrator = IArbitratorV2(arbitratorAddr);
        arbitratorExtraData = _arbitratorExtraData;
        templateId = _templateId;
    }

    receive() external payable {
        // Accept ETH sent back by Kleros and any accidental transfers.
    }

    // ---------------------------------------------------------------------
    // Escalation: anyone on the order's roster pays Kleros's fee
    // ---------------------------------------------------------------------

    function escalateToKleros(uint256 orderId) external payable returns (uint256 disputeId) {
        IEscrowMarketplaceERC20Adapter.Order memory order = marketplace.getOrder(orderId);
        if (order.status != IEscrowMarketplaceERC20Adapter.OrderStatus.Disputed) revert OrderNotDisputed();
        if (orderEscalated[orderId]) revert AlreadyEscalated();
        if (msg.sender != order.buyer && msg.sender != order.seller) revert NotPartyOfOrder();

        uint256 cost = arbitrator.arbitrationCost(arbitratorExtraData);
        if (msg.value < cost) revert InsufficientArbitrationFee(cost, msg.value);

        disputeId = arbitrator.createDispute{value: cost}(2, arbitratorExtraData);
        klerosDisputeIdByOrder[orderId] = disputeId;
        orderEscalated[orderId] = true;
        orderIdByDispute[disputeId] = orderId;
        escalatedAt[orderId] = block.timestamp;

        emit DisputeEscalated(orderId, disputeId, msg.sender, cost);
        emit Dispute(arbitrator, disputeId, templateId, templateRegistryURI);

        if (msg.value > cost) {
            pendingRefunds[msg.sender] += msg.value - cost;
        }
    }

    function withdrawRefund() external {
        uint256 amount = pendingRefunds[msg.sender];
        if (amount == 0) revert NoRefundPending();
        delete pendingRefunds[msg.sender];
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Withdraw failed");
        emit RefundWithdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Kleros callback + deferred-ruling retry
    // ---------------------------------------------------------------------

    function rule(uint256 _disputeID, uint256 _ruling) external override {
        if (msg.sender != address(arbitrator)) revert OnlyArbitrator();
        uint256 orderId = orderIdByDispute[_disputeID];
        if (!orderEscalated[orderId]) revert UnknownDispute();
        if (_ruling > 2) revert InvalidRuling();

        emit Ruling(arbitrator, _disputeID, _ruling);

        // Normalise RULING_REFUSE (0) → buyer refund. v3 left it for owner
        // manual handling, but v3.2's only owner action is the timelocked
        // emergency path — too slow for the common "jurors abstained"
        // case. Defaulting to refund-buyer is the buyer-friendly choice
        // and matches how most consumer-side escrow systems handle ties.
        uint256 effective = _ruling == RULING_REFUSE ? RULING_BUYER : _ruling;

        pendingRulings[orderId] = effective;
        _tryApplyRuling(orderId, _disputeID, effective);
    }

    /// Anyone can poke an unapplied ruling once marketplace's cooldown is up.
    function applyKlerosRuling(uint256 orderId) external {
        uint256 ruling = pendingRulings[orderId];
        if (ruling == 0) revert UnknownDispute();
        uint256 disputeId = klerosDisputeIdByOrder[orderId];
        _tryApplyRuling(orderId, disputeId, ruling);
    }

    function _tryApplyRuling(uint256 orderId, uint256 disputeId, uint256 ruling) private {
        bool refundBuyer = (ruling == RULING_BUYER);
        try marketplace.resolveDispute(orderId, refundBuyer) {
            delete pendingRulings[orderId];
            emit DisputeRuled(orderId, disputeId, ruling);
        } catch Error(string memory reason) {
            emit RulingDeferred(orderId, disputeId, ruling, reason);
        } catch (bytes memory) {
            emit RulingDeferred(orderId, disputeId, ruling, "low-level revert");
        }
    }

    // ---------------------------------------------------------------------
    // Emergency refund: time-gated escape if Kleros never rules
    // ---------------------------------------------------------------------

    function proposeEmergencyRefund(uint256 orderId, bool refundBuyer) external onlyOwner {
        if (!orderEscalated[orderId]) revert NotEscalated();
        uint256 readyAt = escalatedAt[orderId] + KLEROS_TIMEOUT;
        if (block.timestamp < readyAt) revert KlerosTimeoutNotElapsed(block.timestamp, readyAt);
        if (emergencyProposedAt[orderId] != 0) revert EmergencyAlreadyProposed();

        emergencyProposedAt[orderId] = block.timestamp;
        emergencyRefundBuyer[orderId] = refundBuyer;
        emit EmergencyRefundProposed(orderId, refundBuyer, block.timestamp + EMERGENCY_TIMELOCK);
    }

    function executeEmergencyRefund(uint256 orderId) external onlyOwner {
        uint256 proposedAt = emergencyProposedAt[orderId];
        if (proposedAt == 0) revert EmergencyNotProposed();
        uint256 unlocksAt = proposedAt + EMERGENCY_TIMELOCK;
        if (block.timestamp < unlocksAt) revert EmergencyTimelockNotElapsed(block.timestamp, unlocksAt);
        if (!orderEscalated[orderId]) revert NotEscalated();

        bool refundBuyer = emergencyRefundBuyer[orderId];

        // Clear emergency state but keep the dispute mappings so a
        // late Kleros ruling on the same disputeId can still no-op
        // through rule()'s UnknownDispute check (orderEscalated stays
        // true; pendingRulings stays empty; resolveDispute call below
        // will move status off Disputed so a duplicate rule() would
        // hit the marketplace's own state check).
        delete emergencyProposedAt[orderId];
        delete emergencyRefundBuyer[orderId];

        marketplace.resolveDispute(orderId, refundBuyer);
        emit EmergencyRefundExecuted(orderId, refundBuyer);
    }

    function cancelEmergencyRefund(uint256 orderId) external onlyOwner {
        if (emergencyProposedAt[orderId] == 0) revert EmergencyNotProposed();
        delete emergencyProposedAt[orderId];
        delete emergencyRefundBuyer[orderId];
        emit EmergencyRefundCancelled(orderId);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getArbitrationCost() external view returns (uint256) {
        return arbitrator.arbitrationCost(arbitratorExtraData);
    }

    // ---------------------------------------------------------------------
    // Owner setters
    // ---------------------------------------------------------------------

    function setArbitratorExtraData(bytes calldata newExtraData) external onlyOwner {
        emit ArbitratorExtraDataUpdated(arbitratorExtraData, newExtraData);
        arbitratorExtraData = newExtraData;
    }

    function setTemplateId(uint256 newTemplateId) external onlyOwner {
        emit TemplateIdUpdated(templateId, newTemplateId);
        templateId = newTemplateId;
    }

    function setTemplateRegistryURI(string calldata newURI) external onlyOwner {
        templateRegistryURI = newURI;
        emit TemplateRegistryURIUpdated(newURI);
    }

    // ---------------------------------------------------------------------
    // Ownership: accept marketplace ownership + recover stranded ETH +
    // generic owner pass-through to keep the marketplace's other
    // owner-only functions reachable after the transfer.
    // ---------------------------------------------------------------------

    function acceptMarketplaceOwnership() external onlyOwner {
        marketplace.acceptOwnership();
    }

    function withdrawBalance(address payable to) external onlyOwner {
        uint256 bal = address(this).balance;
        require(bal > 0, "No balance");
        (bool ok, ) = to.call{value: bal}("");
        require(ok, "Withdraw failed");
        emit BalanceWithdrawn(to, bal);
    }

    /// Generic owner pass-through. After ownership transfer the only way
    /// to call e.g. marketplace.setAcceptedToken / pause / unpause is via
    /// this proxy. The adapter owner is fully trusted (same multisig that
    /// would have been the direct marketplace owner), so this does not
    /// expand the trust surface.
    function executeOnMarketplace(bytes calldata data) external payable onlyOwner returns (bytes memory) {
        (bool ok, bytes memory ret) = address(marketplace).call{value: msg.value}(data);
        if (!ok) {
            if (ret.length > 0) {
                assembly {
                    revert(add(32, ret), mload(ret))
                }
            }
            revert MarketplaceCallFailed(ret);
        }
        bytes4 selector = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);
        emit MarketplaceCallExecuted(selector, msg.value);
        return ret;
    }
}
