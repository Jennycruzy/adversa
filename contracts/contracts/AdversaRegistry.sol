// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title AdversaRegistry — On-chain record of every code review by the ADVERSA swarm
/// @notice Stores review outcomes, TEE proof IDs, and 0G Storage roots immutably on 0G Chain
contract AdversaRegistry {
    struct ReviewResult {
        bytes32 prHash;
        address[] reviewerAgents;
        bool approved;
        string storageRoot;      // 0G Storage Merkle root of full debate transcript
        string teeProofId;       // 0G Compute TEE attestation ID
        uint256 timestamp;
        uint256 confidenceScore; // basis points (0–10000)
        uint256 exploitsFound;
        uint256 exploitsMitigated;
        bool exists;
    }

    address public owner;
    mapping(bytes32 => ReviewResult) public reviews;
    mapping(address => bool) public approvedCallers;
    bytes32[] private _allPRHashes;

    event ReviewRecorded(
        bytes32 indexed prHash,
        bool approved,
        uint256 confidenceScore,
        uint256 timestamp
    );
    event CallerApproved(address indexed caller);
    event CallerRevoked(address indexed caller);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotApprovedCaller();
    error ReviewAlreadyExists(bytes32 prHash);
    error ReviewNotFound(bytes32 prHash);
    error InvalidAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyApproved() {
        if (!approvedCallers[msg.sender] && msg.sender != owner) revert NotApprovedCaller();
        _;
    }

    constructor() {
        owner = msg.sender;
        approvedCallers[msg.sender] = true;
    }

    function approveCaller(address caller) external onlyOwner {
        if (caller == address(0)) revert InvalidAddress();
        approvedCallers[caller] = true;
        emit CallerApproved(caller);
    }

    function revokeCaller(address caller) external onlyOwner {
        approvedCallers[caller] = false;
        emit CallerRevoked(caller);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        address old = owner;
        owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }

    function recordReview(
        bytes32 prHash,
        address[] calldata reviewerAgents,
        bool approved,
        string calldata storageRoot,
        string calldata teeProofId,
        uint256 confidenceScore,
        uint256 exploitsFound,
        uint256 exploitsMitigated
    ) external onlyApproved {
        if (reviews[prHash].exists) revert ReviewAlreadyExists(prHash);

        reviews[prHash] = ReviewResult({
            prHash: prHash,
            reviewerAgents: reviewerAgents,
            approved: approved,
            storageRoot: storageRoot,
            teeProofId: teeProofId,
            timestamp: block.timestamp,
            confidenceScore: confidenceScore,
            exploitsFound: exploitsFound,
            exploitsMitigated: exploitsMitigated,
            exists: true
        });

        _allPRHashes.push(prHash);
        emit ReviewRecorded(prHash, approved, confidenceScore, block.timestamp);
    }

    function getReview(bytes32 prHash) external view returns (ReviewResult memory) {
        if (!reviews[prHash].exists) revert ReviewNotFound(prHash);
        return reviews[prHash];
    }

    function getAllPRHashes() external view returns (bytes32[] memory) {
        return _allPRHashes;
    }

    function getTotalReviews() external view returns (uint256) {
        return _allPRHashes.length;
    }

    function getApprovalRate() external view returns (uint256) {
        if (_allPRHashes.length == 0) return 0;
        uint256 approved = 0;
        for (uint256 i = 0; i < _allPRHashes.length; i++) {
            if (reviews[_allPRHashes[i]].approved) approved++;
        }
        return (approved * 10000) / _allPRHashes.length;
    }
}
