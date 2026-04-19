// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IAccessControl.sol";

/**
 * @title Identity
 * @notice Identity & Whitelisting contract for the TSS
 * @dev Implements IAccessControl. Enforces KYC and role-based access.
 * Only the OPERATOR role can whitelist/revoke users.
 * Attestations have an expiry - users must re-verify periodically.
 */
contract Identity is IAccessControl {

    // --- Roles ---
    bytes32 public constant TRADER    = keccak256("TRADER");
    bytes32 public constant ISSUER    = keccak256("ISSUER");
    bytes32 public constant OPERATOR  = keccak256("OPERATOR");
    bytes32 public constant REGULATOR = keccak256("REGULATOR");

    // --- State ---
    struct UserRecord {
        bytes32 role;
        bool active;
        uint256 expiry;
        bool easyReverification;
        bool preferenceSet;
    }

    mapping(address => UserRecord) private _users;
    address public admin;
    address public pendingAdmin;

    // --- Events ---
    event AdminTransferInitiated(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminTransferAccepted(address indexed newAdmin);

    // --- Modifiers ---
    modifier onlyOperator() {
        require(
            _users[msg.sender].role == OPERATOR &&
            _users[msg.sender].active &&
            block.timestamp <= _users[msg.sender].expiry,
            "Identity: caller is not an operator"
        );
        _;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "Identity: caller is not admin");
        _;
    }

    // --- Constructor ---
    constructor() {
        admin = msg.sender;
        // Bootstrap: give deployer OPERATOR role with no expiry
        _users[msg.sender] = UserRecord({
            role: OPERATOR,
            active: true,
            expiry: type(uint256).max,
            easyReverification: true,
            preferenceSet: true
        });
    }

    // --- IAccessControl Implementation ---

    function whitelist(address user, bytes32 role) external override onlyOperator {
        require(user != address(0), "Identity: zero address");
        require(
            role == TRADER || role == ISSUER || role == OPERATOR || role == REGULATOR,
            "Identity: invalid role"
        );

        bool easyReverification = _users[user].preferenceSet
            ? _users[user].easyReverification
            : true;

        _users[user] = UserRecord({
            role: role,
            active: true,
            expiry: type(uint256).max,
            easyReverification: easyReverification,
            preferenceSet: true
        });
        emit UserWhitelisted(user, role);
    }

    function revoke(address user) external override onlyOperator {
        require(_users[user].active, "Identity: user not active");
        _users[user].active = false;
        _users[user].role = bytes32(0);
        emit UserRevoked(user);
    }

    function isWhitelisted(address user) external view override returns (bool) {
        UserRecord memory r = _users[user];
        return r.active && block.timestamp <= r.expiry;
    }

    function getRole(address user) external view override returns (bytes32) {
        UserRecord memory r = _users[user];
        if (!r.active || block.timestamp > r.expiry) {
            return bytes32(0);
        }
        return r.role;
    }

    function isExpired(address user) external view override returns (bool) {
        return block.timestamp > _users[user].expiry;
    }

    function updateAttestation(address user, uint256 newExpiry) external override onlyOperator {
        require(_users[user].active, "Identity: user not active");
        require(_users[user].easyReverification, "Identity: user requires full reverification");
        require(newExpiry > block.timestamp, "Identity: expiry must be in future");
        _users[user].expiry = newExpiry;
        emit AttestationUpdated(user, newExpiry);
    }

    function setReverificationPreference(bool easyReverification) external override {
        _users[msg.sender].easyReverification = easyReverification;
        _users[msg.sender].preferenceSet = true;
        emit ReverificationPreferenceUpdated(msg.sender, easyReverification);
    }

    function prefersEasyReverification(address user) external view override returns (bool) {
        if (_users[user].preferenceSet) {
            return _users[user].easyReverification;
        }
        return true;
    }

    // --- Admin Transfer ---

    function initiateAdminTransfer(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "Identity: zero address");
        pendingAdmin = newAdmin;
        emit AdminTransferInitiated(admin, newAdmin);
    }

    function acceptAdminTransfer() external {
        require(msg.sender == pendingAdmin, "Identity: caller is not pending admin");
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminTransferAccepted(admin);
    }
}