// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IDvPTrigger.sol";
import "../interfaces/IAccessControl.sol";
import "../interfaces/IRegistry.sol";
import "../interfaces/ITokenTransfer.sol";

/**
 * @title Settlement
 * @notice Atomic DvP settlement contract for the TSS
 * @dev Implements IDvPTrigger. Executes atomic delivery-versus-payment.
 * Either both transfers succeed or both revert - no partial execution.
 * Generic - does not care what matching mechanism triggered the settlement.
 * Any IMatchingEngine implementation can trigger this contract.
 * Both parties must be whitelisted and both tokens must be registered.
 */
contract Settlement is IDvPTrigger {

    // --- State ---
    uint256 private _settlementCounter;
    mapping(uint256 => SettlementInfo) private _settlements;

    IAccessControl private _identity;
    IRegistry private _registry;

    bool public paused;

    // --- Roles ---
    bytes32 public constant OPERATOR = keccak256("OPERATOR");

    // --- Events ---
    event Paused(address operator);
    event Unpaused(address operator);

    // --- Modifiers ---
    modifier whenNotPaused() {
        require(!paused, "Settlement: contract is paused");
        _;
    }

    modifier onlyOperator() {
        require(
            _identity.getRole(msg.sender) == OPERATOR,
            "Settlement: caller is not an operator"
        );
        _;
    }

    // --- Constructor ---
    constructor(address identityContract, address registryContract) {
        _identity = IAccessControl(identityContract);
        _registry = IRegistry(registryContract);
    }

    // --- IDvPTrigger Implementation ---

    function settle(
        address buyer,
        address seller,
        address securitiesToken,
        address cashToken,
        uint256 securitiesAmount,
        uint256 cashAmount
    ) external override whenNotPaused returns (bool) {

        // --- Compliance checks ---
        require(_identity.isWhitelisted(buyer), "Settlement: buyer not whitelisted");
        require(_identity.isWhitelisted(seller), "Settlement: seller not whitelisted");
        require(_registry.isActive(securitiesToken), "Settlement: securities token not registered");
        require(_registry.isActive(cashToken), "Settlement: cash token not registered");
        require(securitiesAmount > 0 && cashAmount > 0, "Settlement: amounts must be > 0");

        // --- Atomic DvP ---
        // Both transfers happen in the same transaction.
        // If either reverts, the entire transaction reverts.
        // No partial execution possible.

        // 1. Transfer securities from seller to buyer
        bool securitiesOk = ITokenTransfer(securitiesToken).transferFrom(
            seller,
            buyer,
            securitiesAmount
        );
        require(securitiesOk, "Settlement: securities transfer failed");

        // 2. Transfer cash from buyer to seller
        bool cashOk = ITokenTransfer(cashToken).transferFrom(
            buyer,
            seller,
            cashAmount
        );
        require(cashOk, "Settlement: cash transfer failed");

        // --- Record settlement ---
        _settlementCounter++;
        _settlements[_settlementCounter] = SettlementInfo({
            buyer: buyer,
            seller: seller,
            securitiesToken: securitiesToken,
            cashToken: cashToken,
            securitiesAmount: securitiesAmount,
            cashAmount: cashAmount,
            timestamp: block.timestamp
        });

        emit SettlementExecuted(
            buyer,
            seller,
            securitiesToken,
            cashToken,
            securitiesAmount,
            cashAmount
        );

        return true;
    }

    function getSettlement(uint256 settlementId) external view override returns (SettlementInfo memory) {
        return _settlements[settlementId];
    }

    // --- Emergency controls ---
    function pause() external onlyOperator {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOperator {
        paused = false;
        emit Unpaused(msg.sender);
    }
}