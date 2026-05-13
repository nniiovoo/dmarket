// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IFunctionsClientLike {
    function handleOracleFulfillment(bytes32 requestId, bytes memory response, bytes memory err) external;
}

contract FunctionsRouterMock {
    uint256 public nextRequestNonce = 1;

    event MockRequestSent(
        bytes32 indexed requestId,
        uint64 subscriptionId,
        bytes data,
        uint16 dataVersion,
        uint32 callbackGasLimit,
        bytes32 donId
    );

    function sendRequest(
        uint64 subscriptionId,
        bytes calldata data,
        uint16 dataVersion,
        uint32 callbackGasLimit,
        bytes32 donId
    ) external returns (bytes32) {
        bytes32 requestId = keccak256(abi.encode(address(this), msg.sender, nextRequestNonce));
        nextRequestNonce++;

        emit MockRequestSent(requestId, subscriptionId, data, dataVersion, callbackGasLimit, donId);

        return requestId;
    }

    function fulfill(address client, bytes32 requestId, bytes calldata response, bytes calldata err) external {
        IFunctionsClientLike(client).handleOracleFulfillment(requestId, response, err);
    }
}
