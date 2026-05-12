// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// EscrowVault: the only contract in this system that holds ETH.
//
// Responsibilities are intentionally narrow:
//   1. Accept lockFunds(orderId) calls from the authorised marketplace, indexed by orderId.
//   2. Release locked funds to a designated recipient on the marketplace's instruction.
//
// The vault knows nothing about orders, buyers, sellers, or dispute state. It only knows:
// "for this orderId, this many wei are locked, and the marketplace can move them."
//
// All risk-classified concerns (custody, recipient address resolution) are isolated here.
// All product logic (order lifecycle, dispute rules, access by buyer/seller/owner role)
// stays in EscrowMarketplace where it has high locality with order state.
contract EscrowVault {
    address public immutable owner;
    address public marketplace;

    // Locked balance per orderId. Cleared to 0 when funds are released.
    mapping(uint256 => uint256) public lockedAmount;

    event MarketplaceUpdated(address indexed oldMarketplace, address indexed newMarketplace);
    event FundsLocked(uint256 indexed orderId, uint256 amount);
    event FundsReleased(uint256 indexed orderId, address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call this function");
        _;
    }

    modifier onlyMarketplace() {
        require(msg.sender == marketplace, "Only marketplace can call this function");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // Block stray ETH transfers — funds must always enter via lockFunds with an orderId.
    receive() external payable {
        revert("Direct ETH transfers are not allowed");
    }

    // Owner sets which marketplace contract is authorised. Single address, not a set —
    // this vault serves exactly one marketplace at a time, deliberately.
    function setMarketplace(address newMarketplace) external onlyOwner {
        require(newMarketplace != address(0), "Marketplace cannot be zero address");

        address oldMarketplace = marketplace;
        marketplace = newMarketplace;

        emit MarketplaceUpdated(oldMarketplace, newMarketplace);
    }

    // Marketplace locks the buyer's payment under an orderId. The caller is the marketplace,
    // not the buyer, so msg.value is whatever the marketplace forwards.
    function lockFunds(uint256 orderId) external payable onlyMarketplace {
        require(msg.value > 0, "Must lock non-zero amount");
        require(lockedAmount[orderId] == 0, "Funds already locked for this order");

        lockedAmount[orderId] = msg.value;

        emit FundsLocked(orderId, msg.value);
    }

    // Marketplace releases locked funds for an order to a recipient. The marketplace
    // decides whether the recipient is the seller (completion) or buyer (refund);
    // the vault does not enforce that.
    function releaseTo(uint256 orderId, address payable to) external onlyMarketplace {
        uint256 amount = lockedAmount[orderId];

        require(amount > 0, "No locked funds for this order");
        require(to != address(0), "Cannot release to zero address");

        // CEI: zero the balance before the external call to defend against reentrancy.
        lockedAmount[orderId] = 0;

        emit FundsReleased(orderId, to, amount);

        (bool success, ) = to.call{value: amount}("");
        require(success, "ETH transfer failed");
    }
}
