// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgentId} from "./IAgentId.sol";
import {SafeToken} from "./SafeToken.sol";

/// @title AgentPay — pay any registered agent by its .ai name
/// @notice Invoices ("requests"), tips and on-chain receipts for the agent
///         economy. Fully non-custodial: this contract never holds funds —
///         every payment is forwarded to the payee inside the same
///         transaction, and if the forward fails the whole transaction
///         reverts. There is no owner and there are no admin functions.
///
///         Identity comes from the Binance Agent ID registry: only Agent ID
///         holders can pay, and payees opt in by registering the handle they
///         hold. Handles (bare labels such as "renx") are the addressing
///         system; the ".ai" suffix is display-only.
contract AgentPay {
    /// @notice The Agent ID registry. Immutable after deployment.
    IAgentId public immutable agentId;

    struct Profile {
        string handle; // bare label, e.g. "renx"
        uint64 joinedAt;
        uint256 receivedCount; // payments + tips received
        uint256 receivedVolumeBNB; // BNB-denominated volume received
        bool registered;
    }

    struct Request {
        address creator;
        string creatorHandle;
        address token; // address(0) = BNB
        uint256 amount;
        string memo;
        uint64 expiry; // 0 = never expires
        bool reusable; // "open tab": may be paid many times
        bool paid; // one-shot requests flip to true after payment
        uint256 paymentCount;
    }

    struct Receipt {
        address payer;
        string payerHandle;
        address payee;
        string payeeHandle;
        address token; // address(0) = BNB
        uint256 amount;
        string memo;
        uint256 requestId; // 0 = tip
        uint64 timestamp;
    }

    mapping(address => Profile) private _profiles;
    mapping(uint256 => Request) private _requests;
    mapping(address => uint256) public sentCount; // payments + tips sent

    Receipt[] public receipts;
    uint256 public nextRequestId = 1;

    // --- events -------------------------------------------------------------
    event ProfileRegistered(address indexed account, string handle);
    event RequestCreated(
        uint256 indexed id,
        address indexed creator,
        string creatorHandle,
        address token,
        uint256 amount,
        string memo,
        uint64 expiry,
        bool reusable
    );
    event PaymentRecorded(
        uint256 indexed receiptIndex,
        uint256 indexed requestId, // 0 = tip
        address payer,
        string payerHandle,
        address payee,
        string payeeHandle,
        address token,
        uint256 amount,
        string memo
    );

    // --- errors -------------------------------------------------------------
    error NotAgentHolder();
    error NoHandle();
    error AlreadyRegistered();
    error NotRegistered();
    error ZeroAmount();
    error BadExpiry();
    error RequestNotFound();
    error RequestAlreadyPaid();
    error RequestExpired();
    error WrongValue();
    error TipTargetNotRegistered();
    error ForwardFailed();
    error Reentrant();

    uint256 private _locked;

    modifier nonReentrant() {
        if (_locked != 0) revert Reentrant();
        _locked = 1;
        _;
        _locked = 0;
    }

    constructor(address agentIdRegistry) {
        agentId = IAgentId(agentIdRegistry);
    }

    // --- profiles -----------------------------------------------------------

    /// @notice Register your own Agent ID handle as a payee profile.
    ///         The handle is read from the registry — you can only ever
    ///         register the handle you actually hold.
    function registerProfile() external {
        if (agentId.balanceOf(msg.sender) == 0) revert NotAgentHolder();
        string memory handle = agentId.handleOf(msg.sender);
        if (bytes(handle).length == 0) revert NoHandle();
        Profile storage p = _profiles[msg.sender];
        if (p.registered) revert AlreadyRegistered();

        p.handle = handle;
        p.joinedAt = uint64(block.timestamp);
        p.registered = true;

        emit ProfileRegistered(msg.sender, handle);
    }

    // --- requests -----------------------------------------------------------

    /// @notice Create a payment request (invoice). `token` = address(0) for
    ///         BNB. `expiry` = 0 means the request never expires. A
    ///         `reusable` request can be paid any number of times; otherwise
    ///         it can be paid exactly once.
    /// @return id The new request id (ids start at 1; 0 means "tip").
    function createRequest(address token, uint256 amount, string calldata memo, uint64 expiry, bool reusable)
        external
        returns (uint256 id)
    {
        Profile storage p = _profiles[msg.sender];
        if (!p.registered) revert NotRegistered();
        if (amount == 0) revert ZeroAmount();
        if (expiry != 0 && expiry <= block.timestamp) revert BadExpiry();

        id = nextRequestId++;
        Request storage r = _requests[id];
        r.creator = msg.sender;
        r.creatorHandle = p.handle;
        r.token = token;
        r.amount = amount;
        r.memo = memo;
        r.expiry = expiry;
        r.reusable = reusable;

        emit RequestCreated(id, msg.sender, p.handle, token, amount, memo, expiry, reusable);
    }

    /// @notice Pay a request. BNB requests must be paid with msg.value equal
    ///         to the request amount; ERC-20 requests pull the amount via
    ///         transferFrom. Either way the funds go straight to the creator
    ///         — this contract keeps nothing.
    function payRequest(uint256 id) external payable nonReentrant {
        Request storage r = _requests[id];
        if (r.creator == address(0)) revert RequestNotFound();
        if (r.expiry != 0 && block.timestamp > r.expiry) revert RequestExpired();
        if (r.paid) revert RequestAlreadyPaid(); // only reachable for one-shot requests

        string memory payerHandle = _holderHandle(msg.sender);

        // Validate the payment medium before touching state.
        if (r.token == address(0)) {
            if (msg.value != r.amount) revert WrongValue();
        } else {
            if (msg.value != 0) revert WrongValue();
        }

        // Effects first (checks-effects-interactions).
        r.paymentCount += 1;
        if (!r.reusable) r.paid = true;
        _recordReceipt(msg.sender, payerHandle, r.creator, r.creatorHandle, r.token, r.amount, r.memo, id);

        // Interaction last: forward the payment directly to the creator.
        if (r.token == address(0)) {
            _forwardBNB(r.creator, r.amount);
        } else {
            SafeToken.safeTransferFrom(r.token, msg.sender, r.creator, r.amount);
        }
    }

    // --- tips ---------------------------------------------------------------

    /// @notice Tip a registered agent by its bare handle label (e.g. "renx").
    ///         The target must have opted in via registerProfile(). BNB only.
    function tip(string calldata handleLabel, string calldata memo) external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        string memory payerHandle = _holderHandle(msg.sender);

        address target = agentId.ownerOfHandle(handleLabel);
        Profile storage p = _profiles[target];
        if (target == address(0) || !p.registered) revert TipTargetNotRegistered();
        // The registered profile must be for exactly this handle.
        if (keccak256(bytes(p.handle)) != keccak256(bytes(handleLabel))) revert TipTargetNotRegistered();

        _recordReceipt(msg.sender, payerHandle, target, p.handle, address(0), msg.value, memo, 0);
        _forwardBNB(target, msg.value);
    }

    // --- views --------------------------------------------------------------

    /// @notice Profile of the agent holding `handle` (bare label).
    function profileOf(string calldata handle) external view returns (Profile memory) {
        return _profiles[agentId.ownerOfHandle(handle)];
    }

    /// @notice Profile registered by `account`, if any.
    function profileByAddress(address account) external view returns (Profile memory) {
        return _profiles[account];
    }

    /// @notice A payment request by id.
    function requestOf(uint256 id) external view returns (Request memory) {
        return _requests[id];
    }

    /// @notice Receipt counters for an agent: (payments received, BNB volume received).
    function receiptsOf(string calldata handle) external view returns (uint256 receivedCount, uint256 receivedVolumeBNB) {
        Profile storage p = _profiles[agentId.ownerOfHandle(handle)];
        return (p.receivedCount, p.receivedVolumeBNB);
    }

    /// @notice Total number of receipts recorded (payments + tips).
    function receiptCount() external view returns (uint256) {
        return receipts.length;
    }

    // --- internals ----------------------------------------------------------

    /// @dev Gate: caller must hold an Agent ID; returns their handle.
    function _holderHandle(address who) internal view returns (string memory) {
        if (agentId.balanceOf(who) == 0) revert NotAgentHolder();
        return agentId.handleOf(who);
    }

    function _recordReceipt(
        address payer,
        string memory payerHandle,
        address payee,
        string memory payeeHandle,
        address token,
        uint256 amount,
        string memory memo,
        uint256 requestId
    ) internal {
        Profile storage payeeProfile = _profiles[payee];
        payeeProfile.receivedCount += 1;
        if (token == address(0)) payeeProfile.receivedVolumeBNB += amount;
        sentCount[payer] += 1;

        receipts.push(
            Receipt({
                payer: payer,
                payerHandle: payerHandle,
                payee: payee,
                payeeHandle: payeeHandle,
                token: token,
                amount: amount,
                memo: memo,
                requestId: requestId,
                timestamp: uint64(block.timestamp)
            })
        );

        emit PaymentRecorded(
            receipts.length - 1, requestId, payer, payerHandle, payee, payeeHandle, token, amount, memo
        );
    }

    function _forwardBNB(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert ForwardFailed();
    }
}
