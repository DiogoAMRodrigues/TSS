// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IAccessControl
 * @notice Interface for identity verification and role-based access control
 * @dev Implemented by the Identity & Whitelisting contract
 */
interface IAccessControl {

    // --- Roles ---
    // TRADER, ISSUER, OPERATOR, REGULATOR

    // --- Events ---
    event UserWhitelisted(address indexed user, bytes32 role);
    event UserRevoked(address indexed user);
    event AttestationUpdated(address indexed user, uint256 expiry);

    // --- Functions ---

    function whitelist(address user, bytes32 role) external;

    function revoke(address user) external;

    function isWhitelisted(address user) external view returns (bool);

    function getRole(address user) external view returns (bytes32);

    function isExpired(address user) external view returns (bool);

    function updateAttestation(address user, uint256 newExpiry) external;
}