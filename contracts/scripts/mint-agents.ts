import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

const OG_EXPLORER = 'https://chainscan-galileo.0g.ai';

const AGENT_ROLES = ['gateway', 'security', 'performance', 'style', 'redteam', 'coder'] as const;

const AGENT_DESCRIPTIONS: Record<string, string> = {
  gateway: 'Orchestrates the review swarm, manages consensus, routes via AXL mesh. Uses convergecast for vote aggregation.',
  security: 'Elite security reviewer specializing in OWASP Top 10, CWE classification, and adversarial defense.',
  performance: 'Performance engineer specializing in algorithmic complexity, N+1 queries, and scalability analysis.',
  style: 'Code quality specialist ensuring maintainability, documentation standards, and TypeScript best practices.',
  redteam: 'Adversarial attacker that generates working exploits and challenges security agents via A2A debate.',
  coder: 'Autonomous developer that writes production code from natural-language goals and opens GitHub PRs.',
};

async function main() {
  const deploymentPath = path.join(__dirname, '..', 'deployments', 'deployment.json');
  if (!fs.existsSync(deploymentPath)) {
    console.error('No deployment.json found. Run: pnpm deploy first.');
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8')) as {
    contracts: { AdversaINFT: string };
    deployer: string;
  };

  const [deployer] = await ethers.getSigners();
  const inft = await ethers.getContractAt('AdversaINFT', deployment.contracts.AdversaINFT);

  console.log('\n🎨 Minting ADVERSA Agent iNFTs...\n');

  const mintedTokens: Array<{
    role: string;
    tokenId: number;
    metadataHash: string;
    explorerLink: string;
  }> = [];

  for (const role of AGENT_ROLES) {
    const description = AGENT_DESCRIPTIONS[role];

    // Generate placeholder intelligence blob (in production, this is the real encrypted prompt)
    const intelligence = JSON.stringify({
      role,
      description,
      version: 1,
      createdAt: Date.now(),
      network: 'AXL (Yggdrasil Mesh)',
      inference: '0G Compute (TEE-verified)',
      storage: '0G Storage',
      encrypted: false, // true in production
    });

    const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(intelligence));

    // Placeholder URI — in production, this is the 0G Storage root hash after upload
    const encryptedURI = `0g-storage://adversa-intelligence-${role}-v1`;

    console.log(`  Minting ${role} agent...`);

    const tx = await (inft as unknown as {
      mintAgent: (to: string, uri: string, hash: string, role: string) => Promise<{
        wait: () => Promise<{ hash: string; logs: Array<{ topics: string[] }> }>;
      }>;
    }).mintAgent(
      deployer.address,
      encryptedURI,
      metadataHash,
      role
    );

    const receipt = await tx.wait();
    // Token ID is next sequential after the last minted
    const tokenCount = mintedTokens.length + 1;

    const explorerLink = `${OG_EXPLORER}/token/${deployment.contracts.AdversaINFT}/${tokenCount}`;
    console.log(`  ✅ ${role}: tokenId=${tokenCount} tx=${receipt.hash.slice(0, 18)}...`);
    console.log(`     🔍 ${explorerLink}`);

    mintedTokens.push({
      role,
      tokenId: tokenCount,
      metadataHash,
      explorerLink,
    });
  }

  // Save minting results
  const mintResultsPath = path.join(__dirname, '..', 'deployments', 'minted-agents.json');
  fs.writeFileSync(mintResultsPath, JSON.stringify({
    mintedAt: new Date().toISOString(),
    inftContract: deployment.contracts.AdversaINFT,
    agents: mintedTokens,
  }, null, 2));

  console.log('\n📄 Mint results saved to contracts/deployments/minted-agents.json');
  console.log('\n🎉 All 6 ADVERSA agents minted as iNFTs on 0G Chain!\n');
  console.log('iNFT Explorer Links:');
  mintedTokens.forEach(t => console.log(`  ${t.role}: ${t.explorerLink}`));
}

main().catch(err => {
  console.error('Mint failed:', err);
  process.exit(1);
});
