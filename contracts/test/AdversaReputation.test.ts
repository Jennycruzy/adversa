import { ethers } from 'hardhat';
import { expect } from 'chai';
import { AdversaReputation } from '../typechain-types/index.js';

describe('AdversaReputation', () => {
  let reputation: AdversaReputation;
  let owner: Awaited<ReturnType<typeof ethers.getSigner>>;
  let updater: Awaited<ReturnType<typeof ethers.getSigner>>;
  let agent: Awaited<ReturnType<typeof ethers.getSigner>>;
  let nobody: Awaited<ReturnType<typeof ethers.getSigner>>;

  beforeEach(async () => {
    [owner, updater, agent, nobody] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('AdversaReputation');
    reputation = (await Factory.deploy()) as AdversaReputation;
    await reputation.waitForDeployment();

    // owner is auto-approved; also approve updater
    await reputation.connect(owner).approveCaller(updater.address);
  });

  describe('Access control', () => {
    it('reverts registerAgent from non-approved caller', async () => {
      await expect(
        reputation.connect(nobody).registerAgent(agent.address)
      ).to.be.revertedWithCustomError(reputation, 'NotApprovedCaller');
    });

    it('reverts updateReputation from non-approved caller', async () => {
      await reputation.connect(updater).registerAgent(agent.address);
      await expect(
        reputation.connect(nobody).updateReputation(agent.address, true)
      ).to.be.revertedWithCustomError(reputation, 'NotApprovedCaller');
    });

    it('reverts approveCaller from non-owner', async () => {
      await expect(
        reputation.connect(nobody).approveCaller(nobody.address)
      ).to.be.revertedWithCustomError(reputation, 'NotOwner');
    });
  });

  describe('Registration', () => {
    it('registers an agent with zero score', async () => {
      await reputation.connect(updater).registerAgent(agent.address);
      const stats = await reputation.getReputation(agent.address);
      expect(stats.reputationScore).to.equal(0n);
      expect(stats.exists).to.equal(true);
    });

    it('silently skips double registration (idempotent)', async () => {
      await reputation.connect(updater).registerAgent(agent.address);
      // Second call should not revert — contract is idempotent for existing agents
      await reputation.connect(updater).registerAgent(agent.address);
      const stats = await reputation.getReputation(agent.address);
      expect(stats.exists).to.equal(true);
      // Score should still be 0 — not reset by second registration
      expect(stats.reputationScore).to.equal(0n);
    });
  });

  describe('Reputation scoring', () => {
    beforeEach(async () => {
      await reputation.connect(updater).registerAgent(agent.address);
    });

    it('adds ACCURATE_REVIEW_BONUS (+10) for accurate review', async () => {
      await reputation.connect(updater).updateReputation(agent.address, true);
      const stats = await reputation.getReputation(agent.address);
      expect(stats.reputationScore).to.equal(10n);
      expect(stats.accurateReviews).to.equal(1n);
      expect(stats.totalReviews).to.equal(1n);
    });

    it('subtracts INACCURATE_REVIEW_PENALTY (20) for inaccurate review (floors at -∞ but starts 0)', async () => {
      await reputation.connect(updater).updateReputation(agent.address, false);
      const stats = await reputation.getReputation(agent.address);
      expect(stats.reputationScore).to.equal(-20n);
      expect(stats.totalReviews).to.equal(1n);
    });

    it('adds EXPLOIT_FOUND_BONUS (+25) for successful exploit discovery', async () => {
      // falsePositive = false means exploit was real (found successfully)
      await reputation.connect(updater).recordExploit(agent.address, false);
      const stats = await reputation.getReputation(agent.address);
      expect(stats.reputationScore).to.equal(25n);
      expect(stats.exploitsFound).to.equal(1n);
    });

    it('subtracts FALSE_POSITIVE_PENALTY (5) for false positive exploit', async () => {
      await reputation.connect(updater).recordExploit(agent.address, false); // +25
      await reputation.connect(updater).recordExploit(agent.address, true);  // -5 (false positive)
      const stats = await reputation.getReputation(agent.address);
      expect(stats.reputationScore).to.equal(20n);
      expect(stats.exploitsFalsePositive).to.equal(1n);
    });

    it('accumulates score across multiple reviews', async () => {
      await reputation.connect(updater).updateReputation(agent.address, true);  // +10
      await reputation.connect(updater).updateReputation(agent.address, true);  // +10
      await reputation.connect(updater).recordExploit(agent.address, false);    // +25
      const stats = await reputation.getReputation(agent.address);
      expect(stats.reputationScore).to.equal(45n);
      expect(stats.totalReviews).to.equal(2n);
      expect(stats.accurateReviews).to.equal(2n);
    });
  });

  describe('getAccuracyRate', () => {
    beforeEach(async () => {
      await reputation.connect(updater).registerAgent(agent.address);
    });

    it('returns 0 when no reviews', async () => {
      expect(await reputation.getAccuracyRate(agent.address)).to.equal(0n);
    });

    it('returns 10000 (100%) when all reviews accurate', async () => {
      await reputation.connect(updater).updateReputation(agent.address, true);
      await reputation.connect(updater).updateReputation(agent.address, true);
      expect(await reputation.getAccuracyRate(agent.address)).to.equal(10000n);
    });

    it('returns 5000 (50%) for half accurate', async () => {
      await reputation.connect(updater).updateReputation(agent.address, true);
      await reputation.connect(updater).updateReputation(agent.address, false);
      expect(await reputation.getAccuracyRate(agent.address)).to.equal(5000n);
    });
  });

  describe('getAllAgents', () => {
    it('returns all registered agents', async () => {
      await reputation.connect(updater).registerAgent(agent.address);
      await reputation.connect(updater).registerAgent(nobody.address);
      const agents = await reputation.getAllAgents();
      expect(agents).to.include(agent.address);
      expect(agents).to.include(nobody.address);
    });
  });
});
