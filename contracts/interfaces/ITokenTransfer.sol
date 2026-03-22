// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ITokenTransfer
 * @notice Interface for compliant token transfers
 * @dev Implemented by ERC-20, ERC-1155, and Cash Token contracts
 * All transfers enforce whitelisting via IAccessControl
 */
interface ITokenTransfer {

    // --- Events ---
    event TokensTransferred(address indexed from, address indexed to, uint256 amount);
    event TokensMinted(address indexed to, uint256 amount);
    event TokensBurned(address indexed from, uint256 amount);

    // --- Functions ---

    function transfer(address to, uint256 amount) external returns (bool);

    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    function mint(address to, uint256 amount) external;

    function burn(address from, uint256 amount) external;

    function balanceOf(address account) external view returns (uint256);

    function totalSupply() external view returns (uint256);

    function pause() external;

    function unpause() external;
}