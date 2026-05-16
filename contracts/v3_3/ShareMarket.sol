// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title ShareMarket (v3.3 draft)
/// @notice Approval-based, all-or-nothing listing market for ChainUs
///         ShopShares. Sellers list a fixed (shopId, amount) at a fixed
///         total price; buyers either fill the whole listing or move on.
/// @custom:status WIP-DRAFT — NOT AUDITED — DO NOT DEPLOY TO MAINNET
///
/// =====================================================================
/// DESIGN — approval, all-or-nothing, no escrow, no platform fee
/// ---------------------------------------------------------------------
/// 1. Approval pattern. Shares STAY in the seller's wallet for the
///    lifetime of the listing. The market never holds shares. At fill
///    time we do `shares.safeTransferFrom(seller, buyer, ...)`, which
///    requires the seller to have called
///    `shopShares.setApprovalForAll(market, true)` ahead of time.
///    Trade-off: a "phantom listing" is possible — seller transferred
///    shares away or revoked the approval after listing. We catch
///    these at fill time (the inner safeTransferFrom reverts and our
///    fill reverts with the same error), but we don't pre-detect.
///    Rationale: keeping shares in the seller's wallet means the
///    distributor's per-share-index settles them correctly even while
///    a listing is up. Escrowing into the market would either need
///    settle plumbing on the market or risk dividend orphaning.
///
/// 2. All-or-nothing fills. One listing → one (amount, totalPrice).
///    Multi-tier sellers post multiple listings. Simplifies the state
///    machine: a listing is either Active, Filled, or Cancelled. No
///    partial-fill accounting until K.4b if/when warranted.
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
        uint256 amount;
        address paymentToken;
        uint256 totalPrice;
        ListingStatus status;
        uint64 createdAt;
        uint64 closedAt;
    }

    mapping(uint256 => Listing) public listings;
    uint256 public nextListingId;

    // Per-seller index for the frontend's "my listings" view. Production
    // would do this off-chain in the indexer; we surface it on-chain so
    // K.4 has a usable UX without K.5 indexer work.
    mapping(address => uint256[]) private sellerListings;

    event ListingCreated(
        uint256 indexed listingId,
        address indexed seller,
        uint256 indexed shopId,
        uint256 amount,
        address paymentToken,
        uint256 totalPrice
    );
    event ListingFilled(
        uint256 indexed listingId,
        address indexed buyer,
        address indexed seller,
        uint256 shopId,
        uint256 amount,
        address paymentToken,
        uint256 totalPrice
    );
    event ListingCancelled(uint256 indexed listingId, address indexed seller);

    error ListingNotFound(uint256 listingId);
    error ListingNotActive(uint256 listingId, ListingStatus status);
    error NotListingSeller(address caller, address seller);
    error AmountZero();
    error PriceZero();
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

    /// @notice Post a fixed-amount, fixed-price listing for `shopId`
    ///         shares. Requires `shopShares.setApprovalForAll(this,true)`
    ///         and enough share balance at call time. The balance + the
    ///         approval can both later vanish — fills will then revert
    ///         (phantom listing).
    function createListing(
        uint256 shopId,
        uint256 amount,
        address paymentToken,
        uint256 totalPrice
    ) external whenNotPaused returns (uint256 listingId) {
        if (amount == 0) revert AmountZero();
        if (totalPrice == 0) revert PriceZero();
        if (!shares.isApprovedForAll(msg.sender, address(this))) {
            revert MarketNotApproved(msg.sender);
        }
        uint256 bal = shares.balanceOf(msg.sender, shopId);
        if (bal < amount) revert InsufficientShares(msg.sender, shopId, bal, amount);

        listingId = nextListingId++;
        listings[listingId] = Listing({
            seller: msg.sender,
            shopId: shopId,
            amount: amount,
            paymentToken: paymentToken,
            totalPrice: totalPrice,
            status: ListingStatus.Active,
            createdAt: uint64(block.timestamp),
            closedAt: 0
        });
        sellerListings[msg.sender].push(listingId);

        emit ListingCreated(listingId, msg.sender, shopId, amount, paymentToken, totalPrice);
    }

    /// @notice Buy the whole listing in one tx. For native payments,
    ///         msg.value MUST equal `listing.totalPrice` exactly — no
    ///         partial pays, no overpayments (the buyer's wallet
    ///         shows them the exact required amount).
    function fillListing(uint256 listingId) external payable nonReentrant whenNotPaused {
        Listing storage listing = _requireActive(listingId);

        // CEI: flip state before any external call so a reentrant
        // attempt on the same listing fails the activity check.
        address seller = listing.seller;
        uint256 shopId = listing.shopId;
        uint256 amount = listing.amount;
        address paymentToken = listing.paymentToken;
        uint256 totalPrice = listing.totalPrice;

        listing.status = ListingStatus.Filled;
        listing.closedAt = uint64(block.timestamp);

        // Pay seller first. If this reverts the whole fill rolls back
        // (no share transfer, listing stays "Filled" but the tx didn't
        // commit — which is the correct behavior).
        if (paymentToken == address(0)) {
            if (msg.value != totalPrice) revert PaymentAmountMismatch(totalPrice, msg.value);
            (bool ok, ) = payable(seller).call{value: msg.value}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            if (msg.value != 0) revert PaymentAmountMismatch(0, msg.value);
            IERC20(paymentToken).safeTransferFrom(msg.sender, seller, totalPrice);
        }

        // Share transfer last. If the seller revoked approval or sold
        // the shares between listing and fill, this reverts (phantom
        // listing) and unwinds the seller payout above.
        shares.safeTransferFrom(seller, msg.sender, shopId, amount, "");

        emit ListingFilled(listingId, msg.sender, seller, shopId, amount, paymentToken, totalPrice);
    }

    /// @notice Withdraw an active listing. Always available — even
    ///         when the contract is paused — so sellers retain the
    ///         right to unwind their own positions.
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

    function getSellerListings(address seller) external view returns (uint256[] memory) {
        return sellerListings[seller];
    }

    /// @notice O(n) scan over every listing — DEMO ONLY. The K.5
    ///         indexer will expose an active-count read backed by an
    ///         off-chain index. Gas grows linearly; never call this
    ///         from another contract.
    function getActiveListingCount() external view returns (uint256 count) {
        uint256 last = nextListingId;
        for (uint256 i = 1; i < last; ++i) {
            if (listings[i].status == ListingStatus.Active) {
                ++count;
            }
        }
    }
}
