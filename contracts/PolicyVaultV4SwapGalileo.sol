// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IProofRegistry} from "./interfaces/IProofRegistry.sol";
import {IPolicyVaultAdapter} from "./interfaces/IPolicyVaultAdapter.sol";
import {IGalileoSandboxQuote} from "./interfaces/IGalileoSandboxQuote.sol";
import {Ownable} from "./utils/Ownable.sol";
import {ReentrancyGuard} from "./utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "./utils/SafeTransferLib.sol";

/// @notice Chain-pinned swap vault for the Galileo sandbox; deliberately separate from mainnet V4.
contract PolicyVaultV4SwapGalileo is Ownable, ReentrancyGuard {
    address public constant NATIVE_TOKEN = address(0);
    uint256 public constant GALILEO_CHAIN_ID = 16602;
    uint16 public constant BPS = 10_000;
    struct Policy { uint256 perTradeCap0G; uint256 dailyCap0G; uint256 maxExposure0G; uint256 cooldownSeconds; uint256 maxDeadlineWindowSeconds; uint16 defaultMinOutBps; }
    struct TradeRequest { address tokenIn; address tokenOut; uint256 amountIn; uint256 quotedAmountOut; uint256 amountOutMin; uint256 deadline; uint256 nonce; bytes32 agentKey; bytes32 poolId; bytes32 vaultActionHash; bytes32 actionHash; bytes32 policySnapshotHash; bytes32 auditRoot; }
    // These values are constructor-initialized and never mutated. They are
    // storage (rather than immutables) so every per-user Galileo vault has the
    // same runtime codehash for registry implementation attestation.
    address public executor;
    IPolicyVaultAdapter public swapAdapter;
    IProofRegistry public proofRegistry;
    address public vaultRegistry;
    bool public mockAdapterAllowed;
    Policy public policy;
    bool public paused; bool public executorRevoked;
    mapping(address => bool) public allowedTokens; mapping(bytes32 => bool) public allowedPools; mapping(bytes32 => bool) public agentKeyEnabled;
    mapping(bytes32 => mapping(address => uint256)) public agentPositionUnits; mapping(address => uint256) public positionUnits; mapping(bytes32 => bool) public usedActionHashes;
    uint256 public dailySpent0G; uint256 public dailyWindowStart; uint256 public lastTradeAt; uint256 public openExposure0G;
    error WrongChain(); error NotExecutor(); error NotAllowed(); error InvalidAmount(); error InvalidPair(); error InvalidProof(); error InvalidAgentKey(); error LowMinOut(); error BadDelta(); error Paused(); error Revoked(); error Deadline(); error Cap(); error Cooldown(); error Replay(); error InvalidPolicy();
    event Deposited(address indexed owner,uint256 amount); event NativeWithdrawn(address indexed owner,uint256 amount); event AgentKeyEnabledSet(bytes32 indexed key,bool enabled); event PausedSet(bool value); event ExecutorRevoked(address indexed executor); event TradeExecuted(bytes32 indexed actionHash,bytes32 indexed agentKey,bool indexed isBuy,address token,uint256 amountIn,uint256 amountOut,bytes32 auditRoot);
    modifier onlyExecutor(){ if(msg.sender!=executor) revert NotExecutor(); _; }
    modifier active(){ if(paused) revert Paused(); if(executorRevoked) revert Revoked(); _; }
    constructor(address initialOwner,address executor_,address adapter_,address proofRegistry_,Policy memory initialPolicy,address token,bytes32 poolId,address registry_) Ownable(initialOwner) {
        if(block.chainid!=GALILEO_CHAIN_ID) revert WrongChain();
        if(initialOwner!=msg.sender || executor_==address(0)||adapter_==address(0)||proofRegistry_==address(0)||token==address(0)||poolId==bytes32(0)||registry_==address(0)||adapter_.code.length==0||proofRegistry_.code.length==0||registry_.code.length==0) revert NotAllowed();
        if(initialPolicy.maxDeadlineWindowSeconds==0||initialPolicy.maxDeadlineWindowSeconds>1 days||initialPolicy.defaultMinOutBps==0||initialPolicy.defaultMinOutBps>BPS) revert InvalidPolicy();
        executor=executor_; swapAdapter=IPolicyVaultAdapter(adapter_); proofRegistry=IProofRegistry(proofRegistry_); vaultRegistry=registry_; policy=initialPolicy;
        if(IPolicyVaultAdapter(adapter_).adapterKind()==keccak256("4LPHA_0G_MOCK_ADAPTER")) revert NotAllowed();
        mockAdapterAllowed=false; allowedTokens[token]=true; allowedPools[poolId]=true;
    }
    receive() external payable { if(msg.sender!=owner()&&msg.sender!=address(swapAdapter)) revert NotAllowed(); emit Deposited(msg.sender,msg.value); }
    function depositNative() external payable onlyOwner { if(msg.value==0) revert InvalidAmount(); emit Deposited(msg.sender,msg.value); }
    function withdrawNative(uint256 amount) external onlyOwner nonReentrant { if(amount==0||amount>address(this).balance) revert InvalidAmount(); SafeTransferLib.safeTransferNative(owner(),amount); emit NativeWithdrawn(owner(),amount); }
    function rescueToken(address token,uint256 amount) external onlyOwner nonReentrant { if(token==address(0)||amount==0) revert InvalidAmount(); SafeTransferLib.safeTransfer(IERC20(token),owner(),amount); }
    function setPaused(bool value) external onlyOwner { paused=value; emit PausedSet(value); }
    function revokeExecutor() external onlyOwner { executorRevoked=true; emit ExecutorRevoked(executor); }
    function setAgentKeyEnabled(bytes32 key,bool enabled) external onlyOwner { if(key==bytes32(0)) revert InvalidAgentKey(); agentKeyEnabled[key]=enabled; emit AgentKeyEnabledSet(key,enabled); }
    function disableToken(address token) external onlyOwner { allowedTokens[token]=false; }
    function disablePool(bytes32 poolId) external onlyOwner { allowedPools[poolId]=false; }
    function tightenPolicy(Policy calldata next) external onlyOwner { Policy memory old=policy; if(next.perTradeCap0G>old.perTradeCap0G||next.dailyCap0G>old.dailyCap0G||next.maxExposure0G>old.maxExposure0G||next.cooldownSeconds<old.cooldownSeconds||next.maxDeadlineWindowSeconds>old.maxDeadlineWindowSeconds||next.defaultMinOutBps<old.defaultMinOutBps||next.defaultMinOutBps==0) revert InvalidPolicy(); policy=next; }
    function minOutFor(address,address,uint256 quoted) public view returns(uint256){ return quoted*policy.defaultMinOutBps/BPS; }
    function policyHash() public view returns(bytes32){ Policy memory p=policy; return keccak256(abi.encode(p.perTradeCap0G,p.dailyCap0G,p.maxExposure0G,p.cooldownSeconds,p.maxDeadlineWindowSeconds,p.defaultMinOutBps)); }
    function actionHashFor(bytes32 vaultActionHash,bytes32 auditRoot,bytes32 policySnapshotHash) public pure returns(bytes32){ return keccak256(abi.encode("4LPHA_0G_POLICY_VAULT_PROOF",vaultActionHash,auditRoot,policySnapshotHash)); }
    function vaultActionHashFor(bool isBuy,TradeRequest calldata r) public view returns(bytes32){ return keccak256(abi.encode("4LPHA_GALILEO_POLICY_VAULT_ACTION",block.chainid,address(this),owner(),executor,address(swapAdapter),address(proofRegistry),isBuy,r.tokenIn,r.tokenOut,r.amountIn,r.quotedAmountOut,r.amountOutMin,r.deadline,r.nonce,r.agentKey,r.poolId,r.policySnapshotHash,r.auditRoot)); }
    function buy(TradeRequest calldata r) external onlyExecutor active nonReentrant returns(uint256 out){ _preflight(r,true); if(address(this).balance<r.amountIn) revert InvalidAmount(); _buyCap(r.amountIn); uint256 tokenBefore=IERC20(r.tokenOut).balanceOf(address(this)); uint256 nativeBefore=address(this).balance; usedActionHashes[r.actionHash]=true; out=swapAdapter.swapExactIn{value:r.amountIn}(r.tokenIn,r.tokenOut,r.amountIn,r.amountOutMin,r.poolId); uint256 delta=IERC20(r.tokenOut).balanceOf(address(this))-tokenBefore; if(nativeBefore-address(this).balance!=r.amountIn||delta<r.amountOutMin||delta<out) revert BadDelta(); positionUnits[r.tokenOut]+=delta; agentPositionUnits[r.agentKey][r.tokenOut]+=delta; _spend(r.amountIn); _finish(r,true,r.tokenOut,delta); }
    function sell(TradeRequest calldata r) external onlyExecutor active nonReentrant returns(uint256 out){ _preflight(r,false); uint256 held=agentPositionUnits[r.agentKey][r.tokenIn]; if(held<r.amountIn||positionUnits[r.tokenIn]<r.amountIn) revert InvalidAmount(); uint256 tokenBefore=IERC20(r.tokenIn).balanceOf(address(this)); uint256 nativeBefore=address(this).balance; usedActionHashes[r.actionHash]=true; SafeTransferLib.forceApprove(IERC20(r.tokenIn),address(swapAdapter),r.amountIn); out=swapAdapter.swapExactIn(r.tokenIn,r.tokenOut,r.amountIn,r.amountOutMin,r.poolId); SafeTransferLib.forceApprove(IERC20(r.tokenIn),address(swapAdapter),0); uint256 delta=address(this).balance-nativeBefore; if(tokenBefore-IERC20(r.tokenIn).balanceOf(address(this))!=r.amountIn||delta<r.amountOutMin||delta<out) revert BadDelta(); positionUnits[r.tokenIn]-=r.amountIn; agentPositionUnits[r.agentKey][r.tokenIn]=held-r.amountIn; openExposure0G=delta>=openExposure0G?0:openExposure0G-delta; _finish(r,false,r.tokenIn,delta); }
    function _preflight(TradeRequest calldata r,bool isBuy) private view { if(r.agentKey==bytes32(0)||!agentKeyEnabled[r.agentKey]) revert InvalidAgentKey(); if(r.amountIn==0||r.amountOutMin==0||r.deadline<block.timestamp||r.deadline>block.timestamp+policy.maxDeadlineWindowSeconds) revert Deadline(); if(usedActionHashes[r.actionHash]) revert Replay(); if(isBuy ? (r.tokenIn!=NATIVE_TOKEN||!allowedTokens[r.tokenOut]) : (r.tokenOut!=NATIVE_TOKEN||!allowedTokens[r.tokenIn])) revert InvalidPair(); if(!allowedPools[r.poolId]) revert NotAllowed(); uint256 trusted=IGalileoSandboxQuote(address(swapAdapter)).quoteExactIn(r.tokenIn,r.amountIn); if(trusted!=r.quotedAmountOut||r.amountOutMin<minOutFor(r.tokenIn,r.tokenOut,trusted)) revert LowMinOut(); if(r.policySnapshotHash!=policyHash()||r.vaultActionHash!=vaultActionHashFor(isBuy,r)||r.actionHash!=actionHashFor(r.vaultActionHash,r.auditRoot,r.policySnapshotHash)||!proofRegistry.isAccepted(r.actionHash,r.auditRoot,r.policySnapshotHash,r.vaultActionHash)) revert InvalidProof(); if(lastTradeAt!=0&&policy.cooldownSeconds!=0&&block.timestamp<lastTradeAt+policy.cooldownSeconds) revert Cooldown(); }
    function _buyCap(uint256 amount) private view { if(amount>policy.perTradeCap0G||openExposure0G+amount>policy.maxExposure0G) revert Cap(); uint256 spent=dailyWindowStart==0||block.timestamp>=dailyWindowStart+1 days?0:dailySpent0G; if(spent+amount>policy.dailyCap0G) revert Cap(); }
    function _spend(uint256 amount) private { if(dailyWindowStart==0||block.timestamp>=dailyWindowStart+1 days){dailyWindowStart=block.timestamp;dailySpent0G=amount;}else dailySpent0G+=amount; openExposure0G+=amount; }
    function _finish(TradeRequest calldata r,bool isBuy,address token,uint256 amountOut) private { lastTradeAt=block.timestamp; emit TradeExecuted(r.actionHash,r.agentKey,isBuy,token,r.amountIn,amountOut,r.auditRoot); }
}
