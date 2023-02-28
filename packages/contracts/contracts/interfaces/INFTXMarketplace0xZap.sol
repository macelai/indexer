// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

interface INFTXMarketplace0xZap {

    struct BuyOrder {
        uint256 vaultId;
        IERC165 collection;
        uint256[] specificIds;
        uint256 amount;
        uint256 price;
        bytes swapCallData;
    }

    struct SellOrder {
        uint256 vaultId;
        IERC165 collection;
        IERC20 currency;
        uint256[] specificIds;
        // ERC1155
        uint256[] amounts;
        uint256 price;
        bytes swapCallData;
    }

    function mintAndSell721(
        uint256 vaultId,
        uint256[] calldata ids,
        bytes calldata swapCallData,
        address payable to
    ) external;

    function mintAndSell1155(
        uint256 vaultId,
        uint256[] calldata ids,
        uint256[] calldata amounts,
        bytes calldata swapCallData,
        address payable to
    ) external;

    function buyAndRedeem(
        uint256 vaultId,
        uint256 amount,
        uint256[] calldata specificIds, 
        bytes calldata swapCallData,
        address payable to
    ) external payable;
}
