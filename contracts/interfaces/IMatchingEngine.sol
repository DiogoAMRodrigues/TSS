// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IMatchingEngine
 * @notice Generic interface for any trading/matching module
 * @dev Any trading mechanism (order book, AMM, bilateral, auction) must implement
 * this interface to plug into the compliant settlement infrastructure.
 * The settlement layer only interacts with this interface - it doesn't care
 * what matching mechanism is behind it.
 */
interface IMatchingEngine {

    // --- Structs ---
    struct Order {
        uint256 orderId;
        address trader;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 amountOut;
        uint256 timestamp;
        OrderStatus status;
    }

    struct Match {
        uint256 matchId;
        uint256 buyOrderId;
        uint256 sellOrderId;
        address buyer;
        address seller;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 amountOut;
        uint256 timestamp;
    }

    // --- Enums ---
    enum OrderStatus { OPEN, MATCHED, CANCELLED, EXPIRED }

    // --- Events ---
    event OrderSubmitted(uint256 indexed orderId, address indexed trader, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);
    event OrderMatched(uint256 indexed matchId, uint256 indexed buyOrderId, uint256 indexed sellOrderId);
    event OrderCancelled(uint256 indexed orderId, address indexed trader);
    event OrderExpired(uint256 indexed orderId);

    // --- Functions ---

    function submitOrder(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    ) external returns (uint256 orderId);

    function cancelOrder(uint256 orderId) external;

    function getOrder(uint256 orderId) external view returns (Order memory);

    function getMatch(uint256 matchId) external view returns (Match memory);

    function getPendingMatches() external view returns (Match[] memory);
}