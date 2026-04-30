import { ethers } from 'hardhat';
import { expect } from 'chai';
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs';
import { AdversaRegistry } from '../typechain-types/index.js';

describe('AdversaRegistry', () => {
  let registry: AdversaRegistry;
  let owner: Awaited<ReturnType<typeof ethers.getSigner>>;
  let caller: Awaited<ReturnType<typeof ethers.getSigner>>;
  let nobody: Awaited<ReturnType<typeof ethers.getSigner>>;

  const samplePRHash = ethers.keccak256(ethers.toUtf8Bytes('owner/repo#42@abc123'));
  const sampleStorageRoot = '0x' + 'a'.repeat(64);
  const sampleTEEProof = 'tee-proof-abc123';
  const sampleAgents: string[] = [];

  beforeEach(async () => {
    [owner, caller, nobody] = await ethers.getSigners();
    sampleAgents.push(caller.address);

    const Factory = await ethers.getContractFactory('AdversaRegistry');
    registry = (await Factory.deploy()) as AdversaRegistry;
    await registry.waitForDeployment();
  });

  describe('Access control', () => {
    it('sets deployer as owner', async () => {
      expect(await registry.owner()).to.equal(owner.address);
    });

    it('allows owner to approve callers', async () => {
      await expect(registry.approveCaller(caller.address))
        .to.emit(registry, 'CallerApproved')
        .withArgs(caller.address);
      expect(await registry.approvedCallers(caller.address)).to.be.true;
    });

    it('reverts when non-owner approves caller', async () => {
      await expect(registry.connect(nobody).approveCaller(caller.address))
        .to.be.revertedWithCustomError(registry, 'NotOwner');
    });

    it('allows owner to revoke callers', async () => {
      await registry.approveCaller(caller.address);
      await registry.revokeCaller(caller.address);
      expect(await registry.approvedCallers(caller.address)).to.be.false;
    });

    it('transfers ownership correctly', async () => {
      await expect(registry.transferOwnership(caller.address))
        .to.emit(registry, 'OwnershipTransferred')
        .withArgs(owner.address, caller.address);
      expect(await registry.owner()).to.equal(caller.address);
    });

    it('reverts invalid address for approveCaller', async () => {
      await expect(registry.approveCaller(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(registry, 'InvalidAddress');
    });
  });

  describe('recordReview', () => {
    beforeEach(async () => {
      await registry.approveCaller(caller.address);
    });

    it('records a review successfully', async () => {
      await expect(
        registry.connect(caller).recordReview(
          samplePRHash,
          sampleAgents,
          true,
          sampleStorageRoot,
          sampleTEEProof,
          8500,
          2,
          2
        )
      )
        .to.emit(registry, 'ReviewRecorded')
        .withArgs(samplePRHash, true, 8500, anyValue);
    });

    it('stores review data correctly', async () => {
      const ts = BigInt(Math.floor(Date.now() / 1000));

      await registry.connect(caller).recordReview(
        samplePRHash, sampleAgents, true, sampleStorageRoot, sampleTEEProof, 8500, 2, 2
      );

      const review = await registry.getReview(samplePRHash);
      expect(review.prHash).to.equal(samplePRHash);
      expect(review.approved).to.be.true;
      expect(review.confidenceScore).to.equal(8500n);
      expect(review.storageRoot).to.equal(sampleStorageRoot);
      expect(review.teeProofId).to.equal(sampleTEEProof);
      expect(review.exploitsFound).to.equal(2n);
      expect(review.exploitsMitigated).to.equal(2n);
      expect(review.exists).to.be.true;
      expect(review.timestamp).to.be.gte(ts);
    });

    it('reverts on duplicate review', async () => {
      await registry.connect(caller).recordReview(
        samplePRHash, sampleAgents, true, sampleStorageRoot, sampleTEEProof, 8500, 0, 0
      );

      await expect(
        registry.connect(caller).recordReview(
          samplePRHash, sampleAgents, false, sampleStorageRoot, sampleTEEProof, 5000, 1, 0
        )
      ).to.be.revertedWithCustomError(registry, 'ReviewAlreadyExists').withArgs(samplePRHash);
    });

    it('reverts when called by non-approved address', async () => {
      await expect(
        registry.connect(nobody).recordReview(
          samplePRHash, sampleAgents, true, sampleStorageRoot, sampleTEEProof, 8500, 0, 0
        )
      ).to.be.revertedWithCustomError(registry, 'NotApprovedCaller');
    });

    it('allows owner to record reviews directly', async () => {
      await expect(
        registry.recordReview(
          samplePRHash, sampleAgents, true, sampleStorageRoot, sampleTEEProof, 9000, 1, 1
        )
      ).to.emit(registry, 'ReviewRecorded');
    });
  });

  describe('getReview', () => {
    it('reverts for non-existent review', async () => {
      const badHash = ethers.keccak256(ethers.toUtf8Bytes('does-not-exist'));
      await expect(registry.getReview(badHash))
        .to.be.revertedWithCustomError(registry, 'ReviewNotFound')
        .withArgs(badHash);
    });
  });

  describe('getAllPRHashes and getTotalReviews', () => {
    it('tracks all PR hashes', async () => {
      const hash1 = ethers.keccak256(ethers.toUtf8Bytes('pr1'));
      const hash2 = ethers.keccak256(ethers.toUtf8Bytes('pr2'));

      await registry.recordReview(hash1, sampleAgents, true, '', '', 9000, 0, 0);
      await registry.recordReview(hash2, sampleAgents, false, '', '', 2000, 3, 0);

      const hashes = await registry.getAllPRHashes();
      expect(hashes).to.have.length(2);
      expect(hashes[0]).to.equal(hash1);
      expect(hashes[1]).to.equal(hash2);

      expect(await registry.getTotalReviews()).to.equal(2n);
    });
  });

  describe('getApprovalRate', () => {
    it('returns 0 with no reviews', async () => {
      expect(await registry.getApprovalRate()).to.equal(0n);
    });

    it('calculates approval rate correctly', async () => {
      const hash1 = ethers.keccak256(ethers.toUtf8Bytes('pr-approve'));
      const hash2 = ethers.keccak256(ethers.toUtf8Bytes('pr-reject'));

      await registry.recordReview(hash1, sampleAgents, true, '', '', 8000, 0, 0);
      await registry.recordReview(hash2, sampleAgents, false, '', '', 3000, 2, 0);

      // 1/2 approved = 5000 basis points = 50%
      expect(await registry.getApprovalRate()).to.equal(5000n);
    });
  });
});

async function getTimestamp(): Promise<bigint> {
  const block = await ethers.provider.getBlock('latest');
  return BigInt(block?.timestamp ?? 0);
}
