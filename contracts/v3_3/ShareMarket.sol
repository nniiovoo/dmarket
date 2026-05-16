// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title ShareMarket (v3.3 — Phase M.1, partial-fill redesign)
/// @notice Approval-based listing market for ChainUs ShopShares with
///         per-token pricing and incremental fills. Sellers list a
///         total amount at a `pricePerToken`; buyers may fill any
///         strictly positive `amount` ≤ `remainingAmount`. Status
///         flips to Filled once `remainingAmount` reaches 0.
/// @custom:status WIP-DRAFT — NOT AUDITED — DO NOT DEPLOY TO MAINNET
///
/// =====================================================================
/// DESIGN — approval, per-token pricing, incremental fills, no escrow
/// ---------------------------------------------------------------------
/// 1. Approval pattern. Tokens STAY in the seller's wallet for the
///    lifetime of the listing. The market never holds tokens. At each
///    fill we do `shares.safeTransferFrom(seller, buyer, ...)`, which
///    requires the seller to have called
///    `shopShares.setApprovalForAll(market, true)` ahead of time.
///    A "phantom listing" is possible — seller transferred tokens away
///    or revoked the approval after listing. We catch these at fill
///    time (the inner safeTransferFrom reverts and our fill reverts
///    with the same error).
///
/// 2. Per-token pricing + partial fills (Phase M.1). One listing is a
///    bag of `originalAmount` tokens priced at `pricePerToken` each.
///    A fill consumes a strictly positive `amount` ≤ `remainingAmount`
///    and charges `pricePerToken * amount`. The contract enforces
///    `Active → (Active*N) → Filled` monotonically — `remainingAmount`
///    never increases, and the status flips exactly once when it
///    reaches zero.
///
/// 3. Direct payment. Buyer's funds go straight to the seller —
///    market holds zero funds between calls. A future platform fee is
///    one extra branch in `fillListing`; we deliberately leave the
///    plumbing flat for MVP.
///
/// 4. paymentToken can be address(0) (native) or any ERC-20. We do
///    NOT allowlist tokens here: a buyer evaluates the listing's
///    paymentToken just as they evaluate the seller and the price.
///    Phantom-token risk is no greater than phantom-listing risk.
///
/// 5. Migration note. The pre-M.1 ShareMarket (K.4 deploy) was
///    all-or-nothing with a fixed `totalPrice`. M.1 replaces it
///    rather than versioning the struct, because the K.4 deploy had
///    no active listings at cutover; this contract's address is
///    fresh and the old one is retired in the env.
/// =====================================================================
contract ShareMarket is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    IERC1155 public immutable shares;

    enum ListingStatus {
        Active,
        Filled,
        Cancelled
    }

    struct Listing {
        address seller;
        uint256 shopId;
        uint256 originalAmount;  // listing size at create time — immutable
        uint256 remainingAmount; // unfilled balance — monotonically decreases
        address paymentToken;
        uint256 pricePerToken;   // unit price; `totalCost = pricePerToken * amount`
        ListingStatus status;
        uint64 createdAt;
        uint64 closedAt;
    }

    mapping(uint256 => Listing) public listings;
    uint256 public nextListingId;

    // Per-seller index for the frontend's "my listings" view. Production
    // would do this off-chain in the indexer; we surface it on-chain so
    // the UX is usable without a hot indexer.
    mapping(address => uint256[]) private sellerListings;

    event ListingCreated(
        uint256 indexed listingId,
        address indexed seller,
        uint256 indexed shopId,
        uint256 amount,
        address paymentToken,
        uint256 pricePerToken
    );
    event ListingFilled(
        uint256 indexed listingId,
        address indexed buyer,
        address indexed seller,
        uint256 shopId,
        uint256 amount,
        address paymentToken,
        uint256 totalCost,
        uint256 remainingAfter
    );
    event ListingCancelled(uint256 indexed listingId, address indexed seller);

    error ListingNotFound(uint256 listingId);
    error ListingNotActive(uint256 listingId, ListingStatus status);
    error NotListingSeller(address caller, address seller);
    error AmountZero();
    error PriceZero();
    error FillAmountExceedsRemaining(uint256 requested, uint256 remaining);
    error PaymentAmountMismatch(uint256 expected, uint256 sent);
    error MarketNotApproved(address seller);
    error InsufficientShares(address seller, uint256 shopId, uint256 has, uint256 needed);
    error NativeTransferFailed();
    error ZeroShares();

    constructor(address _shares) Ownable(msg.sender) {
        if (_shares == address(0)) revert ZeroShares();
        shares = IERC1155(_shares);
        nextListingId = 1;
    }

    /// Stray ETH gets bounced — every native fill must go through
    /// fillListing where msg.value is paired with a specific listing.
    receive() external payable {
        revert("Direct ETH transfers are not allowed");
    }

    // ---------------------------------------------------------------------
    // Owner admin
    // ---------------------------------------------------------------------
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Listing lifecycle
    // ---------------------------------------------------------------------

    /// @notice Post a listing of `amount` tokens at `pricePerToken` each.
    ///         Requires `shopShares.setApprovalForAll(this,true)` and
    ///         enough balance at call time. Both can later vanish —
    ///         subsequent fills will then revert (phantom listing).
    function createListing(
        uint256 shopId,
        uint256 amount,
        address paymentToken,
        uint256 pricePerToken
    ) external whenNotPaused returns (uint256 listingId) {
        if (amount == 0) revert AmountZero();
        if (pricePerToken == 0) revert PriceZero();
        if (!shares.isApprovedForAll(msg.sender, address(this))) {
            revert MarketNotApproved(msg.sender);
        }
        uint256 bal = shares.balanceOf(msg.sender, shopId);
        if (bal < amount) revert InsufficientShares(msg.sender, shopId, bal, amount);

        listingId = nextListingId++;
        listings[listingId] = Listing({
            seller: msg.sender,
            shopId: shopId,
            originalAmount: amount,
            remainingAmount: amount,
            paymentToken: paymentToken,
            pricePerToken: pricePerToken,
            status: ListingStatus.Active,
            createdAt: uint64(block.timestamp),
            closedAt: 0
        });
        sellerListings[msg.sender].push(listingId);

        emit ListingCreated(listingId, msg.sender, shopId, amount, paymentToken, pricePerToken);
    }

    /// @notice Fill `amount` tokens of a listing (1 ≤ amount ≤ remaining).
    ///         For native payments, `msg.value` MUST equal
    ///         `pricePerToken * amount` exactly. Listing flips to Filled
    ///         iff `remainingAmount` reaches 0 in this call.
    function fillListing(uint256 listingId, uint256 amount) external payable nonReentrant whenNotPaused {
        Listing storage listing = _requireActive(listingId);
        if (amount == 0) revert AmountZero();
        if (amount > listing.remainingAmount) {
            revert FillAmountExceedsRemaining(amount, listing.remainingAmount);
        }

        // CEI: snapshot + state change before external calls.
        address seller = listing.seller;
        uint256 shopId = listing.shopId;
        address paymentToken = listing.paymentToken;
        uint256 pricePerToken = listing.pricePerToken;
        uint256 totalCost = pricePerToken * amount;

        uint256 remainingAfter = listing.remainingAmount - amount;
        listing.remainingAmount = remainingAfter;
        if (remainingAfter == 0) {
            listing.status = ListingStatus.Filled;
            listing.closedAt = uint64(block.timestamp);
        }

        // Pay seller first. If this reverts the whole fill rolls back.
        if (paymentToken == address(0)) {
            if (msg.value != totalCost) revert PaymentAmountMismatch(totalCost, msg.value);
            (bool ok, ) = payable(seller).call{value: msg.value}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            if (msg.value != 0) revert PaymentAmountMismatch(0, msg.value);
            IERC20(paymentToken).safeTransferFrom(msg.sender, seller, totalCost);
        }

        // Token transfer last. If the seller revoked approval or sold
        // the tokens between listing and fill, this reverts (phantom
        // listing) and unwinds the seller payout above.
        shares.safeTransferFrom(seller, msg.sender, shopId, amount, "");

        emit ListingFilled(listingId, msg.sender, seller, shopId, amount, paymentToken, totalCost, remainingAfter);
    }

    /// @notice Withdraw an active listing. Always available — even when
    ///         the contract is paused — so sellers retain the right to
    ///         unwind their own positions. Any unfilled balance is
    ///         abandoned (tokens stay in the seller's wallet).
    function cancelListing(uint256 listingId) external {
        Listing storage listing = _requireActive(listingId);
        if (msg.sender != listing.seller) revert NotListingSeller(msg.sender, listing.seller);

        listing.status = ListingStatus.Cancelled;
        listing.closedAt = uint64(block.timestamp);

        emit ListingCancelled(listingId, msg.sender);
    }

    function _requireActive(uint256 listingId) internal view returns (Listing storage listing) {
        if (listingId == 0 || listingId >= nextListingId) revert ListingNotFound(listingId);
        listing = listings[listingId];
        if (listing.status != ListingStatus.Active) {
            revert ListingNotActive(listingId, listing.status);
        }
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------
    function getListing(uint256 listingId) external view returns (Listing memory) {
        if (listingId == 0 || listingId >= nextListingId) revert ListingNotFound(listingId);
        return listings[listingId];
    }

    function getRemainingAmount(uint256 listingId) external view returns (uint256) {
        if (listingId == 0 || listingId >= nextListingId) revert ListingNotFound(listingId);
        return listings[listingId].remainingAmount;
    }

    function getSellerListings(address seller) external view returns (uint256[] memory) {
        return sellerListings[seller];
    }

    /// @notice O(n) scan over every listing — DEMO ONLY. The indexer
    ///         exposes an active-count read backed by Postgres. Gas
    ///         grows linearly; never call this from another contract.
    function getActiveListingCount() external view returns (uint256 count) {
        uint256 last = nextListingId;
        for (uint256 i = 1; i < last; ++i) {
            if (listings[i].status == ListingStatus.Active) {
                ++count;
            }
        }
    }
}
