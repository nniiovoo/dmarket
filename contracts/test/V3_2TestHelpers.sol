// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// Minimal ERC-20 used by V3.2 tests. Public mint so the fixture can fund
// arbitrary actors without going through faucet logic.
contract TestERC20 is ERC20 {
    uint8 private immutable _customDecimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _customDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _customDecimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

interface IEscrowMarketplaceERC20Min {
    function payOrderERC20(uint256 orderId) external;
}

// ReentrantERC20: when the marketplace calls safeTransfer (during refund or
// release-to-seller), this token tries to re-enter payOrderERC20 with a stale
// orderId. The marketplace's ReentrancyGuard must reject the nested call.
contract ReentrantERC20 is ERC20 {
    address public marketplace;
    uint256 public reenterOrderId;
    bool public attackArmed;
    uint256 public reentryAttempts;
    bool public lastReentryReverted;

    constructor() ERC20("Reentrant", "REE") {}

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setMarketplace(address m) external {
        marketplace = m;
    }

    function arm(uint256 orderId) external {
        attackArmed = true;
        reenterOrderId = orderId;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        if (!attackArmed) return;
        if (msg.sender != marketplace) return;
        if (from != marketplace) return; // only on outflow from marketplace

        attackArmed = false; // single-shot
        reentryAttempts++;
        try IEscrowMarketplaceERC20Min(marketplace).payOrderERC20(reenterOrderId) {
            lastReentryReverted = false;
        } catch {
            lastReentryReverted = true;
        }
    }
}
