// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IArbitratorV2} from "../v3/IArbitratorV2.sol";
import {IArbitrableV2} from "../v3/IArbitrableV2.sol";

/// Minimal IArbitratorV2 implementation for unit tests. Lets test code
/// call giveRuling(disputeID, ruling) to simulate Kleros's async callback
/// synchronously.
contract MockArbitratorV2 is IArbitratorV2 {
    uint256 public nextDisputeID = 1;
    uint256 public fee = 0.01 ether;

    struct DisputeData {
        address arbitrable;
        uint256 numberOfChoices;
        uint256 ruling;
        bool ruled;
    }
    mapping(uint256 => DisputeData) public disputes;

    function setFee(uint256 _fee) external { fee = _fee; }
    function setNextDisputeID(uint256 _id) external { nextDisputeID = _id; }

    function arbitrationCost(bytes calldata) external view returns (uint256) {
        return fee;
    }

    function createDispute(uint256 _numberOfChoices, bytes calldata) external payable returns (uint256 disputeID) {
        require(msg.value >= fee, "Insufficient fee");
        disputeID = nextDisputeID++;
        disputes[disputeID] = DisputeData({
            arbitrable: msg.sender,
            numberOfChoices: _numberOfChoices,
            ruling: 0,
            ruled: false
        });
    }

    /// Mock-only entry point. Calls arbitrable.rule() synchronously.
    function giveRuling(uint256 _disputeID, uint256 _ruling) external {
        DisputeData storage d = disputes[_disputeID];
        require(!d.ruled, "Already ruled");
        d.ruled = true;
        d.ruling = _ruling;
        IArbitrableV2(d.arbitrable).rule(_disputeID, _ruling);
    }
}
