// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title AdversaReputation — On-chain reputation ledger for ADVERSA agents
/// @notice Tracks review accuracy, exploit discovery rate, and overall agent quality
contract AdversaReputation {
    struct AgentStats {
        int256 reputationScore;
        uint256 totalReviews;
        uint256 accurateReviews;
        uint256 exploitsFound;
        uint256 exploitsFalsePositive;
        uint256 lastUpdated;
        bool exists;
    }

    address public owner;
    mapping(address => AgentStats) public agentStats;
    mapping(address => bool) public approvedCallers;
    address[] private _registeredAgents;

    // Scoring constants
    int256 public constant ACCURATE_REVIEW_BONUS = 10;
    int256 public constant INACCURATE_REVIEW_PENALTY = 20;
    int256 public constant EXPLOIT_FOUND_BONUS = 25;
    int256 public constant FALSE_POSITIVE_PENALTY = 5;

    event ReputationUpdated(address indexed agent, int256 newScore, bool wasAccurate);
    event AgentRegistered(address indexed agent);
    event ExploitRecorded(address indexed agent, bool falsePositive, int256 newScore);
    event CallerApproved(address indexed caller);

    error NotOwner();
    error NotApprovedCaller();
    error AgentAlreadyRegistered(address agent);
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

    function registerAgent(address agent) external onlyApproved {
        if (agent == address(0)) revert InvalidAddress();
        if (!agentStats[agent].exists) {
            agentStats[agent] = AgentStats({
                reputationScore: 0,
                totalReviews: 0,
                accurateReviews: 0,
                exploitsFound: 0,
                exploitsFalsePositive: 0,
                lastUpdated: block.timestamp,
                exists: true
            });
            _registeredAgents.push(agent);
            emit AgentRegistered(agent);
        }
    }

    function updateReputation(address agent, bool wasAccurate) external onlyApproved {
        if (!agentStats[agent].exists) {
            // Auto-register
            agentStats[agent] = AgentStats({
                reputationScore: 0,
                totalReviews: 0,
                accurateReviews: 0,
                exploitsFound: 0,
                exploitsFalsePositive: 0,
                lastUpdated: block.timestamp,
                exists: true
            });
            _registeredAgents.push(agent);
            emit AgentRegistered(agent);
        }

        AgentStats storage stats = agentStats[agent];
        stats.totalReviews++;
        stats.lastUpdated = block.timestamp;

        if (wasAccurate) {
            stats.accurateReviews++;
            stats.reputationScore += ACCURATE_REVIEW_BONUS;
        } else {
            stats.reputationScore -= INACCURATE_REVIEW_PENALTY;
        }

        emit ReputationUpdated(agent, stats.reputationScore, wasAccurate);
    }

    function recordExploit(address agent, bool falsePositive) external onlyApproved {
        if (!agentStats[agent].exists) {
            agentStats[agent] = AgentStats({
                reputationScore: 0,
                totalReviews: 0,
                accurateReviews: 0,
                exploitsFound: 0,
                exploitsFalsePositive: 0,
                lastUpdated: block.timestamp,
                exists: true
            });
            _registeredAgents.push(agent);
            emit AgentRegistered(agent);
        }

        AgentStats storage stats = agentStats[agent];

        if (falsePositive) {
            stats.exploitsFalsePositive++;
            stats.reputationScore -= FALSE_POSITIVE_PENALTY;
        } else {
            stats.exploitsFound++;
            stats.reputationScore += EXPLOIT_FOUND_BONUS;
        }

        stats.lastUpdated = block.timestamp;
        emit ExploitRecorded(agent, falsePositive, stats.reputationScore);
    }

    function getReputation(address agent) external view returns (AgentStats memory) {
        return agentStats[agent];
    }

    function getAccuracyRate(address agent) external view returns (uint256) {
        AgentStats memory stats = agentStats[agent];
        if (stats.totalReviews == 0) return 0;
        return (stats.accurateReviews * 10000) / stats.totalReviews;
    }

    function getTopAgents(uint256 limit) external view returns (address[] memory, int256[] memory) {
        uint256 count = _registeredAgents.length < limit ? _registeredAgents.length : limit;
        address[] memory agents = new address[](count);
        int256[] memory scores = new int256[](count);

        // Simple selection (not sorted for gas efficiency — sort off-chain)
        for (uint256 i = 0; i < count; i++) {
            agents[i] = _registeredAgents[i];
            scores[i] = agentStats[_registeredAgents[i]].reputationScore;
        }

        return (agents, scores);
    }

    function getAllAgents() external view returns (address[] memory) {
        return _registeredAgents;
    }
}
