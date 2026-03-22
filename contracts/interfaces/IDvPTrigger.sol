// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IDvPTrigger
 * @notice Interface for atomic Delivery versus Payment settlement
 * @dev Implemented by the Settlement contract
 * Either both transfers succeed or both revert - no partial execution
 */
interface IDvPTrigger {

    // --- Structs ---
    struct SettlementInfo {
        address buyer;
        address seller;
        address securitiesToken;
        address cashToken;
        uint256 securitiesAmount;
        uint256 cashAmount;
        uint256 timestamp;
    }

    // --- Events ---
    event SettlementExecuted(
        address indexed buyer,
        address indexed seller,
        address securitiesToken,
        address cashToken,
        uint256 securitiesAmount,
        uint256 cashAmount
    );
    event SettlementFailed(address indexed buyer, address indexed seller, string reason);

    // --- Functions ---

    function settle(
        address buyer,
        address seller,
        address securitiesToken,
        address cashToken,
        uint256 securitiesAmount,
        uint256 cashAmount
    ) external returns (bool);

    function getSettlement(uint256 settlementId) external view returns (SettlementInfo memory);
}