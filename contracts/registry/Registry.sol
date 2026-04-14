// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IRegistry.sol";
import "../interfaces/IAccessControl.sol";

/**
 * @title Registry
 * @notice Asset Registry contract for the TSS
 * @dev Implements IRegistry. Tracks all deployed compliant token contracts.
 * Only OPERATOR can register, deactivate or reactivate assets.
 * Acts as the directory for all assets in the system.
 */
contract Registry is IRegistry {

    // --- State ---
    mapping(address => Asset) private _assets;
    address[] private _assetList;

    IAccessControl private _identity;

    // --- Roles ---
    bytes32 public constant OPERATOR = keccak256("OPERATOR");

    // --- Modifiers ---
    modifier onlyOperator() {
        require(
            _identity.isWhitelisted(msg.sender) &&
            _identity.getRole(msg.sender) == OPERATOR,
            "Registry: caller is not an operator"
        );
        _;
    }

    // --- Constructor ---
    constructor(address _identityContract) {
        require(_identityContract != address(0), "Registry: zero identity address");
        _identity = IAccessControl(_identityContract);
    }

    // --- IRegistry Implementation ---

    function registerAsset(
        address tokenAddress,
        bytes32 assetType,
        address issuer
    ) external override onlyOperator {
        require(tokenAddress != address(0), "Registry: zero address");
        require(issuer != address(0), "Registry: zero issuer address");
        require(_assets[tokenAddress].registeredAt == 0, "Registry: asset already registered");

        _assets[tokenAddress] = Asset({
            tokenAddress: tokenAddress,
            assetType: assetType,
            issuer: issuer,
            active: true,
            registeredAt: block.timestamp
        });

        _assetList.push(tokenAddress);

        emit AssetRegistered(tokenAddress, assetType, issuer);
    }

    function deactivateAsset(address tokenAddress) external override onlyOperator {
        require(_assets[tokenAddress].active, "Registry: asset not active");
        _assets[tokenAddress].active = false;
        emit AssetDeactivated(tokenAddress);
    }

    function reactivateAsset(address tokenAddress) external override onlyOperator {
        require(_assets[tokenAddress].registeredAt > 0, "Registry: asset not registered");
        require(!_assets[tokenAddress].active, "Registry: asset already active");
        _assets[tokenAddress].active = true;
        emit AssetReactivated(tokenAddress);
    }

    function getAsset(address tokenAddress) external view override returns (Asset memory) {
        return _assets[tokenAddress];
    }

    function isRegistered(address tokenAddress) external view override returns (bool) {
        return _assets[tokenAddress].registeredAt > 0;
    }

    function isActive(address tokenAddress) external view override returns (bool) {
        return _assets[tokenAddress].active;
    }

    function getAllAssets() external view override returns (address[] memory) {
        return _assetList;
    }
}