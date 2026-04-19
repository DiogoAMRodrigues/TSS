// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IMatchingEngine.sol";
import "../interfaces/IAccessControl.sol";
import "../interfaces/IRegistry.sol";
import "../interfaces/IDvPTrigger.sol";

interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/**
 * @title AMM
 * @notice Constant-product AMM implementation of IMatchingEngine
 * @dev Uses Settlement for atomic DvP. The AMM contract acts as pool counterparty.
 * Traders submit swap intents via submitOrder.
 */
contract AMM is IMatchingEngine {
    uint256 private constant BPS = 10_000;
    bytes32 private constant CASH_TOKEN_TYPE = bytes32("CASH_TOKEN");
    bytes32 private constant SECURITIES_TYPE = bytes32("SECURITIES");

    uint256 private _orderCounter;
    uint256 private _matchCounter;

    mapping(uint256 => Order) private _orders;
    mapping(uint256 => Match) private _matches;

    IAccessControl private _identity;
    IRegistry private _registry;
    IDvPTrigger private _settlement;

    bool public paused;
    bool public poolInitialized;

    address public cashToken;
    address public securitiesToken;

    uint256 public reserveCash;
    uint256 public reserveSecurities;

    uint256 public totalLiquidityShares;
    mapping(address => uint256) public liquidityShares;

    uint256 public feeBps;

    bytes32 public constant OPERATOR = keccak256("OPERATOR");

    event Paused(address operator);
    event Unpaused(address operator);
    event PoolInitialized(address cashToken, address securitiesToken, uint256 feeBps);
    event LiquidityAdded(address indexed provider, uint256 cashAmount, uint256 securitiesAmount, uint256 sharesMinted);
    event LiquidityRemoved(address indexed provider, uint256 cashAmount, uint256 securitiesAmount, uint256 sharesBurned);
    event SwapExecuted(
        uint256 indexed orderId,
        uint256 indexed matchId,
        address indexed trader,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    modifier whenNotPaused() {
        require(!paused, "AMM: contract is paused");
        _;
    }

    modifier onlyWhitelisted() {
        require(_identity.isWhitelisted(msg.sender), "AMM: caller not whitelisted");
        _;
    }

    modifier onlyOperator() {
        require(
            _identity.isWhitelisted(msg.sender) && _identity.getRole(msg.sender) == OPERATOR,
            "AMM: caller is not an operator"
        );
        _;
    }

    constructor(
        address identityContract,
        address registryContract,
        address settlementContract,
        uint256 feeBps_
    ) {
        require(identityContract != address(0), "AMM: zero identity address");
        require(registryContract != address(0), "AMM: zero registry address");
        require(settlementContract != address(0), "AMM: zero settlement address");
        require(feeBps_ < BPS, "AMM: invalid fee");

        _identity = IAccessControl(identityContract);
        _registry = IRegistry(registryContract);
        _settlement = IDvPTrigger(settlementContract);
        feeBps = feeBps_;
    }

    function initializePool(address cashToken_, address securitiesToken_) external onlyOperator {
        require(!poolInitialized, "AMM: pool already initialized");
        require(cashToken_ != address(0) && securitiesToken_ != address(0), "AMM: zero token address");
        require(cashToken_ != securitiesToken_, "AMM: identical token addresses");

        IRegistry.Asset memory cashAsset = _registry.getAsset(cashToken_);
        IRegistry.Asset memory secAsset = _registry.getAsset(securitiesToken_);

        require(cashAsset.active, "AMM: cash token not registered");
        require(secAsset.active, "AMM: securities token not registered");
        require(cashAsset.assetType == CASH_TOKEN_TYPE, "AMM: invalid cash token type");
        require(secAsset.assetType == SECURITIES_TYPE, "AMM: invalid securities token type");

        cashToken = cashToken_;
        securitiesToken = securitiesToken_;
        poolInitialized = true;

        require(IERC20Like(cashToken).approve(address(_settlement), type(uint256).max), "AMM: cash approval failed");
        require(IERC20Like(securitiesToken).approve(address(_settlement), type(uint256).max), "AMM: securities approval failed");

        emit PoolInitialized(cashToken_, securitiesToken_, feeBps);
    }

    function addLiquidity(uint256 cashAmount, uint256 securitiesAmount)
        external
        whenNotPaused
        onlyWhitelisted
        returns (uint256 sharesMinted)
    {
        _requirePoolReady();
        require(cashAmount > 0 && securitiesAmount > 0, "AMM: amounts must be > 0");

        if (totalLiquidityShares == 0) {
            sharesMinted = _sqrt(cashAmount * securitiesAmount);
            require(sharesMinted > 0, "AMM: insufficient initial liquidity");
        } else {
            require(cashAmount * reserveSecurities == securitiesAmount * reserveCash, "AMM: invalid liquidity ratio");
            uint256 sharesFromCash = (cashAmount * totalLiquidityShares) / reserveCash;
            uint256 sharesFromSecurities = (securitiesAmount * totalLiquidityShares) / reserveSecurities;
            sharesMinted = sharesFromCash < sharesFromSecurities ? sharesFromCash : sharesFromSecurities;
            require(sharesMinted > 0, "AMM: zero shares");
        }

        require(IERC20Like(cashToken).transferFrom(msg.sender, address(this), cashAmount), "AMM: cash transfer failed");
        require(
            IERC20Like(securitiesToken).transferFrom(msg.sender, address(this), securitiesAmount),
            "AMM: securities transfer failed"
        );

        reserveCash += cashAmount;
        reserveSecurities += securitiesAmount;

        liquidityShares[msg.sender] += sharesMinted;
        totalLiquidityShares += sharesMinted;

        emit LiquidityAdded(msg.sender, cashAmount, securitiesAmount, sharesMinted);
    }

    function removeLiquidity(uint256 sharesBurned)
        external
        whenNotPaused
        onlyWhitelisted
        returns (uint256 cashAmount, uint256 securitiesAmount)
    {
        _requirePoolReady();
        require(sharesBurned > 0, "AMM: shares must be > 0");
        require(liquidityShares[msg.sender] >= sharesBurned, "AMM: insufficient shares");

        cashAmount = (sharesBurned * reserveCash) / totalLiquidityShares;
        securitiesAmount = (sharesBurned * reserveSecurities) / totalLiquidityShares;

        liquidityShares[msg.sender] -= sharesBurned;
        totalLiquidityShares -= sharesBurned;

        reserveCash -= cashAmount;
        reserveSecurities -= securitiesAmount;

        require(IERC20Like(cashToken).transfer(msg.sender, cashAmount), "AMM: cash transfer failed");
        require(IERC20Like(securitiesToken).transfer(msg.sender, securitiesAmount), "AMM: securities transfer failed");

        emit LiquidityRemoved(msg.sender, cashAmount, securitiesAmount, sharesBurned);
    }

    function getAmountOut(address tokenIn, uint256 amountIn) public view returns (uint256 amountOut) {
        _requirePoolReady();
        require(amountIn > 0, "AMM: amountIn must be > 0");
        require(tokenIn == cashToken || tokenIn == securitiesToken, "AMM: unsupported tokenIn");

        bool isCashIn = tokenIn == cashToken;
        uint256 reserveIn = isCashIn ? reserveCash : reserveSecurities;
        uint256 reserveOut = isCashIn ? reserveSecurities : reserveCash;

        require(reserveIn > 0 && reserveOut > 0, "AMM: empty reserves");

        uint256 amountInWithFee = amountIn * (BPS - feeBps);
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * BPS + amountInWithFee;
        amountOut = numerator / denominator;
    }

    function submitOrder(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin
    ) external override whenNotPaused onlyWhitelisted returns (uint256 orderId) {
        _requirePoolReady();
        require(_identity.isWhitelisted(address(this)), "AMM: pool not whitelisted");
        require(tokenIn != tokenOut, "AMM: tokenIn and tokenOut must differ");
        require(
            (tokenIn == cashToken && tokenOut == securitiesToken) ||
            (tokenIn == securitiesToken && tokenOut == cashToken),
            "AMM: unsupported pair"
        );
        require(_registry.isActive(tokenIn), "AMM: tokenIn not registered");
        require(_registry.isActive(tokenOut), "AMM: tokenOut not registered");
        require(amountIn > 0 && amountOutMin > 0, "AMM: amounts must be > 0");

        uint256 amountOut = getAmountOut(tokenIn, amountIn);
        require(amountOut > 0, "AMM: zero output");
        require(amountOut >= amountOutMin, "AMM: slippage exceeded");

        bool isCashIn = tokenIn == cashToken;
        if (isCashIn) {
            require(reserveSecurities >= amountOut, "AMM: insufficient securities reserve");
        } else {
            require(reserveCash >= amountOut, "AMM: insufficient cash reserve");
        }

        _orderCounter++;
        orderId = _orderCounter;

        _orders[orderId] = Order({
            orderId: orderId,
            trader: msg.sender,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            amountOut: amountOut,
            timestamp: block.timestamp,
            status: OrderStatus.OPEN
        });

        emit OrderSubmitted(orderId, msg.sender, tokenIn, tokenOut, amountIn, amountOut);

        _matchCounter++;
        uint256 matchId = _matchCounter;

        _orders[orderId].status = OrderStatus.MATCHED;

        if (isCashIn) {
            _matches[matchId] = Match({
                matchId: matchId,
                buyOrderId: orderId,
                sellOrderId: 0,
                buyer: msg.sender,
                seller: address(this),
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                amountIn: amountIn,
                amountOut: amountOut,
                timestamp: block.timestamp
            });

            _settlement.settle(
                msg.sender,
                address(this),
                securitiesToken,
                cashToken,
                amountOut,
                amountIn
            );

            reserveCash += amountIn;
            reserveSecurities -= amountOut;
        } else {
            _matches[matchId] = Match({
                matchId: matchId,
                buyOrderId: 0,
                sellOrderId: orderId,
                buyer: address(this),
                seller: msg.sender,
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                amountIn: amountIn,
                amountOut: amountOut,
                timestamp: block.timestamp
            });

            _settlement.settle(
                address(this),
                msg.sender,
                securitiesToken,
                cashToken,
                amountIn,
                amountOut
            );

            reserveSecurities += amountIn;
            reserveCash -= amountOut;
        }

        emit OrderMatched(matchId, _matches[matchId].buyOrderId, _matches[matchId].sellOrderId);
        emit SwapExecuted(orderId, matchId, msg.sender, tokenIn, tokenOut, amountIn, amountOut);
    }

    function cancelOrder(uint256 orderId) external override whenNotPaused {
        Order storage order = _orders[orderId];
        require(order.trader != address(0), "AMM: order does not exist");
        require(
            order.trader == msg.sender ||
            (_identity.isWhitelisted(msg.sender) && _identity.getRole(msg.sender) == OPERATOR),
            "AMM: not authorized"
        );
        require(order.status == OrderStatus.OPEN, "AMM: order not open");

        order.status = OrderStatus.CANCELLED;
        emit OrderCancelled(orderId, msg.sender);
    }

    function getOrder(uint256 orderId) external view override returns (Order memory) {
        return _orders[orderId];
    }

    function getMatch(uint256 matchId) external view override returns (Match memory) {
        return _matches[matchId];
    }

    function getPendingMatches() external pure override returns (Match[] memory) {
        return new Match[](0);
    }

    function pause() external onlyOperator {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOperator {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function _requirePoolReady() internal view {
        require(poolInitialized, "AMM: pool not initialized");
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y == 0) return 0;

        uint256 x = y / 2 + 1;
        z = y;

        while (x < z) {
            z = x;
            x = (y / x + x) / 2;
        }
    }
}
