// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract EscrowVaultV3 is ReentrancyGuard {
    address public immutable owner;
    address public marketplace;

    mapping(uint256 => uint256) public lockedAmount;
    mapping(address => uint256) public pendingWithdrawal;

    event MarketplaceUpdated(address indexed oldMarketplace, address indexed newMarketplace);
    event FundsLocked(uint256 indexed orderId, uint256 amount);
    // releaseTo no longer transfers ETH; it credits the recipient's pending
    // balance. FundsReleased keeps the (orderId, to, amount) shape so the
    // indexer doesn't need to change.
    event FundsReleased(uint256 indexed orderId, address indexed to, uint256 amount);
    event Withdrawn(address indexed account, address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call this function");
        _;
    }

    modifier onlyMarketplace() {
        require(msg.sender == marketplace, "Only marketplace can call this function");
        _;
    }

    constructor(address initialOwner) {
        require(initialOwner != address(0), "Owner cannot be zero address");
        owner = initialOwner;
    }

    receive() external payable {
        revert("Direct ETH transfers are not allowed");
    }

    function setMarketplace(address newMarketplace) external onlyOwner {
        require(newMarketplace != address(0), "Marketplace cannot be zero address");
        require(marketplace == address(0), "Marketplace already set");

        address oldMarketplace = marketplace;
        marketplace = newMarketplace;

        emit MarketplaceUpdated(oldMarketplace, newMarketplace);
    }

    function lockFunds(uint256 orderId) external payable onlyMarketplace {
        require(msg.value > 0, "Must lock non-zero amount");
        require(lockedAmount[orderId] == 0, "Funds already locked for this order");

        lockedAmount[orderId] = msg.value;

        emit FundsLocked(orderId, msg.value);
    }

    // No longer transfers; credits pending balance instead. This makes
    // marketplace state transitions immune to malicious recipients whose
    // receive() reverts.
    function releaseTo(uint256 orderId, address to) external onlyMarketplace {
        uint256 amount = lockedAmount[orderId];

        require(amount > 0, "No locked funds for this order");
        require(to != address(0), "Cannot release to zero address");

        lockedAmount[orderId] = 0;
        pendingWithdrawal[to] += amount;

        emit FundsReleased(orderId, to, amount);
    }

    // Pull payment. `to` allows the credited account to forward to a
    // different address (useful when msg.sender is a contract whose
    // receive() reverts and would otherwise lock the funds forever).
    function withdraw(address payable to) external nonReentrant returns (uint256) {
        require(to != address(0), "Cannot withdraw to zero address");

        uint256 amount = pendingWithdrawal[msg.sender];
        require(amount > 0, "Nothing to withdraw");

        pendingWithdrawal[msg.sender] = 0;

        emit Withdrawn(msg.sender, to, amount);

        (bool success, ) = to.call{value: amount}("");
        require(success, "Withdraw transfer failed");

        return amount;
    }
}
