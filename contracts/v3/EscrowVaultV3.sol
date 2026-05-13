// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract EscrowVaultV3 {
    address public immutable owner;
    address public marketplace;

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

    function releaseTo(uint256 orderId, address payable to) external onlyMarketplace {
        uint256 amount = lockedAmount[orderId];

        require(amount > 0, "No locked funds for this order");
        require(to != address(0), "Cannot release to zero address");

        lockedAmount[orderId] = 0;

        emit FundsReleased(orderId, to, amount);

        (bool success, ) = to.call{value: amount}("");
        require(success, "ETH transfer failed");
    }
}
