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
    mapping(address => bool) private _authorizedEngines;

    IAccessControl private _identity;
    IRegistry private _registry;

    bool public paused;

    // --- Roles ---
    bytes32 public constant OPERATOR = keccak256("OPERATOR");

    // --- Events ---
    event Paused(address operator);
    event Unpaused(address operator);
    event EngineAuthorized(address engine);
    event EngineRevoked(address engine);

    // --- Modifiers ---
    modifier whenNotPaused() {
        require(!paused, "Settlement: contract is paused");
        _;
    }

    modifier onlyOperator() {
        require(
            _identity.isWhitelisted(msg.sender) &&
            _identity.getRole(msg.sender) == OPERATOR,
            "Settlement: caller is not an operator"
        );
        _;
    }

    modifier onlyAuthorizedEngine() {
        require(_authorizedEngines[msg.sender], "Settlement: caller is not an authorized engine");
        _;
    }

    // --- Constructor ---
    constructor(address identityContract, address registryContract) {
        require(identityContract != address(0), "Settlement: zero identity address");
        require(registryContract != address(0), "Settlement: zero registry address");
        _identity = IAccessControl(identityContract);
        _registry = IRegistry(registryContract);
    }

    // --- Engine Authorization ---

    function authorizeEngine(address engine) external onlyOperator {
        require(engine != address(0), "Settlement: zero address");
        _authorizedEngines[engine] = true;
        emit EngineAuthorized(engine);
    }

    function revokeEngine(address engine) external onlyOperator {
        require(_authorizedEngines[engine], "Settlement: engine not authorized");
        _authorizedEngines[engine] = false;
        emit EngineRevoked(engine);
    }

    function isAuthorizedEngine(address engine) external view returns (bool) {
        return _authorizedEngines[engine];
    }

    // --- IDvPTrigger Implementation ---

    function settle(
        address buyer,
        address seller,
        address securitiesToken,
        address cashToken,
        uint256 securitiesAmount,
        uint256 cashAmount
    ) external override whenNotPaused onlyAuthorizedEngine returns (bool) {

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
        require(settlementId > 0 && settlementId <= _settlementCounter, "Settlement: invalid settlement ID");
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