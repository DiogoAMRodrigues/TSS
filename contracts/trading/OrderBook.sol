// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IMatchingEngine.sol";
import "../interfaces/IAccessControl.sol";
import "../interfaces/IRegistry.sol";
import "../interfaces/IDvPTrigger.sol";

/**
 * @title OrderBook
 * @notice On-chain order book implementation of IMatchingEngine
 * @dev One concrete implementation of the generic IMatchingEngine interface.
 * Uses price-time priority matching. Any other matching mechanism (AMM, etc)
 * could replace this by implementing IMatchingEngine.
 * Only whitelisted users can submit orders.
 * Only registered and active assets can be traded.
 */
contract OrderBook is IMatchingEngine {

    // --- State ---
    uint256 private _orderCounter;
    uint256 private _matchCounter;

    mapping(uint256 => Order) private _orders;
    mapping(uint256 => Match) private _matches;

    // Open order ID tracking for O(1) match scanning
    uint256[] private _openOrderIds;
    mapping(uint256 => uint256) private _openOrderIndex;

    uint256[] private _pendingMatchIds;

    IAccessControl private _identity;
    IRegistry private _registry;
    IDvPTrigger private _settlement;

    bool public paused;

    // --- Roles ---
    bytes32 public constant OPERATOR = keccak256("OPERATOR");
    bytes32 private constant CASH_TOKEN_TYPE = bytes32("CASH_TOKEN");
    bytes32 private constant SECURITIES_TYPE = bytes32("SECURITIES");

    // --- Events ---
    event Paused(address operator);
    event Unpaused(address operator);

    // --- Modifiers ---
    modifier whenNotPaused() {
        require(!paused, "OrderBook: contract is paused");
        _;
    }

    modifier onlyWhitelisted() {
        require(_identity.isWhitelisted(msg.sender), "OrderBook: caller not whitelisted");
        _;
    }

    modifier onlyOperator() {
        require(
            _identity.isWhitelisted(msg.sender) &&
            _identity.getRole(msg.sender) == OPERATOR,
            "OrderBook: caller is not an operator"
        );
        _;
    }

    // --- Constructor ---
    constructor(
        address identityContract,
        address registryContract,
        address settlementContract
    ) {
        require(identityContract != address(0), "OrderBook: zero identity address");
        require(registryContract != address(0), "OrderBook: zero registry address");
        require(settlementContract != address(0), "OrderBook: zero settlement address");
        _identity = IAccessControl(identityContract);
        _registry = IRegistry(registryContract);
        _settlement = IDvPTrigger(settlementContract);
    }

    // --- IMatchingEngine Implementation ---

    function submitOrder(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    ) external override whenNotPaused onlyWhitelisted returns (uint256 orderId) {
        require(tokenIn != tokenOut, "OrderBook: tokenIn and tokenOut must differ");
        require(_registry.isActive(tokenIn), "OrderBook: tokenIn not registered");
        require(_registry.isActive(tokenOut), "OrderBook: tokenOut not registered");
        require(amountIn > 0 && amountOut > 0, "OrderBook: amounts must be > 0");

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

        // Track as open for efficient matching
        _openOrderIndex[orderId] = _openOrderIds.length;
        _openOrderIds.push(orderId);

        emit OrderSubmitted(orderId, msg.sender, tokenIn, tokenOut, amountIn, amountOut);

        // Attempt to match after submission
        _tryMatch(orderId);

        return orderId;
    }

    function cancelOrder(uint256 orderId) external override whenNotPaused {
        Order storage order = _orders[orderId];
        require(order.trader != address(0), "OrderBook: order does not exist");
        require(
            order.trader == msg.sender ||
            (_identity.isWhitelisted(msg.sender) && _identity.getRole(msg.sender) == OPERATOR),
            "OrderBook: not authorized"
        );
        require(order.status == OrderStatus.OPEN, "OrderBook: order not open");
        order.status = OrderStatus.CANCELLED;
        _removeFromOpenOrders(orderId);
        emit OrderCancelled(orderId, msg.sender);
    }

    function getOrder(uint256 orderId) external view override returns (Order memory) {
        return _orders[orderId];
    }

    function getMatch(uint256 matchId) external view override returns (Match memory) {
        return _matches[matchId];
    }

    function getPendingMatches() external view override returns (Match[] memory) {
        Match[] memory pending = new Match[](_pendingMatchIds.length);
        for (uint256 i = 0; i < _pendingMatchIds.length; i++) {
            pending[i] = _matches[_pendingMatchIds[i]];
        }
        return pending;
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

    // --- Internal Matching Logic ---

    function _tryMatch(uint256 newOrderId) internal {
        Order storage newOrder = _orders[newOrderId];

        // Iterate only over open orders — O(open) not O(all)
        for (uint256 i = 0; i < _openOrderIds.length; i++) {
            uint256 candidateId = _openOrderIds[i];

            if (candidateId == newOrderId) continue;

            Order storage candidate = _orders[candidateId];

            // Prevent self-trading.
            if (candidate.trader == newOrder.trader) continue;

            // Re-check whitelisting for both parties at match time
            if (!_identity.isWhitelisted(newOrder.trader)) return;
            if (!_identity.isWhitelisted(candidate.trader)) continue;

            if (
                candidate.tokenIn == newOrder.tokenOut &&
                candidate.tokenOut == newOrder.tokenIn &&
                _pricesCross(newOrder, candidate)
            ) {
                _executeMatch(newOrderId, candidateId);
                return;
            }
        }
    }

    function _pricesCross(Order storage buyOrder, Order storage sellOrder) internal view returns (bool) {
        // Buy price: buyOrder.amountIn / buyOrder.amountOut (how much tokenOut per tokenIn)
        // Sell price: sellOrder.amountOut / sellOrder.amountIn
        // Prices cross if buy price >= sell price
        return buyOrder.amountIn * sellOrder.amountIn >= buyOrder.amountOut * sellOrder.amountOut;
    }

    function _executeMatch(uint256 orderId1, uint256 orderId2) internal {
        Order storage order1 = _orders[orderId1];
        Order storage order2 = _orders[orderId2];

        Order storage buyOrder = order1;
        Order storage sellOrder = order2;

        IRegistry.Asset memory a1In = _registry.getAsset(order1.tokenIn);
        IRegistry.Asset memory a1Out = _registry.getAsset(order1.tokenOut);
        IRegistry.Asset memory a2In = _registry.getAsset(order2.tokenIn);
        IRegistry.Asset memory a2Out = _registry.getAsset(order2.tokenOut);

        bool order1LooksLikeBuy =
            a1In.assetType == CASH_TOKEN_TYPE &&
            a1Out.assetType == SECURITIES_TYPE;
        bool order2LooksLikeBuy =
            a2In.assetType == CASH_TOKEN_TYPE &&
            a2Out.assetType == SECURITIES_TYPE;

        if (order2LooksLikeBuy && !order1LooksLikeBuy) {
            buyOrder = order2;
            sellOrder = order1;
        }

        order1.status = OrderStatus.MATCHED;
        order2.status = OrderStatus.MATCHED;

        _removeFromOpenOrders(orderId1);
        _removeFromOpenOrders(orderId2);

        _matchCounter++;
        uint256 matchId = _matchCounter;

        // TODO: price improvement — currently uses aggressor (order1) amounts
        // unconditionally. Decide whose price wins when orders cross:
        // option A) resting order price (order2.amountIn / order2.amountOut)
        // option B) aggressor price (order1 amounts, current behaviour)
        // option C) midpoint price
        // Update securitiesAmount and cashAmount accordingly once decided.
        uint256 securitiesAmount = buyOrder.amountOut;
        uint256 cashAmount       = buyOrder.amountIn;

        _matches[matchId] = Match({
            matchId: matchId,
            buyOrderId: buyOrder.orderId,
            sellOrderId: sellOrder.orderId,
            buyer: buyOrder.trader,
            seller: sellOrder.trader,
            tokenIn: buyOrder.tokenIn,
            tokenOut: buyOrder.tokenOut,
            amountIn: buyOrder.amountIn,
            amountOut: buyOrder.amountOut,
            timestamp: block.timestamp
        });

        emit OrderMatched(matchId, buyOrder.orderId, sellOrder.orderId);

        // Trigger DvP settlement
        _settlement.settle(
            buyOrder.trader,    // buyer
            sellOrder.trader,   // seller
            buyOrder.tokenOut,  // securitiesToken (what buyer wants)
            buyOrder.tokenIn,   // cashToken (what buyer is giving)
            securitiesAmount,
            cashAmount
        );
    }

    // --- Internal Helpers ---

    function _removeFromOpenOrders(uint256 orderId) internal {
        uint256 idx = _openOrderIndex[orderId];
        uint256 lastId = _openOrderIds[_openOrderIds.length - 1];

        _openOrderIds[idx] = lastId;
        _openOrderIndex[lastId] = idx;

        _openOrderIds.pop();
        delete _openOrderIndex[orderId];
    }
}