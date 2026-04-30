import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

const OG_EXPLORER = 'https://chainscan-galileo.0g.ai';

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║       ADVERSA — Smart Contract Deployment        ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
  console.log('Deployer:  ', deployer.address);
  console.log('Network:   ', network.name, `(chainId: ${network.chainId})`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log('Balance:   ', ethers.formatEther(balance), 'A0GI');
  console.log('');

  if (balance === 0n) {
    console.error('⚠️  Deployer has no balance. Get testnet tokens from the 0G faucet.');
    console.error('   Faucet: https://hub.0g.ai/faucet');
    process.exit(1);
  }

  // ─── Deploy AdversaRegistry ───────────────────────────────────────────────────
  console.log('📋 Deploying AdversaRegistry...');
  const RegistryFactory = await ethers.getContractFactory('AdversaRegistry');
  const registry = await RegistryFactory.deploy();
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log('✅ AdversaRegistry:', registryAddr);
  console.log('   🔍', `${OG_EXPLORER}/address/${registryAddr}`);

  // ─── Deploy AdversaReputation ─────────────────────────────────────────────────
  console.log('\n🏆 Deploying AdversaReputation...');
  const ReputationFactory = await ethers.getContractFactory('AdversaReputation');
  const reputation = await ReputationFactory.deploy();
  await reputation.waitForDeployment();
  const reputationAddr = await reputation.getAddress();
  console.log('✅ AdversaReputation:', reputationAddr);
  console.log('   🔍', `${OG_EXPLORER}/address/${reputationAddr}`);

  // ─── Deploy AdversaINFT ───────────────────────────────────────────────────────
  console.log('\n🎨 Deploying AdversaINFT...');
  const INFTFactory = await ethers.getContractFactory('AdversaINFT');
  const inft = await INFTFactory.deploy(deployer.address);
  await inft.waitForDeployment();
  const inftAddr = await inft.getAddress();
  console.log('✅ AdversaINFT:', inftAddr);
  console.log('   🔍', `${OG_EXPLORER}/address/${inftAddr}`);

  // ─── Wire contracts ───────────────────────────────────────────────────────────
  console.log('\n🔗 Wiring contracts...');

  const setRepTx = await (inft as unknown as { setReputationContract: (a: string) => Promise<{ wait: () => Promise<void> }> })
    .setReputationContract(reputationAddr);
  await setRepTx.wait();
  console.log('✅ INFT → linked to Reputation contract');

  const approveTx = await (reputation as unknown as { approveCaller: (a: string) => Promise<{ wait: () => Promise<void> }> })
    .approveCaller(registryAddr);
  await approveTx.wait();
  console.log('✅ Registry → approved as Reputation caller');

  const approveRegistryTx = await (registry as unknown as { approveCaller: (a: string) => Promise<{ wait: () => Promise<void> }> })
    .approveCaller(deployer.address);
  await approveRegistryTx.wait();
  console.log('✅ Deployer → approved as Registry caller');

  // ─── Save deployment ──────────────────────────────────────────────────────────
  const deployment = {
    network: network.name,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    explorer: OG_EXPLORER,
    contracts: {
      AdversaRegistry: registryAddr,
      AdversaReputation: reputationAddr,
      AdversaINFT: inftAddr,
    },
    explorerLinks: {
      AdversaRegistry: `${OG_EXPLORER}/address/${registryAddr}`,
      AdversaReputation: `${OG_EXPLORER}/address/${reputationAddr}`,
      AdversaINFT: `${OG_EXPLORER}/address/${inftAddr}`,
    },
  };

  const outputDir = path.join(__dirname, '..', 'deployments');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  fs.writeFileSync(
    path.join(outputDir, 'deployment.json'),
    JSON.stringify(deployment, null, 2)
  );
  console.log('\n📄 Deployment saved to contracts/deployments/deployment.json');

  // Update parent .env if it exists
  const envPath = path.join(__dirname, '..', '..', '.env');
  if (fs.existsSync(envPath)) {
    let envContent = fs.readFileSync(envPath, 'utf8');
    envContent = envContent
      .replace(/^ADVERSA_REGISTRY_ADDRESS=.*/m, `ADVERSA_REGISTRY_ADDRESS=${registryAddr}`)
      .replace(/^ADVERSA_REPUTATION_ADDRESS=.*/m, `ADVERSA_REPUTATION_ADDRESS=${reputationAddr}`)
      .replace(/^ADVERSA_INFT_ADDRESS=.*/m, `ADVERSA_INFT_ADDRESS=${inftAddr}`);
    fs.writeFileSync(envPath, envContent);
    console.log('✅ .env updated with contract addresses');
  }

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║           Deployment Summary                     ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Registry:   ${registryAddr.slice(0, 20)}...  ║`);
  console.log(`║  Reputation: ${reputationAddr.slice(0, 20)}...  ║`);
  console.log(`║  INFT:       ${inftAddr.slice(0, 20)}...  ║`);
  console.log('╚══════════════════════════════════════════════════╝\n');
  console.log('Next step: pnpm run mint-agents');
}

main().catch(err => {
  console.error('Deployment failed:', err);
  process.exit(1);
});
