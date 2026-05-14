// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Kleros V2 arbitrator interface. Stripped to what KlerosV2DisputeAdapter
// calls — the full V2 interface has more functions but we don't need them.
interface IArbitratorV2 {
    function arbitrationCost(bytes calldata _extraData) external view returns (uint256 cost);
    function createDispute(uint256 _numberOfChoices, bytes calldata _extraData)
        external payable returns (uint256 disputeID);
}
