// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract EscrowVaultV3 is ReentrancyGuard {
    address public immutable owner;
    address public marketplace;

    // H5 defense-in-depth: the vault records buyer + seller at lock time and
    // refuses to send funds to any other address. Even if the marketplace is
    // ever compromised or has a logic bug, it cannot point release at an
    // attacker-controlled address.
    struct OrderParties {
        address buyer;
        address seller;
    }

    mapping(uint256 => uint256) public lockedAmount;
    mapping(uint256 => OrderParties) public partiesByOrder;
    mapping(address => uint256) public pendingWithdrawal;

    event MarketplaceUpdated(address indexed oldMarketplace, address indexed newMarketplace);
    event FundsLocked(uint256 indexed orderId, uint256 amount);
    // FundsReleased keeps the (orderId, to, amount) shape so the indexer
    // doesn't need to change. Funds are credited to pendingWithdrawal rather
    // than transferred directly, matching the pull-payment pattern.
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

    function lockFunds(uint256 orderId, address buyer, address seller) external payable onlyMarketplace {
        require(msg.value > 0, "Must lock non-zero amount");
        require(lockedAmount[orderId] == 0, "Funds already locked for this order");
        require(buyer != address(0), "Buyer cannot be zero address");
        require(seller != address(0), "Seller cannot be zero address");
        require(buyer != seller, "Buyer and seller must differ");

        lockedAmount[orderId] = msg.value;
        partiesByOrder[orderId] = OrderParties({ buyer: buyer, seller: seller });

        emit FundsLocked(orderId, msg.value);
    }

    // The vault decides who receives funds, not the caller. Callers pick
    // direction (buyer vs seller); the actual address comes from what the
    // vault recorded at lockFunds time.
    function releaseToBuyer(uint256 orderId) external onlyMarketplace {
        _release(orderId, partiesByOrder[orderId].buyer);
    }

    function releaseToSeller(uint256 orderId) external onlyMarketplace {
        _release(orderId, partiesByOrder[orderId].seller);
    }

    function _release(uint256 orderId, address to) private {
        uint256 amount = lockedAmount[orderId];

        require(amount > 0, "No locked funds for this order");
        // Defensive: lockFunds enforces both party fields non-zero, but a
        // future bug could leave the slot empty — refuse to release in that
        // case rather than burning funds to address(0).
        require(to != address(0), "Recipient not recorded");

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
