// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IArbitratorV2} from "./IArbitratorV2.sol";

interface IArbitrableV2 {
    // ERC-792 / Kleros V2 standard events
    event Dispute(IArbitratorV2 indexed _arbitrator, uint256 indexed _disputeID, uint256 _templateId, string _templateUri);
    event Ruling(IArbitratorV2 indexed _arbitrator, uint256 indexed _disputeID, uint256 _ruling);

    function rule(uint256 _disputeID, uint256 _ruling) external;
}
