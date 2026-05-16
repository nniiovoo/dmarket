// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title ShopNFT (v3.3 draft)
/// @notice Each merchant on ChainUs owns exactly one ShopNFT — a
///         transferable identity + asset envelope for the store's
///         reputation, products, and future revenue claims.
/// @custom:status WIP-DRAFT — NOT AUDITED — DO NOT DEPLOY TO MAINNET
///
/// =====================================================================
/// DESIGN INVARIANTS
/// ---------------------------------------------------------------------
/// 1. One seller wallet owns at most one ShopNFT at any given time
///    (`shopIdOf[seller] != 0` iff seller owns a ShopNFT).
/// 2. ShopNFT is transferable, but transfer to an address that already
///    owns a shop reverts (preserves invariant 1).
/// 3. shopId starts at 1, monotonically increasing. shopId=0 means
///    "no shop" — used as sentinel in shopIdOf mapping.
/// 4. Mint requires a payable fee that is forwarded to feeRecipient.
///    This is the platform's revenue line; over-payments are refunded
///    to msg.sender.
/// 5. adminMint bypasses the mint fee — used to batch-migrate existing
///    v3.2 sellers into the NFT layer.
/// 6. Metadata (name / description / imageUrl) is mutable by the
///    current owner only. The original creator address and creation
///    timestamp are immutable in shops[shopId].
/// 7. This contract owns NO order data and NO reputation logic. It is
///    purely an identity + ownership layer. The Phase K.5 indexer will
///    mirror NFT transfers and reputation calculation will start
///    keying on ownerOf(shopId) instead of the original seller
///    address. v3.2 contracts are NOT touched.
/// =====================================================================
contract ShopNFT is ERC721, Ownable2Step {
    struct ShopMeta {
        address creator;
        uint64 createdAt;
        string name;
        string description;
        string imageUrl;
    }

    /// shopIdOf[address] == 0 means "this address does not own a shop".
    /// shopIds start at 1 (see `nextShopId` initialiser).
    mapping(address => uint256) public shopIdOf;
    mapping(uint256 => ShopMeta) public shops;

    /// Monotonic counter. Always points at the *next* shopId to be
    /// minted; the most-recently-minted shop has id `nextShopId - 1`.
    uint256 public nextShopId;

    uint256 public mintFeeWei;
    address public feeRecipient;

    event ShopCreated(uint256 indexed shopId, address indexed creator, string name);
    event ShopMetadataUpdated(uint256 indexed shopId, string name, string description, string imageUrl);
    event MintFeeUpdated(uint256 oldFee, uint256 newFee);
    event FeeRecipientUpdated(address oldRecipient, address newRecipient);

    error AlreadyOwnsShop(address holder);
    error InsufficientMintFee(uint256 sent, uint256 required);
    error NotShopOwner(address caller, uint256 shopId);
    error ZeroAddress();
    error MintFeeTransferFailed();
    error RefundFailed();

    constructor(uint256 _mintFeeWei, address _feeRecipient)
        ERC721("ChainUsShop", "CUS-SHOP")
        Ownable(msg.sender)
    {
        if (_feeRecipient == address(0)) revert ZeroAddress();
        mintFeeWei = _mintFeeWei;
        feeRecipient = _feeRecipient;
        nextShopId = 1;
    }

    // ---------------------------------------------------------------------
    // Minting
    // ---------------------------------------------------------------------

    /// @notice Self-serve mint. Caller pays mintFeeWei (over-payments
    ///         are refunded). Reverts if the caller already owns a shop.
    function mintShop(
        string calldata name,
        string calldata description,
        string calldata imageUrl
    ) external payable returns (uint256 shopId) {
        if (shopIdOf[msg.sender] != 0) revert AlreadyOwnsShop(msg.sender);
        uint256 fee = mintFeeWei;
        if (msg.value < fee) revert InsufficientMintFee(msg.value, fee);

        shopId = nextShopId++;
        shops[shopId] = ShopMeta({
            creator: msg.sender,
            createdAt: uint64(block.timestamp),
            name: name,
            description: description,
            imageUrl: imageUrl
        });

        // _mint() goes through _update(), which sets shopIdOf[msg.sender]
        // and enforces the 1-seller-1-shop invariant.
        _mint(msg.sender, shopId);

        emit ShopCreated(shopId, msg.sender, name);

        // Forward fee to the platform recipient. We use call() rather
        // than transfer() so this contract works even if feeRecipient
        // is a contract with a non-trivial fallback (e.g. a multisig).
        if (fee > 0) {
            (bool ok, ) = feeRecipient.call{value: fee}("");
            if (!ok) revert MintFeeTransferFailed();
        }

        // Refund any over-payment. Done after the fee transfer so a
        // misbehaving feeRecipient can't drain user funds.
        uint256 refund = msg.value - fee;
        if (refund > 0) {
            (bool refundOk, ) = msg.sender.call{value: refund}("");
            if (!refundOk) revert RefundFailed();
        }
    }

    /// @notice Owner-only mint that bypasses the fee. Intended for
    ///         the one-shot migration of existing v3.2 sellers into
    ///         the ShopNFT layer (see scripts/migrateSellersToShopNFT.ts).
    function adminMint(
        address recipient,
        string calldata name,
        string calldata description,
        string calldata imageUrl
    ) external onlyOwner returns (uint256 shopId) {
        if (recipient == address(0)) revert ZeroAddress();
        if (shopIdOf[recipient] != 0) revert AlreadyOwnsShop(recipient);

        shopId = nextShopId++;
        shops[shopId] = ShopMeta({
            creator: recipient,
            createdAt: uint64(block.timestamp),
            name: name,
            description: description,
            imageUrl: imageUrl
        });

        _mint(recipient, shopId);
        emit ShopCreated(shopId, recipient, name);
    }

    // ---------------------------------------------------------------------
    // Metadata
    // ---------------------------------------------------------------------

    /// @notice Update mutable metadata. Only the current owner of the
    ///         NFT can update; creator / createdAt are immutable.
    function updateShopMeta(
        uint256 shopId,
        string calldata name,
        string calldata description,
        string calldata imageUrl
    ) external {
        if (ownerOf(shopId) != msg.sender) revert NotShopOwner(msg.sender, shopId);
        ShopMeta storage meta = shops[shopId];
        meta.name = name;
        meta.description = description;
        meta.imageUrl = imageUrl;
        emit ShopMetadataUpdated(shopId, name, description, imageUrl);
    }

    // ---------------------------------------------------------------------
    // ERC-721 transfer hook: enforce 1-seller-1-shop on every transfer.
    // ---------------------------------------------------------------------

    /// @dev Overrides OpenZeppelin v5's `_update` (the single hook
    ///      covering mint, transferFrom, safeTransferFrom, burn).
    ///      Same signature as ERC721._update; we adjust shopIdOf and
    ///      then delegate to super.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address from)
    {
        from = super._update(to, tokenId, auth);

        // After super._update, the token's owner has been swapped from
        // `from` to `to`. Mirror that into shopIdOf.
        //   - mint: from == address(0); only the `to` branch fires.
        //   - burn: to == address(0); only the `from` branch fires. We
        //           don't expose a burn entry point, but a hypothetical
        //           one would correctly clear shopIdOf[from].
        //   - transfer: both branches fire.
        if (from != address(0) && from != to) {
            shopIdOf[from] = 0;
        }
        if (to != address(0)) {
            if (shopIdOf[to] != 0 && shopIdOf[to] != tokenId) {
                revert AlreadyOwnsShop(to);
            }
            shopIdOf[to] = tokenId;
        }
    }

    // ---------------------------------------------------------------------
    // Owner admin
    // ---------------------------------------------------------------------

    function setMintFee(uint256 newFeeWei) external onlyOwner {
        uint256 oldFee = mintFeeWei;
        mintFeeWei = newFeeWei;
        emit MintFeeUpdated(oldFee, newFeeWei);
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        address oldRecipient = feeRecipient;
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(oldRecipient, newRecipient);
    }
}
