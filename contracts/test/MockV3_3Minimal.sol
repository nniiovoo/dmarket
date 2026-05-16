// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Minimal ShopNFT stand-in for v3.3 marketplace tests. Returns a constant
/// shopId for every seller so _createOrderFor's `shopIdOf` check passes
/// without standing up the real ShopNFT contract. Tests that need
/// per-seller mapping can call setShopIdOf(seller, id).
contract MockShopNFTMinimal {
    uint256 public defaultShopId = 1;
    mapping(address => uint256) private _override;

    function setDefaultShopId(uint256 id) external {
        defaultShopId = id;
    }

    function setShopIdOf(address seller, uint256 id) external {
        _override[seller] = id;
    }

    function shopIdOf(address seller) external view returns (uint256) {
        uint256 v = _override[seller];
        return v == 0 ? defaultShopId : v;
    }
}

/// Minimal RevenueDistributor stand-in. Just records every deposit so
/// tests can assert that completion paths (including Kleros 'seller wins'
/// rulings) successfully reach the distributor — without standing up the
/// real per-share-index accumulator.
contract MockRevenueDistributor {
    event Deposited(uint256 indexed shopId, address indexed token, uint256 amount);

    uint256 public totalNativeDeposited;
    mapping(uint256 => uint256) public nativeByShop;
    mapping(uint256 => mapping(address => uint256)) public erc20ByShop;

    function deposit(uint256 shopId) external payable {
        totalNativeDeposited += msg.value;
        nativeByShop[shopId] += msg.value;
        emit Deposited(shopId, address(0), msg.value);
    }

    function depositERC20(uint256 shopId, address token, uint256 amount) external {
        // Marketplace calls forceApprove then depositERC20 — we pull the
        // tokens via transferFrom to exercise that path realistically.
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        erc20ByShop[shopId][token] += amount;
        emit Deposited(shopId, token, amount);
    }

    receive() external payable {}
}
