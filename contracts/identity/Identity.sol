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
    bytes32 public constant TRADER   = keccak256("TRADER");
    bytes32 public constant ISSUER   = keccak256("ISSUER");
    bytes32 public constant OPERATOR = keccak256("OPERATOR");
    bytes32 public constant REGULATOR = keccak256("REGULATOR");

    // --- State ---
    struct UserRecord {
        bytes32 role;
        bool active;
        uint256 expiry;
    }

    mapping(address => UserRecord) private _users;
    address public admin;

    // --- Modifiers ---
    modifier onlyOperator() {
        require(
            _users[msg.sender].role == OPERATOR && _users[msg.sender].active,
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
            expiry: type(uint256).max
        });
    }

    // --- IAccessControl Implementation ---

    function whitelist(address user, bytes32 role) external override onlyOperator {
        require(user != address(0), "Identity: zero address");
        require(
            role == TRADER || role == ISSUER || role == OPERATOR || role == REGULATOR,
            "Identity: invalid role"
        );
        _users[user] = UserRecord({
            role: role,
            active: true,
            expiry: type(uint256).max  // no expiry on whitelist; use updateAttestation to set one
        });
        emit UserWhitelisted(user, role);
    }

    function revoke(address user) external override onlyOperator {
        require(_users[user].active, "Identity: user not active");
        _users[user].active = false;
        emit UserRevoked(user);
    }

    function isWhitelisted(address user) external view override returns (bool) {
        UserRecord memory r = _users[user];
        return r.active && block.timestamp <= r.expiry;
    }

    function getRole(address user) external view override returns (bytes32) {
        return _users[user].role;
    }

    function isExpired(address user) external view override returns (bool) {
        return block.timestamp > _users[user].expiry;
    }

    function updateAttestation(address user, uint256 newExpiry) external override onlyOperator {
        require(_users[user].active, "Identity: user not active");
        require(newExpiry > block.timestamp, "Identity: expiry must be in future");
        _users[user].expiry = newExpiry;
        emit AttestationUpdated(user, newExpiry);
    }
}