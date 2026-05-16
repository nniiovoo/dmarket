// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test-only settler that just records every settle() invocation it
/// receives, so the ShopShares hook tests can prove the right
/// (shopId, holder) pairs got called in the right order.
contract MockShareSettler {
    struct Call {
        uint256 shopId;
        address holder;
    }

    Call[] private _calls;

    function settle(uint256 shopId, address holder) external {
        _calls.push(Call({shopId: shopId, holder: holder}));
    }

    function callCount() external view returns (uint256) {
        return _calls.length;
    }

    function getCall(uint256 i) external view returns (uint256 shopId, address holder) {
        Call storage c = _calls[i];
        return (c.shopId, c.holder);
    }
}
