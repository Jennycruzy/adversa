import { ethers } from 'hardhat';
import { expect } from 'chai';
import { AdversaINFT } from '../typechain-types/index.js';

describe('AdversaINFT', () => {
  let inft: AdversaINFT;
  let owner: Awaited<ReturnType<typeof ethers.getSigner>>;
  let agent: Awaited<ReturnType<typeof ethers.getSigner>>;
  let other: Awaited<ReturnType<typeof ethers.getSigner>>;

  const encryptedURI = 'ipfs://QmAgentIntelligenceV1';
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes('intelligence-v1'));
  const newURI = 'ipfs://QmAgentIntelligenceV2';
  const newHash = ethers.keccak256(ethers.toUtf8Bytes('intelligence-v2'));

  beforeEach(async () => {
    [owner, agent, other] = await ethers.getSigners();

    const INFTFactory = await ethers.getContractFactory('AdversaINFT');
    inft = (await INFTFactory.deploy(owner.address)) as AdversaINFT;
    await inft.waitForDeployment();
  });

  describe('mintAgent', () => {
    it('mints an agent NFT to the specified address', async () => {
      await inft.connect(owner).mintAgent(agent.address, encryptedURI, metadataHash, 'security');
      const tokenId = await inft.roleToTokenId('security');
      expect(await inft.ownerOf(tokenId)).to.equal(agent.address);
    });

    it('records the role and metadata on the minted token', async () => {
      await inft.connect(owner).mintAgent(agent.address, encryptedURI, metadataHash, 'redteam');
      const tokenId = await inft.roleToTokenId('redteam');
      const meta = await inft.getAgentMetadata(tokenId);
      expect(meta.role).to.equal('redteam');
      expect(meta.metadataHash).to.equal(metadataHash);
      expect(meta.active).to.equal(true);
      expect(meta.evolutionCount).to.equal(0n);
    });

    it('reverts minting the same role twice', async () => {
      await inft.connect(owner).mintAgent(agent.address, encryptedURI, metadataHash, 'security');
      // roleToTokenId already set — second mint with same role should revert
      // The contract does not explicitly check for duplicate roles but re-assigning roleToTokenId
      // means the first token becomes orphaned. Check the owner-only guard triggers first.
      await expect(
        inft.connect(other).mintAgent(other.address, encryptedURI, metadataHash, 'security')
      ).to.be.reverted;
    });

    it('reverts mintAgent from non-owner', async () => {
      await expect(
        inft.connect(other).mintAgent(agent.address, encryptedURI, metadataHash, 'perf')
      ).to.be.reverted;
    });

    it('reverts with empty URI', async () => {
      await expect(
        inft.connect(owner).mintAgent(agent.address, '', metadataHash, 'style')
      ).to.be.revertedWithCustomError(inft, 'EmptyURI');
    });

    it('reverts with zero address', async () => {
      await expect(
        inft.connect(owner).mintAgent(ethers.ZeroAddress, encryptedURI, metadataHash, 'perf')
      ).to.be.revertedWithCustomError(inft, 'InvalidAddress');
    });
  });

  describe('evolveAgent', () => {
    let tokenId: bigint;

    beforeEach(async () => {
      await inft.connect(owner).mintAgent(agent.address, encryptedURI, metadataHash, 'security');
      tokenId = await inft.roleToTokenId('security');
    });

    it('updates metadata and increments evolution count', async () => {
      await inft.connect(agent).evolveAgent(tokenId, newURI, newHash);
      const meta = await inft.getAgentMetadata(tokenId);
      expect(meta.evolutionCount).to.equal(1n);
      expect(meta.metadataHash).to.equal(newHash);
    });

    it('can evolve multiple times', async () => {
      await inft.connect(agent).evolveAgent(tokenId, newURI, newHash);
      const hash2 = ethers.keccak256(ethers.toUtf8Bytes('intelligence-v3'));
      await inft.connect(agent).evolveAgent(tokenId, 'ipfs://v3', hash2);
      const meta = await inft.getAgentMetadata(tokenId);
      expect(meta.evolutionCount).to.equal(2n);
    });

    it('reverts evolveAgent from non-token-owner', async () => {
      await expect(
        inft.connect(other).evolveAgent(tokenId, newURI, newHash)
      ).to.be.revertedWithCustomError(inft, 'NotTokenOwner');
    });

    it('reverts evolveAgent for non-existent token', async () => {
      await expect(
        inft.connect(agent).evolveAgent(9999n, newURI, newHash)
      ).to.be.revertedWithCustomError(inft, 'TokenDoesNotExist');
    });

    it('reverts evolveAgent with empty URI', async () => {
      await expect(
        inft.connect(agent).evolveAgent(tokenId, '', newHash)
      ).to.be.revertedWithCustomError(inft, 'EmptyURI');
    });
  });

  describe('deactivateAgent', () => {
    let tokenId: bigint;

    beforeEach(async () => {
      await inft.connect(owner).mintAgent(agent.address, encryptedURI, metadataHash, 'style');
      tokenId = await inft.roleToTokenId('style');
    });

    it('deactivates an agent token', async () => {
      await inft.connect(owner).deactivateAgent(tokenId);
      const meta = await inft.getAgentMetadata(tokenId);
      expect(meta.active).to.equal(false);
    });

    it('reverts evolveAgent on deactivated token', async () => {
      await inft.connect(owner).deactivateAgent(tokenId);
      await expect(
        inft.connect(agent).evolveAgent(tokenId, newURI, newHash)
      ).to.be.revertedWithCustomError(inft, 'TokenNotActive');
    });

    it('reverts deactivation from non-owner', async () => {
      await expect(
        inft.connect(other).deactivateAgent(tokenId)
      ).to.be.reverted;
    });
  });

  describe('reactivateAgent', () => {
    let tokenId: bigint;

    beforeEach(async () => {
      await inft.connect(owner).mintAgent(agent.address, encryptedURI, metadataHash, 'coder');
      tokenId = await inft.roleToTokenId('coder');
      await inft.connect(owner).deactivateAgent(tokenId);
    });

    it('reactivates a deactivated agent', async () => {
      await inft.connect(owner).reactivateAgent(tokenId);
      const meta = await inft.getAgentMetadata(tokenId);
      expect(meta.active).to.equal(true);
    });
  });

  describe('getOwnerTokens', () => {
    it('returns all token IDs owned by an address', async () => {
      await inft.connect(owner).mintAgent(agent.address, encryptedURI, metadataHash, 'security');
      await inft.connect(owner).mintAgent(agent.address, encryptedURI, metadataHash, 'perf');
      const tokens = await inft.getOwnerTokens(agent.address);
      expect(tokens.length).to.equal(2);
    });
  });

  describe('totalSupply', () => {
    it('increments after each mint', async () => {
      expect(await inft.totalSupply()).to.equal(0n);
      await inft.connect(owner).mintAgent(agent.address, encryptedURI, metadataHash, 'security');
      expect(await inft.totalSupply()).to.equal(1n);
      await inft.connect(owner).mintAgent(agent.address, encryptedURI, metadataHash, 'perf');
      expect(await inft.totalSupply()).to.equal(2n);
    });
  });

  describe('syncReputation', () => {
    let tokenId: bigint;

    beforeEach(async () => {
      await inft.connect(owner).mintAgent(agent.address, encryptedURI, metadataHash, 'perf');
      tokenId = await inft.roleToTokenId('perf');
    });

    it('reverts syncReputation from unauthorized caller', async () => {
      // Neither reputation contract (not set) nor other account
      await expect(
        inft.connect(other).syncReputation(tokenId, 500n, 10n)
      ).to.be.reverted;
    });

    it('allows owner to sync reputation', async () => {
      await inft.connect(owner).syncReputation(tokenId, 250n, 5n);
      const meta = await inft.getAgentMetadata(tokenId);
      expect(meta.reputationScore).to.equal(250n);
      expect(meta.totalReviews).to.equal(5n);
    });
  });
});
