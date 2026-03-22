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
    uint256[] private _pendingMatchIds;

    IAccessControl private _identity;
    IRegistry private _registry;
    IDvPTrigger private _settlement;

    // --- Roles ---
    bytes32 public constant OPERATOR = keccak256("OPERATOR");

    // --- Modifiers ---
    modifier onlyWhitelisted() {
        require(_identity.isWhitelisted(msg.sender), "OrderBook: caller not whitelisted");
        _;
    }

    modifier onlyOperator() {
        require(
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
    ) external override onlyWhitelisted returns (uint256 orderId) {
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

        emit OrderSubmitted(orderId, msg.sender, tokenIn, tokenOut, amountIn, amountOut);

        // Attempt to match after submission
        _tryMatch(orderId);

        return orderId;
    }

    function cancelOrder(uint256 orderId) external override {
        Order storage order = _orders[orderId];
        require(order.trader == msg.sender || _identity.getRole(msg.sender) == OPERATOR, "OrderBook: not authorized");
        require(order.status == OrderStatus.OPEN, "OrderBook: order not open");
        order.status = OrderStatus.CANCELLED;
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

    // --- Internal Matching Logic ---

    function _tryMatch(uint256 newOrderId) internal {
        Order storage newOrder = _orders[newOrderId];

        // Look for a compatible open order
        for (uint256 i = 1; i <= _orderCounter; i++) {
            if (i == newOrderId) continue;

            Order storage candidate = _orders[i];

            if (candidate.status != OrderStatus.OPEN) continue;

            // Check if orders are compatible:
            // newOrder wants to sell tokenIn for tokenOut
            // candidate wants to sell tokenOut for tokenIn
            // Price-time priority: accept if prices cross
            if (
                candidate.tokenIn == newOrder.tokenOut &&
                candidate.tokenOut == newOrder.tokenIn &&
                _pricesCross(newOrder, candidate)
            ) {
                _executeMatch(newOrderId, i);
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

        order1.status = OrderStatus.MATCHED;
        order2.status = OrderStatus.MATCHED;

        _matchCounter++;
        uint256 matchId = _matchCounter;

        _matches[matchId] = Match({
            matchId: matchId,
            buyOrderId: orderId1,
            sellOrderId: orderId2,
            buyer: order1.trader,
            seller: order2.trader,
            tokenIn: order1.tokenIn,
            tokenOut: order1.tokenOut,
            amountIn: order1.amountIn,
            amountOut: order1.amountOut,
            timestamp: block.timestamp
        });

        emit OrderMatched(matchId, orderId1, orderId2);

        // Trigger DvP settlement
       _settlement.settle(
            order1.trader,   // buyer
            order2.trader,   // seller
            order1.tokenOut, // securitiesToken (what buyer wants)
            order1.tokenIn,  // cashToken (what buyer is giving)
            order1.amountOut, // securitiesAmount
            order1.amountIn   // cashAmount
        );
    }
}