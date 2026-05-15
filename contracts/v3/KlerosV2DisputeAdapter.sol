// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IArbitratorV2} from "./IArbitratorV2.sol";
import {IArbitrableV2} from "./IArbitrableV2.sol";

// Minimal interface to V3 marketplace — only the entry points adapter uses.
interface IEscrowMarketplaceV3Adapter {
    enum OrderStatus { Created, Paid, Shipped, Completed, Cancelled, Disputed, Refunded }
    struct Order {
        uint256 id; address buyer; OrderStatus status; uint64 createdAt;
        address seller; uint64 paidAt; uint256 productId; uint256 amount;
        uint64 shippedAt; uint64 completedAt; uint64 deliveredAt; uint64 disputedAt;
    }
    function getOrder(uint256 orderId) external view returns (Order memory);
    function resolveDispute(uint256 orderId, bool refundBuyer) external;
    function acceptOwnership() external;
}

/// Adapter that bridges V3 marketplace's dispute resolution with Kleros V2.
/// Owner of this adapter (timelocked multisig) is also the V3 marketplace owner,
/// so the multisig retains an `emergencyResolveDispute` fallback path.
contract KlerosV2DisputeAdapter is Ownable2Step, IArbitrableV2 {
    IArbitratorV2 public immutable arbitrator;
    IEscrowMarketplaceV3Adapter public immutable marketplace;

    // Kleros ruling encoding for our 2-choice dispute:
    // 0 = RefuseToArbitrate (jurors decline) — owner manually resolves
    // 1 = BuyerWins (refund buyer)
    // 2 = SellerWins (complete to seller)
    uint256 public constant RULING_REFUSE = 0;
    uint256 public constant RULING_BUYER = 1;
    uint256 public constant RULING_SELLER = 2;

    bytes public arbitratorExtraData;   // (court ID + jurors) encoded per Kleros V2
    uint256 public templateId;           // dispute template index (Kleros V2 uses templates)
    string public templateRegistryURI;   // optional UI pointer

    // orderToDisputeID stores the raw Kleros disputeID (may be 0 for the first dispute).
    // Use orderEscalated to check whether an order has been escalated, not orderToDisputeID != 0.
    mapping(uint256 => uint256) public orderToDisputeID;
    mapping(uint256 => bool)    public orderEscalated;
    mapping(uint256 => uint256) public disputeToOrderID;
    mapping(uint256 => address) public disputeEscalatedBy;
    // Pull-payment refunds for over-paid escalation fees (H2 fix).
    mapping(address => uint256) public pendingRefunds;
    // Stored ruling waiting to be applied (set when Kleros rules before the
    // marketplace's 3-day dispute cooldown elapses).
    mapping(uint256 => uint256) public pendingRulings;

    event DisputeEscalatedToKleros(uint256 indexed orderId, uint256 indexed disputeID, address indexed escalatedBy, uint256 feePaid);
    event KlerosRulingApplied(uint256 indexed orderId, uint256 indexed disputeID, uint256 ruling);
    event KlerosRulingDeferred(uint256 indexed orderId, uint256 indexed disputeID, uint256 ruling, string reason);
    event EmergencyResolved(uint256 indexed orderId, bool refundBuyer);
    event ArbitratorExtraDataUpdated(bytes oldData, bytes newData);
    event TemplateIdUpdated(uint256 oldId, uint256 newId);
    event TemplateRegistryURIUpdated(string newURI);
    event RefundWithdrawn(address indexed recipient, uint256 amount);
    event BalanceWithdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error OrderNotDisputed();
    error AlreadyEscalated();
    error NotPartyOfOrder();
    error InsufficientArbitrationFee(uint256 required, uint256 provided);
    error OnlyArbitrator();
    error UnknownDispute();
    error InvalidRuling();
    error NoPendingRuling();
    error NoRefundPending();

    constructor(
        address _arbitrator,
        address _marketplace,
        bytes memory _arbitratorExtraData,
        uint256 _templateId
    ) Ownable(msg.sender) {
        if (_arbitrator == address(0) || _marketplace == address(0)) revert ZeroAddress();
        arbitrator = IArbitratorV2(_arbitrator);
        marketplace = IEscrowMarketplaceV3Adapter(_marketplace);
        arbitratorExtraData = _arbitratorExtraData;
        templateId = _templateId;
    }

    receive() external payable {
        // Accept ETH sent back by Kleros and any accidental transfers.
    }

    /// Withdraw over-paid escalation fee refund (pull-payment, H2 fix).
    function withdrawRefund() external {
        uint256 amount = pendingRefunds[msg.sender];
        if (amount == 0) revert NoRefundPending();
        delete pendingRefunds[msg.sender];
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Withdraw failed");
        emit RefundWithdrawn(msg.sender, amount);
    }

    /// Owner can recover any ETH stranded in this contract (L1 fix).
    function withdrawBalance(address payable to) external onlyOwner {
        uint256 bal = address(this).balance;
        require(bal > 0, "No balance");
        (bool ok, ) = to.call{value: bal}("");
        require(ok, "Withdraw failed");
        emit BalanceWithdrawn(to, bal);
    }

    /// Anyone who is buyer or seller of a Disputed order can pay Kleros's
    /// arbitration fee to escalate. The fee is forwarded to Kleros; any
    /// over-payment is refunded to msg.sender.
    function escalateToKleros(uint256 orderId) external payable returns (uint256 disputeID) {
        IEscrowMarketplaceV3Adapter.Order memory order = marketplace.getOrder(orderId);
        if (order.status != IEscrowMarketplaceV3Adapter.OrderStatus.Disputed) revert OrderNotDisputed();
        // H1: use orderEscalated, not orderToDisputeID != 0, to support Kleros disputeID=0.
        if (orderEscalated[orderId]) revert AlreadyEscalated();
        if (msg.sender != order.buyer && msg.sender != order.seller) revert NotPartyOfOrder();

        uint256 cost = arbitrator.arbitrationCost(arbitratorExtraData);
        if (msg.value < cost) revert InsufficientArbitrationFee(cost, msg.value);

        disputeID = arbitrator.createDispute{value: cost}(2, arbitratorExtraData);
        orderToDisputeID[orderId] = disputeID;
        orderEscalated[orderId] = true;
        disputeToOrderID[disputeID] = orderId;
        disputeEscalatedBy[disputeID] = msg.sender;

        emit DisputeEscalatedToKleros(orderId, disputeID, msg.sender, cost);
        emit Dispute(arbitrator, disputeID, templateId, templateRegistryURI);

        // H2: pull-payment instead of direct call to avoid blocking by non-payable msg.sender.
        if (msg.value > cost) {
            pendingRefunds[msg.sender] += msg.value - cost;
        }
    }

    /// Kleros callback. Only callable by the arbitrator. Stores the ruling
    /// and tries to apply it immediately; if marketplace's 3-day cooldown
    /// hasn't elapsed yet, ruling stays in pendingRulings until someone
    /// calls applyKlerosRuling.
    function rule(uint256 _disputeID, uint256 _ruling) external override {
        if (msg.sender != address(arbitrator)) revert OnlyArbitrator();
        uint256 orderId = disputeToOrderID[_disputeID];
        if (orderId == 0) revert UnknownDispute();
        if (_ruling > 2) revert InvalidRuling();

        emit Ruling(arbitrator, _disputeID, _ruling);

        if (_ruling == RULING_REFUSE) {
            // Jurors declined to rule — leave for owner to handle manually.
            return;
        }

        pendingRulings[orderId] = _ruling;
        _tryApplyRuling(orderId, _disputeID, _ruling);
    }

    /// Anyone can poke an unapplied ruling after the marketplace's cooldown
    /// has elapsed. Useful if Kleros ruled fast.
    function applyKlerosRuling(uint256 orderId) external {
        uint256 ruling = pendingRulings[orderId];
        if (ruling == 0) revert NoPendingRuling();
        uint256 disputeID = orderToDisputeID[orderId];
        _tryApplyRuling(orderId, disputeID, ruling);
    }

    function _tryApplyRuling(uint256 orderId, uint256 disputeID, uint256 ruling) private {
        bool refundBuyer = (ruling == RULING_BUYER);
        // Use try/catch so a temporary revert (e.g., cooldown not met) stays
        // recoverable. Caller can retry later via applyKlerosRuling.
        try marketplace.resolveDispute(orderId, refundBuyer) {
            delete pendingRulings[orderId];
            emit KlerosRulingApplied(orderId, disputeID, ruling);
        } catch Error(string memory reason) {
            emit KlerosRulingDeferred(orderId, disputeID, ruling, reason);
        } catch (bytes memory) {
            emit KlerosRulingDeferred(orderId, disputeID, ruling, "low-level revert");
        }
    }

    /// Owner override — used when Kleros refuses or is unreachable.
    function emergencyResolveDispute(uint256 orderId, bool refundBuyer) external onlyOwner {
        marketplace.resolveDispute(orderId, refundBuyer);
        emit EmergencyResolved(orderId, refundBuyer);
    }

    /// Owner can swap arbitration policy (e.g., change Kleros court).
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

    /// Two-step ownership handover: marketplace's current owner calls
    /// transferOwnership(adapter), then adapter's owner calls this.
    function acceptMarketplaceOwnership() external onlyOwner {
        marketplace.acceptOwnership();
    }

    /// Generic pass-through so the adapter owner (multisig in production)
    /// can still invoke the marketplace's other owner-only functions —
    /// setSubscriptionId, pause/unpause, proposeRequestSource,
    /// setEvidenceRegistry, etc. — after ownership has been transferred to
    /// the adapter. Without this, transferring ownership would brick every
    /// owner function on the marketplace except resolveDispute, which we
    /// route through escalateToKleros / emergencyResolveDispute.
    ///
    /// The adapter owner is fully trusted (it's the same multisig that
    /// would have been the direct marketplace owner), so granting it
    /// arbitrary proxy authority does not expand the trust surface.
    event MarketplaceCallExecuted(bytes4 indexed selector, uint256 valueSent);
    error MarketplaceCallFailed(bytes returndata);

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
