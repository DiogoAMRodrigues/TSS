// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/ITokenTransfer.sol";
import "../interfaces/IAccessControl.sol";

/**
 * @title SecuritiesToken
 * @notice ERC-20 compliant token representing a tokenized security
 * @dev Implements ITokenTransfer. Every transfer checks whitelisting via IAccessControl.
 * Only whitelisted addresses can send or receive tokens.
 * Only OPERATOR/ISSUER can mint. Only OPERATOR can burn.
 * Pausable for regulatory intervention.
 */
contract SecuritiesToken is ITokenTransfer {

    // --- State ---
    string public name;
    string public symbol;
    uint8 public decimals = 18;

    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    bool public paused;
    address public identityContract;

    IAccessControl private _identity;

    // --- Roles ---
    bytes32 public constant OPERATOR = keccak256("OPERATOR");
    bytes32 public constant ISSUER   = keccak256("ISSUER");

    // --- Events ---
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Paused(address operator);
    event Unpaused(address operator);

    // --- Modifiers ---
    modifier whenNotPaused() {
        require(!paused, "SecuritiesToken: contract is paused");
        _;
    }

    modifier onlyOperator() {
        require(
            _identity.getRole(msg.sender) == OPERATOR,
            "SecuritiesToken: caller is not an operator"
        );
        _;
    }

    modifier onlyIssuerOrOperator() {
        bytes32 role = _identity.getRole(msg.sender);
        require(
            role == OPERATOR || role == ISSUER,
            "SecuritiesToken: caller is not issuer or operator"
        );
        _;
    }

    modifier onlyWhitelisted(address from, address to) {
        require(_identity.isWhitelisted(from), "SecuritiesToken: sender not whitelisted");
        require(_identity.isWhitelisted(to), "SecuritiesToken: recipient not whitelisted");
        _;
    }

    // --- Constructor ---
    constructor(string memory _name, string memory _symbol, address _identityContract) {
        name = _name;
        symbol = _symbol;
        identityContract = _identityContract;
        _identity = IAccessControl(_identityContract);
    }

    // --- ITokenTransfer Implementation ---

    function transfer(address to, uint256 amount) 
        external 
        override 
        whenNotPaused 
        onlyWhitelisted(msg.sender, to) 
        returns (bool) 
    {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount)
        external
        override
        whenNotPaused
        onlyWhitelisted(from, to)
        returns (bool)
    {
        require(_allowances[from][msg.sender] >= amount, "SecuritiesToken: insufficient allowance");
        _allowances[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        return true;
    }

    function mint(address to, uint256 amount) external override onlyIssuerOrOperator {
        require(_identity.isWhitelisted(to), "SecuritiesToken: recipient not whitelisted");
        _totalSupply += amount;
        _balances[to] += amount;
        emit TokensMinted(to, amount);
    }

    function burn(address from, uint256 amount) external override onlyOperator {
        require(_balances[from] >= amount, "SecuritiesToken: insufficient balance");
        _balances[from] -= amount;
        _totalSupply -= amount;
        emit TokensBurned(from, amount);
    }

    function balanceOf(address account) external view override returns (uint256) {
        return _balances[account];
    }

    function totalSupply() external view override returns (uint256) {
        return _totalSupply;
    }

    function pause() external override onlyOperator {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external override onlyOperator {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // --- ERC-20 Approval ---
    function approve(address spender, uint256 amount) external returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return _allowances[owner][spender];
    }

    // --- Internal ---
    function _transfer(address from, address to, uint256 amount) internal {
        require(_balances[from] >= amount, "SecuritiesToken: insufficient balance");
        _balances[from] -= amount;
        _balances[to] += amount;
        emit TokensTransferred(from, to, amount);
    }
}