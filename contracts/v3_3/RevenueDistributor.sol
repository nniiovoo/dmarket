// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IShopShares {
    function balanceOf(address account, uint256 id) external view returns (uint256);

    function TOTAL_SUPPLY() external view returns (uint256);
}

/// @title RevenueDistributor (v3.3 draft)
/// @notice Per-share revenue distribution with pull-based claims.
/// @custom:status WIP-DRAFT — NOT AUDITED — DO NOT DEPLOY TO MAINNET
///
/// =====================================================================
/// DESIGN — per-share-index accumulator (MasterChef / Compound pattern)
/// ---------------------------------------------------------------------
///   cumulativeIndex[shopId][token]  total revenue per share so far,
///                                   scaled by PRECISION (1e18). token
///                                   == address(0) (NATIVE) for the
///                                   chain's native asset; any ERC-20
///                                   for tokenised revenue.
///
///   userIndex[shopId][token][holder]  the cumulativeIndex value at
///                                     the holder's most recent
///                                     settle. Difference vs. current
///                                     cumulativeIndex × balance gives
///                                     the holder's freshly-accrued
///                                     share.
///
///   claimable[shopId][token][holder]  settled-but-unclaimed amount,
///                                     pending the holder's `claim`
///                                     call.
///
/// On every share transfer, ShopShares calls settle(shopId, holder)
/// for both sender and receiver BEFORE balances change. settle() walks
/// every token that has ever been deposited for that shopId (tracked
/// in `depositedTokens[shopId]`) and credits each accrual into
/// `claimable[]`, then snaps `userIndex[]` forward. After the
/// callback, super._update moves the share balances; the receiver's
/// pre-transfer balance was 0, so they start their next accrual cycle
/// at the current cumulativeIndex.
///
/// Pull-based — holders call `claim(shopId, token)` (or `claimAll`)
/// when they want to take their accrued share off-chain. No iteration
/// over holders ever happens on a deposit, so depositing scales O(1)
/// in the holder count and O(K) in the number of distinct tokens
/// previously deposited for that shopId (K ≤ 5 for the MVP allowlist).
/// =====================================================================
contract RevenueDistributor is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// Fixed-point scale for `cumulativeIndex`. 1e18 lets us represent
    /// "one wei per share" with no rounding for any TOTAL_SUPPLY up to
    /// 1e18 (the share contract caps it at 10 000).
    uint256 public constant PRECISION = 1e18;

    /// Sentinel for native (ETH) revenue.
    address public constant NATIVE = address(0);

    IShopShares public immutable shares;

    // shopId => token => cumulative revenue per share (× PRECISION)
    mapping(uint256 => mapping(address => uint256)) public cumulativeIndex;

    // shopId => token => holder => snapshot of cumulativeIndex at last settle
    mapping(uint256 => mapping(address => mapping(address => uint256))) public userIndex;

    // shopId => token => holder => settled-but-unclaimed amount
    mapping(uint256 => mapping(address => mapping(address => uint256))) public claimable;

    // shopId => tokens that have received at least one deposit
    mapping(uint256 => address[]) private _depositedTokens;
    // shopId => token => already in _depositedTokens? (cheap dedup test)
    mapping(uint256 => mapping(address => bool)) private _depositedTokenSeen;

    /// Authorised callers of deposit / depositERC20. The owner is also
    /// always allowed so we can run the K.3a smoke without first
    /// authorising itself. K.3b will add the v3.3 marketplace.
    mapping(address => bool) public authorizedDepositors;

    event Deposited(uint256 indexed shopId, address indexed token, uint256 amount, address indexed by);
    event Settled(uint256 indexed shopId, address indexed token, address indexed holder, uint256 credited);
    event Claimed(uint256 indexed shopId, address indexed token, address indexed holder, uint256 amount);
    event AuthorizedDepositorUpdated(address indexed depositor, bool authorized);

    error UnauthorizedDepositor(address caller);
    error NotShares(address caller);
    error InvalidAmount();
    error NothingToClaim();
    error TransferFailed();
    error ZeroSharesAddress();
    error ZeroToken();

    constructor(address _shares) Ownable(msg.sender) {
        if (_shares == address(0)) revert ZeroSharesAddress();
        shares = IShopShares(_shares);
    }

    // ---------------------------------------------------------------------
    // Deposits
    // ---------------------------------------------------------------------

    /// @notice Deposit native revenue. The entire `msg.value` is
    ///         distributed pro rata across all current holders of
    ///         `shopId` shares.
    function deposit(uint256 shopId) external payable {
        _onlyAuthorisedOrOwner();
        if (msg.value == 0) revert InvalidAmount();
        _accrue(shopId, NATIVE, msg.value);
        emit Deposited(shopId, NATIVE, msg.value, msg.sender);
    }

    /// @notice Deposit ERC-20 revenue. Caller MUST have approved this
    ///         contract for at least `amount` of `token`. The full
    ///         amount is pulled in via safeTransferFrom and then made
    ///         claimable.
    function depositERC20(uint256 shopId, address token, uint256 amount) external {
        _onlyAuthorisedOrOwner();
        if (token == address(0)) revert ZeroToken();
        if (amount == 0) revert InvalidAmount();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        _accrue(shopId, token, amount);
        emit Deposited(shopId, token, amount, msg.sender);
    }

    function _accrue(uint256 shopId, address token, uint256 amount) internal {
        uint256 supply = shares.TOTAL_SUPPLY();
        // Spec invariant: ShopShares.TOTAL_SUPPLY is the constant
        // 10_000. We read it through the interface anyway so the
        // distributor doesn't bake the supply into bytecode.
        require(supply > 0, "supply == 0");
        cumulativeIndex[shopId][token] += (amount * PRECISION) / supply;
        if (!_depositedTokenSeen[shopId][token]) {
            _depositedTokenSeen[shopId][token] = true;
            _depositedTokens[shopId].push(token);
        }
    }

    function _onlyAuthorisedOrOwner() internal view {
        if (msg.sender != owner() && !authorizedDepositors[msg.sender]) {
            revert UnauthorizedDepositor(msg.sender);
        }
    }

    // ---------------------------------------------------------------------
    // Settle
    // ---------------------------------------------------------------------

    /// @notice Credit a holder's accrued share for a single token into
    ///         `claimable[]` and advance their userIndex. Idempotent —
    ///         calling repeatedly with no new deposits is a no-op.
    ///         Public so a holder can pre-settle in a separate tx if
    ///         they want a clean read.
    function settleToken(uint256 shopId, address token, address holder) public {
        uint256 cumulative = cumulativeIndex[shopId][token];
        uint256 snapshot = userIndex[shopId][token][holder];
        if (cumulative == snapshot) return;
        uint256 delta = cumulative - snapshot;
        uint256 balance = shares.balanceOf(holder, shopId);
        uint256 credited = (balance * delta) / PRECISION;
        if (credited > 0) {
            claimable[shopId][token][holder] += credited;
        }
        userIndex[shopId][token][holder] = cumulative;
        emit Settled(shopId, token, holder, credited);
    }

    /// @notice Settle every token previously deposited for `shopId`.
    ///         Restricted to the ShopShares contract — this is the
    ///         transfer-hook entry point.
    function settle(uint256 shopId, address holder) external {
        if (msg.sender != address(shares)) revert NotShares(msg.sender);
        address[] memory tokens = _depositedTokens[shopId];
        uint256 len = tokens.length;
        for (uint256 i = 0; i < len; ++i) {
            settleToken(shopId, tokens[i], holder);
        }
    }

    // ---------------------------------------------------------------------
    // Claim
    // ---------------------------------------------------------------------

    /// @notice Settle (if needed) and withdraw all accrued `token` for
    ///         `msg.sender` from `shopId`.
    function claim(uint256 shopId, address token) external nonReentrant {
        settleToken(shopId, token, msg.sender);
        uint256 amount = claimable[shopId][token][msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[shopId][token][msg.sender] = 0;
        _payout(token, msg.sender, amount);
        emit Claimed(shopId, token, msg.sender, amount);
    }

    /// @notice Claim every token previously deposited for `shopId`.
    function claimAll(uint256 shopId) external nonReentrant {
        address[] memory tokens = _depositedTokens[shopId];
        uint256 len = tokens.length;
        bool anyClaimed = false;
        for (uint256 i = 0; i < len; ++i) {
            address token = tokens[i];
            settleToken(shopId, token, msg.sender);
            uint256 amount = claimable[shopId][token][msg.sender];
            if (amount == 0) continue;
            claimable[shopId][token][msg.sender] = 0;
            _payout(token, msg.sender, amount);
            emit Claimed(shopId, token, msg.sender, amount);
            anyClaimed = true;
        }
        if (!anyClaimed) revert NothingToClaim();
    }

    function _payout(address token, address to, uint256 amount) internal {
        if (token == NATIVE) {
            (bool ok, ) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice What `holder` could claim right now for (shopId, token)
    ///         if they settled + claimed in this block. Pure read, does
    ///         not modify state — safe to call from the frontend.
    function pendingClaim(uint256 shopId, address token, address holder)
        external
        view
        returns (uint256)
    {
        uint256 cumulative = cumulativeIndex[shopId][token];
        uint256 snapshot = userIndex[shopId][token][holder];
        uint256 settled = claimable[shopId][token][holder];
        if (cumulative == snapshot) return settled;
        uint256 delta = cumulative - snapshot;
        uint256 balance = shares.balanceOf(holder, shopId);
        return settled + (balance * delta) / PRECISION;
    }

    function depositedTokensOf(uint256 shopId) external view returns (address[] memory) {
        return _depositedTokens[shopId];
    }

    function cumulativeFor(uint256 shopId, address token) external view returns (uint256) {
        return cumulativeIndex[shopId][token];
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setAuthorizedDepositor(address depositor, bool authorized) external onlyOwner {
        authorizedDepositors[depositor] = authorized;
        emit AuthorizedDepositorUpdated(depositor, authorized);
    }

    /// @notice Allow this contract to receive native via plain call.
    ///         Direct sends do NOT accrue anywhere — they're "tip jar"
    ///         funds that the owner can sweep with a manual deposit.
    receive() external payable {}
}
