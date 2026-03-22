// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IRegistry
 * @notice Interface for the Asset Registry contract
 * @dev Tracks all deployed token contracts and manages system configuration.
 * Acts as the directory for all compliant assets in the TSS.
 */
interface IRegistry {

    // --- Structs ---
    struct Asset {
        address tokenAddress;
        bytes32 assetType;
        address issuer;
        bool active;
        uint256 registeredAt;
    }

    // --- Events ---
    event AssetRegistered(address indexed tokenAddress, bytes32 assetType, address indexed issuer);
    event AssetDeactivated(address indexed tokenAddress);
    event AssetReactivated(address indexed tokenAddress);

    // --- Functions ---

    function registerAsset(
        address tokenAddress,
        bytes32 assetType,
        address issuer
    ) external;

    function deactivateAsset(address tokenAddress) external;

    function reactivateAsset(address tokenAddress) external;

    function getAsset(address tokenAddress) external view returns (Asset memory);

    function isRegistered(address tokenAddress) external view returns (bool);

    function isActive(address tokenAddress) external view returns (bool);

    function getAllAssets() external view returns (address[] memory);
}