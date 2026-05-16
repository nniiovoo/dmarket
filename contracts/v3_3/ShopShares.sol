// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// Minimal interface so this contract only depends on ShopNFT's
/// ownership read, not on the whole ERC-721 surface. Keeps the import
/// graph tight and avoids accidentally taking a v-bump from ShopNFT.
interface IShopNFTMinimal {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// Hook called by ShopShares on every share movement so an external
/// settler (the RevenueDistributor in K.3a) can credit accrued revenue
/// to the holder before their balance changes. Implementers MUST NOT
/// revert under normal operation; failing this hook would brick share
/// transfers for the affected shopId.
interface IShareSettler {
    function settle(uint256 shopId, address holder) external;
}

/// @title ShopShares (v3.3 draft)
/// @notice ERC-1155 fungible shares of a ChainUs Shop. 10,000 supply
///         per shopId, minted once at initialization to the current
///         ShopNFT owner. Subsequent transfers are unrestricted ERC-1155.
/// @custom:status WIP-DRAFT — NOT AUDITED — DO NOT DEPLOY TO MAINNET
///
/// =====================================================================
/// DESIGN INVARIANTS
/// ---------------------------------------------------------------------
/// 1. tokenId == shopId (single namespace shared with ShopNFT).
/// 2. Total supply for any initialized shopId is exactly TOTAL_SUPPLY
///    (10,000) for the lifetime of the contract. No mint after init,
///    no burn (shares are revenue rights, not consumables).
/// 3. initializeShares is one-time per shopId, callable only by the
///    current ShopNFT.ownerOf(shopId) at call time. After ShopNFT
///    transfer, the new owner may initialize if not yet done.
/// 4. Shares and ShopNFT are independent assets after initialization.
///    Transferring the ShopNFT does NOT transfer existing shares.
///    The new ShopNFT owner gets reputation + future operator rights,
///    but must buy or be granted shares separately.
/// 5. shopNft address is immutable — chosen at deploy time. A wrong
///    deployment is unrecoverable except by re-deploying ShopShares.
/// =====================================================================
contract ShopShares is ERC1155, Ownable2Step {
    /// Fixed supply per shopId. Burned into bytecode so any change
    /// requires a redeploy — invariant 2 is enforced at the language
    /// level, not by an admin setter.
    uint256 public constant TOTAL_SUPPLY = 10_000;

    IShopNFTMinimal public immutable shopNft;

    /// shopId => has `initializeShares` already been called for it?
    mapping(uint256 => bool) public initialized;

    /// Optional revenue-distribution hook. Wired in K.3a after the
    /// distributor is deployed; settler == address(0) means no hook
    /// is installed and transfers proceed without a settle callback —
    /// safe during the deploy-time gap between this contract and the
    /// distributor going live.
    IShareSettler public settler;

    event SharesInitialized(uint256 indexed shopId, address indexed initialHolder);
    event SettlerUpdated(address indexed oldSettler, address indexed newSettler);

    error ShopNotFound(uint256 shopId);
    error AlreadyInitialized(uint256 shopId);
    error NotShopOwner(address caller, address actualOwner);
    error ZeroShopNFT();

    constructor(address _shopNft, string memory _baseUri)
        ERC1155(_baseUri)
        Ownable(msg.sender)
    {
        if (_shopNft == address(0)) revert ZeroShopNFT();
        shopNft = IShopNFTMinimal(_shopNft);
    }

    // ---------------------------------------------------------------------
    // Share initialization
    // ---------------------------------------------------------------------

    /// @notice One-time mint of TOTAL_SUPPLY shares for `shopId` to the
    ///         current ShopNFT owner. Subsequent calls revert. If the
    ///         ShopNFT for `shopId` has not been minted, this reverts
    ///         with ShopNotFound.
    function initializeShares(uint256 shopId) external {
        if (initialized[shopId]) revert AlreadyInitialized(shopId);

        // ShopNFT.ownerOf reverts with ERC721NonexistentToken when the
        // shopId hasn't been minted. We translate that into a clearer
        // ShopNotFound at our layer so callers don't have to know
        // ShopNFT's internal error names.
        address actualOwner;
        try shopNft.ownerOf(shopId) returns (address resolved) {
            actualOwner = resolved;
        } catch {
            revert ShopNotFound(shopId);
        }
        if (msg.sender != actualOwner) revert NotShopOwner(msg.sender, actualOwner);

        initialized[shopId] = true;
        _mint(msg.sender, shopId, TOTAL_SUPPLY, "");

        emit SharesInitialized(shopId, msg.sender);
    }

    /// @notice Cheap view for the frontend / indexer: returns
    ///         TOTAL_SUPPLY once shares have been initialized, 0
    ///         otherwise. Shares can never be burned so the supply is
    ///         either 0 or TOTAL_SUPPLY for the lifetime of the
    ///         contract.
    function totalSupplyOf(uint256 shopId) external view returns (uint256) {
        return initialized[shopId] ? TOTAL_SUPPLY : 0;
    }

    // ---------------------------------------------------------------------
    // Owner admin
    // ---------------------------------------------------------------------

    /// @notice Update the base URI used by `uri(id)`. Per ERC-1155 spec
    ///         this does not emit a per-id URI event; clients should
    ///         refresh metadata when they detect the contract was
    ///         updated. Used in K.5 once the indexer-backed metadata
    ///         server is live.
    function setURI(string calldata newUri) external onlyOwner {
        _setURI(newUri);
    }

    /// @notice Wire a revenue settler. Pass address(0) to disable the
    ///         hook (useful for migrations / emergency disconnects).
    function setSettler(address newSettler) external onlyOwner {
        address old = address(settler);
        settler = IShareSettler(newSettler);
        emit SettlerUpdated(old, newSettler);
    }

    // ---------------------------------------------------------------------
    // ERC-1155 _update override: settle before balances change.
    // ---------------------------------------------------------------------

    /// @dev Overrides ERC1155._update so the configured settler can
    ///      credit accrued revenue to both sides of a transfer at
    ///      pre-transfer balances. Order:
    ///        1. settle(from) using its pre-transfer balance
    ///        2. settle(to) using its pre-transfer balance (typically 0)
    ///        3. super._update moves the balances + emits TransferSingle
    ///      Mint (from == address(0)) skips the `from` callback; burn
    ///      (to == address(0)) skips the `to` callback. Self-transfers
    ///      settle once. settler == address(0) bypasses the hook entirely.
    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override {
        IShareSettler currentSettler = settler;
        if (address(currentSettler) != address(0)) {
            uint256 idsLen = ids.length;
            for (uint256 i = 0; i < idsLen; ++i) {
                uint256 shopId = ids[i];
                if (from != address(0)) {
                    currentSettler.settle(shopId, from);
                }
                if (to != address(0) && to != from) {
                    currentSettler.settle(shopId, to);
                }
            }
        }
        super._update(from, to, ids, values);
    }
}
