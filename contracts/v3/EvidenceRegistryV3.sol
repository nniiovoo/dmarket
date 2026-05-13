// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {FunctionsClient} from "@chainlink/contracts/src/v0.8/functions/v1_0_0/FunctionsClient.sol";
import {FunctionsRequest} from "@chainlink/contracts/src/v0.8/functions/v1_0_0/libraries/FunctionsRequest.sol";

interface IEscrowMarketplaceV3 {
    enum OrderStatus { Created, Paid, Shipped, Completed, Cancelled, Disputed, Refunded }
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
    function getOrder(uint256 orderId) external view returns (Order memory);
}

contract EvidenceRegistryV3 is Ownable2Step, Pausable, FunctionsClient {
    using FunctionsRequest for FunctionsRequest.Request;

    IEscrowMarketplaceV3 public immutable marketplace;
    address public immutable functionsRouter;

    uint64 public subscriptionId;
    bytes32 public donID;
    uint32 public callbackGasLimit;
    string public requestSource;
    bytes public encryptedSecretsReference;

    uint64 public constant ORACLE_QUERY_COOLDOWN = 1 hours;

    struct EvidenceRecord {
        address party;
        uint64 submittedAt;
        bytes32 contentHash;
        uint64 marketplaceDeliveredAtSnapshot;
        bytes32 oracleRequestId;
    }

    struct OracleResult {
        bool fulfilled;
        bool delivered;
        uint64 deliveredTimestamp;
    }

    struct RequestRef {
        uint256 orderId;
        uint256 evidenceIndex;
    }

    mapping(uint256 => EvidenceRecord[]) private evidenceByOrder;
    mapping(bytes32 => RequestRef) private requestToEvidence;
    mapping(uint256 => mapping(uint256 => OracleResult)) public oracleResults;
    mapping(uint256 => uint64) public lastOracleRequestAt;

    event Evidence(
        address indexed _arbitrable,
        uint256 indexed _evidenceGroupID,
        address indexed _party,
        string _evidence
    );

    event EvidenceRecorded(
        uint256 indexed orderId,
        uint256 indexed evidenceIndex,
        address indexed party,
        bytes32 contentHash,
        uint64 marketplaceDeliveredAtSnapshot
    );
    event OracleQueryRequested(uint256 indexed orderId, uint256 indexed evidenceIndex, bytes32 requestId);
    event OracleQueryFulfilled(uint256 indexed orderId, uint256 indexed evidenceIndex, bool delivered, uint64 deliveredTimestamp);
    event OracleQueryFailed(uint256 indexed orderId, uint256 indexed evidenceIndex, string reason);

    event SubscriptionIdUpdated(uint64 oldSubscriptionId, uint64 newSubscriptionId);
    event DonIdUpdated(bytes32 oldDonId, bytes32 newDonId);
    event CallbackGasLimitUpdated(uint32 oldCallbackGasLimit, uint32 newCallbackGasLimit);
    event RequestSourceUpdated(bytes32 indexed sourceHash, uint256 length);
    event EncryptedSecretsReferenceUpdated(bytes32 indexed referenceHash, uint256 length);

    error EmptyEvidence();
    error NotPartyOfOrder();
    error OrderStatusNotEligible();
    error OracleQueryCooldown();

    constructor(
        address marketplaceAddress,
        address routerAddress,
        string memory initialRequestSource
    ) Ownable(msg.sender) FunctionsClient(routerAddress) {
        require(marketplaceAddress != address(0), "Zero marketplace");
        require(routerAddress != address(0), "Zero router");
        require(bytes(initialRequestSource).length > 0, "Empty request source");

        marketplace = IEscrowMarketplaceV3(marketplaceAddress);
        functionsRouter = routerAddress;
        callbackGasLimit = 300_000;
        requestSource = initialRequestSource;
    }

    receive() external payable {
        revert("Direct ETH transfers are not allowed");
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function submitEvidence(uint256 orderId, string calldata evidenceURI)
        external
        whenNotPaused
        returns (uint256 evidenceIndex)
    {
        return _submitEvidenceInternal(orderId, evidenceURI);
    }

    function submitEvidenceWithOracleQuery(uint256 orderId, string calldata evidenceURI)
        external
        whenNotPaused
        returns (uint256 evidenceIndex, bytes32 requestId)
    {
        if (block.timestamp < uint256(lastOracleRequestAt[orderId]) + ORACLE_QUERY_COOLDOWN) {
            revert OracleQueryCooldown();
        }
        lastOracleRequestAt[orderId] = uint64(block.timestamp);

        evidenceIndex = _submitEvidenceInternal(orderId, evidenceURI);

        FunctionsRequest.Request memory req;
        req.initializeRequestForInlineJavaScript(requestSource);

        string[] memory args = new string[](1);
        args[0] = Strings.toString(orderId);
        req.setArgs(args);

        if (encryptedSecretsReference.length > 0) {
            req.addSecretsReference(encryptedSecretsReference);
        }

        requestId = _sendRequest(req.encodeCBOR(), subscriptionId, callbackGasLimit, donID);

        requestToEvidence[requestId] = RequestRef({ orderId: orderId, evidenceIndex: evidenceIndex });
        evidenceByOrder[orderId][evidenceIndex].oracleRequestId = requestId;

        emit OracleQueryRequested(orderId, evidenceIndex, requestId);
    }

    function _submitEvidenceInternal(uint256 orderId, string calldata evidenceURI)
        private
        returns (uint256 evidenceIndex)
    {
        if (bytes(evidenceURI).length == 0) revert EmptyEvidence();

        IEscrowMarketplaceV3.Order memory order = marketplace.getOrder(orderId);

        if (msg.sender != order.buyer && msg.sender != order.seller) revert NotPartyOfOrder();

        if (
            order.status != IEscrowMarketplaceV3.OrderStatus.Paid &&
            order.status != IEscrowMarketplaceV3.OrderStatus.Shipped &&
            order.status != IEscrowMarketplaceV3.OrderStatus.Disputed
        ) revert OrderStatusNotEligible();

        bytes32 contentHash = keccak256(bytes(evidenceURI));

        evidenceIndex = evidenceByOrder[orderId].length;
        evidenceByOrder[orderId].push(EvidenceRecord({
            party: msg.sender,
            submittedAt: uint64(block.timestamp),
            contentHash: contentHash,
            marketplaceDeliveredAtSnapshot: order.deliveredAt,
            oracleRequestId: bytes32(0)
        }));

        emit Evidence(address(marketplace), orderId, msg.sender, evidenceURI);
        emit EvidenceRecorded(orderId, evidenceIndex, msg.sender, contentHash, order.deliveredAt);
    }

    function fulfillRequest(bytes32 requestId, bytes memory response, bytes memory err) internal override {
        RequestRef memory ref = requestToEvidence[requestId];

        if (ref.orderId == 0) {
            return;
        }

        delete requestToEvidence[requestId];

        if (err.length > 0) {
            emit OracleQueryFailed(ref.orderId, ref.evidenceIndex, string(err));
            return;
        }

        (bool delivered, uint64 deliveredTimestamp) = abi.decode(response, (bool, uint64));

        oracleResults[ref.orderId][ref.evidenceIndex] = OracleResult({
            fulfilled: true,
            delivered: delivered,
            deliveredTimestamp: deliveredTimestamp
        });

        emit OracleQueryFulfilled(ref.orderId, ref.evidenceIndex, delivered, deliveredTimestamp);
    }

    function getEvidenceCount(uint256 orderId) external view returns (uint256) {
        return evidenceByOrder[orderId].length;
    }

    function getEvidence(uint256 orderId, uint256 index) external view returns (EvidenceRecord memory) {
        require(index < evidenceByOrder[orderId].length, "Index out of range");
        return evidenceByOrder[orderId][index];
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

    function setRequestSource(string calldata newRequestSource) external onlyOwner {
        require(bytes(newRequestSource).length > 0, "Request source cannot be empty");
        requestSource = newRequestSource;
        emit RequestSourceUpdated(keccak256(bytes(newRequestSource)), bytes(newRequestSource).length);
    }

    function setEncryptedSecretsReference(bytes calldata newEncryptedSecretsReference) external onlyOwner {
        encryptedSecretsReference = newEncryptedSecretsReference;
        emit EncryptedSecretsReferenceUpdated(
            keccak256(newEncryptedSecretsReference),
            newEncryptedSecretsReference.length
        );
    }
}
