// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ITokenReceiver} from "./HookToken.sol";

// TEST ONLY contracts used by test/attacks. None of them is deployed by scripts/deploy.js.

interface IAttackCircle {
    function join() external;
    function contribute() external;
    function claimPayout() external;
    function settleRound() external;
    function finalizeDraw() external;
    function cancel() external;
    function joinCollateral() external view returns (uint256);
    function positionOf(address account) external view returns (uint256);
}

interface IAttackOrder {
    function commit(address circle, bytes32 commitment) external;
    function reveal(address circle, bytes32 secret) external;
    function computeCommitment(bytes32 secret, address member, address circle) external pure returns (bytes32);
}

interface IHookRegistry {
    function registerHook() external;
}

/// @notice Base for a smart contract that takes part in a circle as a member.
abstract contract ContractMember {
    IERC20 public immutable token;
    address public immutable vault;
    IAttackOrder public immutable payoutOrder;
    IAttackCircle public circle;

    constructor(IERC20 token_, address vault_, IAttackOrder payoutOrder_) {
        token = token_;
        vault = vault_;
        payoutOrder = payoutOrder_;
    }

    function setCircle(IAttackCircle circle_) external {
        circle = circle_;
    }

    function join() external {
        token.approve(vault, circle.joinCollateral());
        circle.join();
        token.approve(address(circle), type(uint256).max);
    }

    function commit(bytes32 secret) external {
        payoutOrder.commit(address(circle), payoutOrder.computeCommitment(secret, address(this), address(circle)));
    }

    function reveal(bytes32 secret) external {
        payoutOrder.reveal(address(circle), secret);
    }

    function contribute() external {
        circle.contribute();
    }

    function claim() external {
        circle.claimPayout();
    }
}

/// @title ReentrantMember
/// @notice A member that tries to re enter the circle whenever it receives tokens.
contract ReentrantMember is ContractMember, ITokenReceiver {
    enum Attack {
        None,
        ClaimAgain,
        Settle,
        Finalize,
        Cancel
    }

    Attack public attack;
    /// true: let a failed re entry revert the whole transaction; false: swallow it and record it
    bool public bubble;
    uint256 public attempts;
    uint256 public blocked;
    bytes public lastError;

    constructor(IERC20 token_, address vault_, IAttackOrder payoutOrder_) ContractMember(token_, vault_, payoutOrder_) {}

    function enableHook() external {
        IHookRegistry(address(token)).registerHook();
    }

    function setAttack(Attack attack_, bool bubble_) external {
        attack = attack_;
        bubble = bubble_;
    }

    function onTokenReceived(address, uint256) external override {
        if (msg.sender != address(token) || attack == Attack.None) return;
        attempts++;
        bytes memory data;
        if (attack == Attack.ClaimAgain) data = abi.encodeCall(IAttackCircle.claimPayout, ());
        else if (attack == Attack.Settle) data = abi.encodeCall(IAttackCircle.settleRound, ());
        else if (attack == Attack.Finalize) data = abi.encodeCall(IAttackCircle.finalizeDraw, ());
        else data = abi.encodeCall(IAttackCircle.cancel, ());

        (bool ok, bytes memory ret) = address(circle).call(data);
        if (!ok) {
            if (bubble) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            blocked++;
            lastError = ret;
        }
    }
}

/// @title DrawRigger
/// @notice A member that tries to choose its payout slot instead of accepting the draw.
contract DrawRigger is ContractMember {
    constructor(IERC20 token_, address vault_, IAttackOrder payoutOrder_) ContractMember(token_, vault_, payoutOrder_) {}

    /// Attack 1: reveal and finalize in ONE transaction, then undo everything (including the
    /// reveal) unless the resulting slot is the one wanted. Retried every block, this would let
    /// the last revealer pick its slot.
    function revealFinalizeOrUndo(bytes32 secret, uint256 wantedPosition) external {
        payoutOrder.reveal(address(circle), secret);
        circle.finalizeDraw();
        require(circle.positionOf(address(this)) == wantedPosition, "DrawRigger: unlucky, undo");
    }

    /// Attack 2: after revealing, finalize and undo unless the slot is the one wanted, retried
    /// every block ("grinding" the block in which the draw is finalized).
    function finalizeOrUndo(uint256 wantedPosition) external {
        circle.finalizeDraw();
        require(circle.positionOf(address(this)) == wantedPosition, "DrawRigger: unlucky, undo");
    }
}

interface IAttackVault {
    function slash(address member, uint256 amount) external returns (uint256);
    function release(address member, uint256 amount) external returns (uint256);
    function deposit(address from, address member, uint256 amount) external;
}

interface IAttackReputation {
    function recordDefault(address member) external;
}

interface IAttackDraw {
    function startDraw(address[] calldata members, uint256 phaseDuration) external;
    function finalize() external returns (address[] memory);
}

/// @title FakeCircle
/// @notice A contract an attacker deploys outside the factory, pretending to be a circle.
contract FakeCircle {
    function stealCollateral(IAttackVault vault, address victim, uint256 amount) external returns (uint256) {
        return vault.slash(victim, amount);
    }

    function releaseTo(IAttackVault vault, address victim, uint256 amount) external returns (uint256) {
        return vault.release(victim, amount);
    }

    function pullDeposit(IAttackVault vault, address victim, uint256 amount) external {
        vault.deposit(victim, victim, amount);
    }

    function frame(IAttackReputation reputation, address victim) external {
        reputation.recordDefault(victim);
    }

    function hijackDraw(IAttackDraw draw, address[] calldata members) external {
        draw.startDraw(members, 1);
    }
}
