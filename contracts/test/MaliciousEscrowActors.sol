// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IEscrowMarketplace {
    function createOrder(address seller, uint256 productId, uint256 amount) external returns (uint256);
    function payOrder(uint256 orderId) external payable;
    function markShipped(uint256 orderId) external;
    function confirmReceived(uint256 orderId) external;
    function openDispute(uint256 orderId) external;
}

contract MaliciousSeller {
    IEscrowMarketplace public marketplace;
    uint256 public orderId;
    uint256 public reentryAttempts;
    bool public attackEnabled;

    constructor(address marketplaceAddress) {
        marketplace = IEscrowMarketplace(marketplaceAddress);
    }

    function setOrderId(uint256 newOrderId) external {
        orderId = newOrderId;
    }

    function markShipped() external {
        marketplace.markShipped(orderId);
    }

    function enableAttack() external {
        attackEnabled = true;
    }

    receive() external payable {
        if (!attackEnabled || reentryAttempts > 0) {
            return;
        }

        reentryAttempts++;

        // Try to reenter the release path. The marketplace should already be
        // Completed before this external call, so this must not release twice.
        try marketplace.confirmReceived(orderId) {} catch {}

        // Try a second unrelated state transition too. This should fail because
        // the order is no longer Created and this contract is not the buyer.
        try marketplace.payOrder{value: msg.value}(orderId) {} catch {}
    }
}

contract MaliciousBuyerRejectsEth {
    IEscrowMarketplace public marketplace;
    uint256 public orderId;

    constructor(address marketplaceAddress) {
        marketplace = IEscrowMarketplace(marketplaceAddress);
    }

    function createOrder(address seller, uint256 productId, uint256 amount) external returns (uint256) {
        orderId = marketplace.createOrder(seller, productId, amount);
        return orderId;
    }

    function payOrder() external payable {
        marketplace.payOrder{value: msg.value}(orderId);
    }

    function openDispute() external {
        marketplace.openDispute(orderId);
    }

    receive() external payable {
        revert("Buyer rejects ETH");
    }
}
