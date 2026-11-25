// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Circle} from "../core/Circle.sol";
import {ICollateralVault, IPayoutOrder, IReputationRegistry} from "../interfaces/IRoscaModules.sol";

/// @title CircleFactory
/// @notice Creates circles and registers each one with the shared modules, so a circle
///         can only touch the vault, draw and reputation records once the factory vouches for it.
/// @dev Gas optimization G1 (Member C): every circle is an EIP 1167 minimal proxy clone
///      (45 bytes of code) that delegates to ONE Circle implementation deployed by this
///      factory's constructor, instead of a full ~16 KB Circle per `createCircle`.
///      Clones never run a constructor, which is why Circle is set up by `initialize`.
///      The implementation's `factory` immutable is this factory, so only this factory can
///      initialize a clone, and it does so in the same transaction that creates it.
///      Nobody can initialize the implementation itself (only this factory could, and it
///      never does); it holds no funds either way.
contract CircleFactory {
    IERC20 public immutable token;
    ICollateralVault public immutable vault;
    IPayoutOrder public immutable payoutOrder;
    IReputationRegistry public immutable reputation;
    address public immutable admin; // platform pauser for every circle
    /// The single Circle implementation every clone delegates to.
    address public immutable implementation;

    address[] private circles;
    mapping(address => bool) public isCircle;
    mapping(address => address[]) private circlesByOrganizer;

    event CircleCreated(
        address indexed circle, address indexed organizer, uint256 contribution, uint256 groupSize, string termsCid
    );

    constructor(
        IERC20 token_,
        ICollateralVault vault_,
        IPayoutOrder payoutOrder_,
        IReputationRegistry reputation_,
        address admin_
    ) {
        require(
            address(token_) != address(0) && address(vault_) != address(0) && address(payoutOrder_) != address(0)
                && address(reputation_) != address(0) && admin_ != address(0),
            "Factory: zero address"
        );
        token = token_;
        vault = vault_;
        payoutOrder = payoutOrder_;
        reputation = reputation_;
        admin = admin_;
        implementation = address(new Circle(token_, vault_, payoutOrder_, reputation_));
    }

    /// @notice W1: the caller becomes the organizer of a new circle.
    function createCircle(Circle.Config calldata cfg) external returns (address circle) {
        Circle c = Circle(Clones.clone(implementation));
        c.initialize(
            cfg,
            Circle.Modules({token: token, vault: vault, payoutOrder: payoutOrder, reputation: reputation}),
            msg.sender,
            admin
        );
        circle = address(c);

        vault.registerCircle(circle);
        payoutOrder.registerCircle(circle);
        reputation.registerCircle(circle);

        circles.push(circle);
        isCircle[circle] = true;
        circlesByOrganizer[msg.sender].push(circle);

        emit CircleCreated(circle, msg.sender, cfg.contribution, cfg.groupSize, cfg.termsCid);
    }

    function getCircles() external view returns (address[] memory) {
        return circles;
    }

    function circleCount() external view returns (uint256) {
        return circles.length;
    }

    function getCirclesByOrganizer(address organizer) external view returns (address[] memory) {
        return circlesByOrganizer[organizer];
    }
}
