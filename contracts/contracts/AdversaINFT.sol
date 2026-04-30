// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AdversaINFT — ERC-7857-compatible iNFT for ADVERSA agents
/// @notice Each agent is minted as an iNFT with encrypted intelligence stored on 0G Storage.
///         Agents evolve as they learn new attack/defense patterns — evolution count increases.
///         Intelligence URI points to the agent's encrypted system prompt + learned patterns on 0G Storage.
contract AdversaINFT is ERC721, ERC721URIStorage, Ownable, ReentrancyGuard {
    struct AgentMetadata {
        string encryptedIntelligenceURI; // 0G Storage URI of encrypted prompt/skills/memory
        bytes32 metadataHash;            // keccak256 of the encrypted intelligence blob
        string role;                     // "coder" | "security" | "redteam" | "performance" | "style" | "gateway"
        uint256 evolutionCount;          // Increments each time the agent learns
        uint256 lastUpdated;
        int256 reputationScore;          // Synced from AdversaReputation
        uint256 totalReviews;
        bool active;
    }

    uint256 private _nextTokenId = 1;
    mapping(uint256 => AgentMetadata) public agentMetadata;
    mapping(string => uint256) public roleToTokenId;   // role → token ID (one agent per role)
    mapping(address => uint256[]) private _ownerTokens;
    address public reputationContract;

    event AgentMinted(uint256 indexed tokenId, string role, bytes32 metadataHash, address to);
    event AgentEvolved(uint256 indexed tokenId, uint256 evolutionCount, bytes32 newMetadataHash);
    event ReputationSynced(uint256 indexed tokenId, int256 reputationScore, uint256 totalReviews);
    event AgentDeactivated(uint256 indexed tokenId);
    event AgentReactivated(uint256 indexed tokenId);

    error NotTokenOwner(uint256 tokenId);
    error TokenNotActive(uint256 tokenId);
    error TokenDoesNotExist(uint256 tokenId);
    error InvalidAddress();
    error EmptyURI();

    constructor(address initialOwner) ERC721("ADVERSA Agents", "ADVERSA") Ownable(initialOwner) {}

    function setReputationContract(address addr) external onlyOwner {
        if (addr == address(0)) revert InvalidAddress();
        reputationContract = addr;
    }

    /// @notice Mint a new agent iNFT. Only the contract owner (deployer) can mint.
    /// @param to Recipient address (agent wallet)
    /// @param encryptedURI 0G Storage URI of the agent's encrypted intelligence
    /// @param metadataHash keccak256 hash of the encrypted intelligence blob
    /// @param role Agent role identifier
    function mintAgent(
        address to,
        string calldata encryptedURI,
        bytes32 metadataHash,
        string calldata role
    ) external onlyOwner nonReentrant returns (uint256) {
        if (to == address(0)) revert InvalidAddress();
        if (bytes(encryptedURI).length == 0) revert EmptyURI();

        uint256 tokenId = _nextTokenId++;
        _safeMint(to, tokenId);

        agentMetadata[tokenId] = AgentMetadata({
            encryptedIntelligenceURI: encryptedURI,
            metadataHash: metadataHash,
            role: role,
            evolutionCount: 0,
            lastUpdated: block.timestamp,
            reputationScore: 0,
            totalReviews: 0,
            active: true
        });

        roleToTokenId[role] = tokenId;
        _ownerTokens[to].push(tokenId);

        emit AgentMinted(tokenId, role, metadataHash, to);
        return tokenId;
    }

    /// @notice Update agent's intelligence after it learns new patterns. Only token owner can evolve.
    /// @param tokenId The agent's token ID
    /// @param newEncryptedURI Updated 0G Storage URI with new intelligence
    /// @param newMetadataHash Updated hash of the new intelligence blob
    function evolveAgent(
        uint256 tokenId,
        string calldata newEncryptedURI,
        bytes32 newMetadataHash
    ) external nonReentrant {
        if (!_exists(tokenId)) revert TokenDoesNotExist(tokenId);
        if (ownerOf(tokenId) != msg.sender) revert NotTokenOwner(tokenId);
        if (!agentMetadata[tokenId].active) revert TokenNotActive(tokenId);
        if (bytes(newEncryptedURI).length == 0) revert EmptyURI();

        AgentMetadata storage meta = agentMetadata[tokenId];
        meta.encryptedIntelligenceURI = newEncryptedURI;
        meta.metadataHash = newMetadataHash;
        meta.evolutionCount++;
        meta.lastUpdated = block.timestamp;

        emit AgentEvolved(tokenId, meta.evolutionCount, newMetadataHash);
    }

    /// @notice Sync reputation score from AdversaReputation contract. Called by reputation contract or owner.
    function syncReputation(uint256 tokenId, int256 score, uint256 reviews) external {
        require(
            msg.sender == reputationContract || msg.sender == owner(),
            "AdversaINFT: unauthorized reputation sync"
        );
        if (!_exists(tokenId)) revert TokenDoesNotExist(tokenId);

        agentMetadata[tokenId].reputationScore = score;
        agentMetadata[tokenId].totalReviews = reviews;
        emit ReputationSynced(tokenId, score, reviews);
    }

    function deactivateAgent(uint256 tokenId) external onlyOwner {
        if (!_exists(tokenId)) revert TokenDoesNotExist(tokenId);
        agentMetadata[tokenId].active = false;
        emit AgentDeactivated(tokenId);
    }

    function reactivateAgent(uint256 tokenId) external onlyOwner {
        if (!_exists(tokenId)) revert TokenDoesNotExist(tokenId);
        agentMetadata[tokenId].active = true;
        emit AgentReactivated(tokenId);
    }

    function getAgentMetadata(uint256 tokenId) external view returns (AgentMetadata memory) {
        if (!_exists(tokenId)) revert TokenDoesNotExist(tokenId);
        return agentMetadata[tokenId];
    }

    function getOwnerTokens(address ownerAddr) external view returns (uint256[] memory) {
        return _ownerTokens[ownerAddr];
    }

    function totalSupply() external view returns (uint256) {
        return _nextTokenId - 1;
    }

    function _exists(uint256 tokenId) internal view returns (bool) {
        return tokenId > 0 && tokenId < _nextTokenId && _ownerOf(tokenId) != address(0);
    }

    // ─── ERC721 overrides ────────────────────────────────────────────────────────

    function tokenURI(uint256 tokenId)
        public
        view
        override(ERC721, ERC721URIStorage)
        returns (string memory)
    {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721URIStorage)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
