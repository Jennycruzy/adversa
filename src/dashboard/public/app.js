/* ADVERSA Dashboard — Real-time Socket.IO client */
'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  agents: {},
  debateRound: 0,
  offlineMode: false,
  queueLength: 0,
  currentPhase: -1,
  votes: {},
  connected: false,
};

const ROLE_ICONS = {
  gateway: '🌐', security: '🛡', performance: '⚡', style: '✨', redteam: '☠', coder: '💻',
};
const ROLE_COLORS = {
  gateway: '#10B981', security: '#3B82F6', performance: '#F59E0B',
  style: '#8B5CF6', redteam: '#EF4444', coder: '#22C55E',
};

const PIPELINE_PHASES = [
  { id: 0, name: 'Goal Injection', detail: 'Coder receives task' },
  { id: 1, name: 'Topology', detail: 'Discovering online agents' },
  { id: 2, name: 'Fan-out', detail: 'MCP calls to reviewers' },
  { id: 3, name: 'Red-Team', detail: 'Exploit scan + A2A debate' },
  { id: 4, name: 'Guardrails', detail: 'Human presence detection' },
  { id: 5, name: 'Consensus', detail: 'Weighted vote aggregation' },
  { id: 6, name: 'Action', detail: 'Merge / reject + record' },
];

// ─── Socket.IO Connection ─────────────────────────────────────────────────────
const socket = io({ transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  state.connected = true;
  updateConnBadge(true);
  console.log('Dashboard connected via Socket.IO');
});

socket.on('disconnect', () => {
  state.connected = false;
  updateConnBadge(false);
});

socket.on('connected', (data) => {
  state.offlineMode = data.offlineMode;
  updateOfflineBanner();
  loadQRCode(data.dashboardUrl);
});

// ─── AXL Mesh Events ──────────────────────────────────────────────────────────
socket.on('agent-online', (data) => {
  state.agents[data.peerId] = { ...state.agents[data.peerId], ...data, online: true, status: 'idle' };
  renderAgentCards();
  renderMesh();
  updateAgentCount();
});

socket.on('agent-offline', (data) => {
  if (state.agents[data.peerId]) {
    state.agents[data.peerId].online = false;
  }
  renderAgentCards();
  renderMesh();
  updateAgentCount();
});

socket.on('agent-status', (data) => {
  if (state.agents[data.peerId]) {
    state.agents[data.peerId].status = data.status;
    renderAgentCards();
  }
  renderMesh();
});

// ─── Pipeline Events ──────────────────────────────────────────────────────────
socket.on('pipeline-start', (data) => {
  state.currentPhase = 0;
  state.votes = {};
  renderPipelinePhases();
  clearConsensus();
  document.getElementById('pipeline-status').textContent = `PR #${data.prNumber}`;
});

socket.on('pipeline-phase', (data) => {
  state.currentPhase = data.phase;
  renderPipelinePhases();
  updatePhaseDetail(data);
});

socket.on('pipeline-complete', (data) => {
  state.currentPhase = 7; // All done
  renderPipelinePhases();
  showConsensusResult(data.approved, data.confidenceScore);
  if (data.txHash) showTxToast(data.txHash);
  document.getElementById('pipeline-status').textContent = data.approved ? 'APPROVED' : 'REJECTED';
});

socket.on('pipeline-error', (data) => {
  document.getElementById('pipeline-status').textContent = 'Error';
  appendDebateMessage({
    fromRole: 'gateway',
    type: 'system',
    content: `Pipeline error: ${data.error}`,
    timestamp: Date.now(),
    confidence: 0,
  });
});

// ─── MCP Call Events ──────────────────────────────────────────────────────────
socket.on('mcp-call', (data) => {
  renderMeshEdge(data.from || 'gateway', data.to || data.toRole, '#8B5CF6');
});

// ─── Debate Events ────────────────────────────────────────────────────────────
socket.on('a2a-debate', (data) => {
  state.debateRound++;
  document.getElementById('debate-round').textContent = `Round ${state.debateRound}`;
  appendDebateMessage({
    fromRole: data.fromRole || 'redteam',
    type: data.type,
    content: data.content,
    severity: data.severity,
    cvssScore: data.cvssScore,
    timestamp: data.timestamp || Date.now(),
    confidence: 70,
    isAttack: data.type === 'exploit_challenge' || data.type === 'counter_attack',
  });
  renderMeshEdge(data.from, data.to, '#EF4444');
});

socket.on('exploit-attempt', (data) => {
  appendDebateMessage({
    fromRole: 'redteam',
    type: 'exploit_scan',
    content: `Found ${data.exploitCount} exploit(s), ${data.criticalCount} critical`,
    timestamp: data.timestamp || Date.now(),
    confidence: 90,
    isAttack: true,
  });
});

socket.on('exploit-defense', (data) => {
  appendDebateMessage({
    fromRole: 'security',
    type: data.mitigated ? 'defense' : 'concession',
    content: data.evidence || 'Analyzing exploit...',
    timestamp: data.timestamp || Date.now(),
    confidence: data.confidence || 70,
    mitigated: data.mitigated,
    isAttack: false,
  });
  renderMeshEdge(data.from, 'gateway', '#10B981');
});

// ─── Consensus Events ─────────────────────────────────────────────────────────
socket.on('consensus-vote', (data) => {
  state.votes[data.agentRole] = data;
  renderVoteBars();
});

socket.on('consensus-result', (data) => {
  showConsensusResult(data.approved, data.confidenceScore);
});

// ─── Offline / Sync Events ────────────────────────────────────────────────────
socket.on('offline-status', (data) => {
  state.offlineMode = !data.online;
  updateOfflineBanner();
});

socket.on('action-queued', (data) => {
  state.queueLength = data.queueLength;
  updateOfflineBanner();
  appendDebateMessage({
    fromRole: 'gateway',
    type: 'queue',
    content: `Queued: ${data.actionType} (${data.queueLength} total)`,
    timestamp: Date.now(),
    confidence: 100,
  });
});

socket.on('action-synced', (data) => {
  state.queueLength = data.remaining;
  updateOfflineBanner();
});

socket.on('sync-complete', (data) => {
  state.queueLength = 0;
  updateOfflineBanner();
  appendDebateMessage({
    fromRole: 'gateway',
    type: 'sync',
    content: `Sync complete — ${data.completed} actions replayed`,
    timestamp: Date.now(),
    confidence: 100,
  });
});

// ─── Chain TX Events ──────────────────────────────────────────────────────────
socket.on('chain-tx', (data) => {
  showTxToast(data.txHash, data.action);
  appendDebateMessage({
    fromRole: 'gateway',
    type: 'chain-tx',
    content: `On-chain: ${data.action} — tx ${data.txHash?.slice(0, 18)}...`,
    timestamp: Date.now(),
    confidence: 100,
  });
});

socket.on('inft-update', (data) => {
  const agent = Object.values(state.agents).find(a => a.role === data.role);
  if (agent) agent.evolutionCount = (agent.evolutionCount || 0) + 1;
  renderAgentCards();
  appendDebateMessage({
    fromRole: data.role || 'gateway',
    type: 'inft',
    content: `iNFT ${data.action}: ${data.role} agent (evolution #${data.version || '?'})`,
    timestamp: Date.now(),
    confidence: 100,
  });
});

socket.on('human-detected', (data) => {
  appendDebateMessage({
    fromRole: 'human',
    type: 'human',
    content: `Human activity detected — auto-merge paused. ${data.reason || ''}`,
    timestamp: Date.now(),
    confidence: 100,
  });
});

socket.on('goal-injected', (data) => {
  appendDebateMessage({
    fromRole: data.source || 'dashboard',
    type: 'goal',
    content: `Goal injected: "${data.goal}"`,
    timestamp: data.timestamp || Date.now(),
    confidence: 100,
  });
});

socket.on('gossip-broadcast', (data) => {
  // Animate a ripple across all mesh nodes to show gossip propagation
  animateMeshGossip(data.topic);
});

// ─── Render: Connectivity ─────────────────────────────────────────────────────
function updateConnBadge(online) {
  const dot = document.getElementById('conn-dot');
  const text = document.getElementById('conn-text');
  if (dot && text) {
    dot.className = 'conn-dot ' + (online ? 'online' : 'offline');
    text.textContent = online ? 'Connected' : 'Disconnected';
  }
}

// ─── Render: Offline Banner ───────────────────────────────────────────────────
function updateOfflineBanner() {
  const banner = document.getElementById('offline-banner');
  const text = document.getElementById('offline-text');
  const badge = document.getElementById('queue-count');
  const toggleBtn = document.getElementById('offline-toggle');
  const toggleStatus = document.getElementById('toggle-status');

  if (banner) banner.classList.toggle('hidden', !state.offlineMode);
  if (text) text.textContent = state.offlineMode ? 'MESH ONLY — No Internet' : 'FULLY CONNECTED';
  if (badge) badge.textContent = `${state.queueLength} queued`;
  if (toggleBtn) {
    toggleBtn.textContent = state.offlineMode ? '🌐 Restore Internet' : '🔌 Kill Internet';
    toggleBtn.className = state.offlineMode ? 'btn btn-secondary' : 'btn btn-danger';
  }
  if (toggleStatus) {
    toggleStatus.textContent = state.offlineMode ? 'MESH ONLY' : 'Connected';
    toggleStatus.style.color = state.offlineMode ? '#F97316' : '#22C55E';
  }
}

// ─── Render: Pipeline Phases ──────────────────────────────────────────────────
function renderPipelinePhases() {
  const container = document.getElementById('pipeline-phases');
  if (!container) return;

  container.innerHTML = PIPELINE_PHASES.map(phase => {
    const cls = phase.id < state.currentPhase ? 'complete'
      : phase.id === state.currentPhase ? 'active' : '';
    return `<div class="phase-step ${cls}">
      <div class="phase-number">${phase.id === state.currentPhase ? '▶' : phase.id < state.currentPhase ? '✓' : phase.id}</div>
      <div class="phase-info">
        <div class="phase-name">${phase.name}</div>
        <div class="phase-detail">${phase.detail}</div>
      </div>
    </div>`;
  }).join('');
}

function updatePhaseDetail(data) {
  // Could update specific phase detail text with real-time data
}

function clearConsensus() {
  const result = document.getElementById('consensus-result');
  if (result) { result.className = 'consensus-result hidden'; result.textContent = ''; }
}

function showConsensusResult(approved, confidenceScore) {
  const result = document.getElementById('consensus-result');
  if (!result) return;
  const pct = ((confidenceScore || 0) / 100).toFixed(1);
  result.className = `consensus-result ${approved ? 'approved' : 'rejected'}`;
  result.innerHTML = `${approved ? '✅ APPROVED' : '❌ REJECTED'}<br><span style="font-size:13px;font-weight:400">${pct}% confidence</span>`;
}

// ─── Render: Vote Bars ────────────────────────────────────────────────────────
function renderVoteBars() {
  const container = document.getElementById('vote-bars');
  if (!container) return;

  const roleOrder = ['redteam', 'security', 'performance', 'style', 'coder', 'human'];
  const roleWeights = { redteam: 4, security: 3, performance: 2, style: 1, human: 2, coder: 1 };

  container.innerHTML = roleOrder
    .filter(role => state.votes[role])
    .map(role => {
      const vote = state.votes[role];
      const isApprove = vote.verdict === 'approve';
      const fillPct = Math.min(100, vote.confidence || 70);
      const fillClass = role === 'redteam' ? 'redteam' : role === 'security' ? 'security' : (isApprove ? 'approve' : 'reject');
      return `<div class="vote-bar-row">
        <div class="vote-bar-label">${ROLE_ICONS[role] || '👤'} ${role}</div>
        <div class="vote-bar-track">
          <div class="vote-bar-fill ${fillClass}" style="width:${fillPct}%"></div>
        </div>
        <div class="vote-weight">${roleWeights[role] || 1}x</div>
      </div>`;
    }).join('');
}

// ─── Render: Debate Feed ──────────────────────────────────────────────────────
function appendDebateMessage(msg) {
  const feed = document.getElementById('debate-feed');
  if (!feed) return;

  const empty = feed.querySelector('.debate-empty');
  if (empty) empty.remove();

  const role = msg.fromRole || 'gateway';
  const isAttack = msg.isAttack || ['exploit_challenge', 'counter_attack'].includes(msg.type);
  const confLevel = (msg.confidence || 70) >= 80 ? 'high' : (msg.confidence || 70) >= 50 ? 'medium' : 'low';
  const typeLabel = {
    exploit_challenge: '⚔ Attack',
    counter_attack: '⚔ Counter',
    defense: '🛡 Defense',
    concession: '⚠ Conceded',
    exploit_scan: '🔍 Scanning',
    queue: '📦 Queued',
    sync: '🔄 Synced',
    chain_tx: '⛓ On-chain',
    inft: '🎨 iNFT',
    human: '👤 Human',
    goal: '🎯 Goal',
  }[msg.type] || msg.type || 'Info';

  const time = new Date(msg.timestamp || Date.now()).toLocaleTimeString('en', { hour12: false });
  const severityBadge = msg.severity ? ` <span style="color:${msg.severity === 'critical' ? '#EF4444' : msg.severity === 'high' ? '#F97316' : '#F59E0B'}">[${msg.severity.toUpperCase()}]</span>` : '';

  const div = document.createElement('div');
  div.className = `debate-message ${role}`;
  div.innerHTML = `
    <div class="debate-header">
      <span class="debate-role" style="color:${ROLE_COLORS[role] || '#888'}">${ROLE_ICONS[role] || '●'} ${role}</span>
      <span class="debate-type">${typeLabel}${severityBadge}</span>
      <span class="debate-time">${time}</span>
    </div>
    <div class="debate-content">${escapeHtml(msg.content || '').slice(0, 300)}</div>
    ${msg.confidence !== undefined ? `<div class="debate-confidence">Confidence: <span class="confidence-badge ${confLevel}">${msg.confidence}%</span></div>` : ''}
  `;
  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
}

// ─── Render: Agent Cards ──────────────────────────────────────────────────────
function renderAgentCards() {
  const container = document.getElementById('agent-cards');
  if (!container) return;

  const agents = Object.values(state.agents);
  if (agents.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);padding:16px;text-align:center">No agents online yet...</div>';
    return;
  }

  container.innerHTML = agents.map(agent => {
    const role = agent.role || 'gateway';
    const online = agent.online !== false;
    const busy = ['reviewing', 'debating', 'generating'].includes(agent.status);
    const statusClass = online ? (busy ? 'busy' : 'online') : 'offline';

    return `<div class="agent-card ${statusClass}">
      <div class="agent-avatar ${role}">${ROLE_ICONS[role] || '🤖'}</div>
      <div class="agent-info">
        <div class="agent-name">${role}</div>
        <div class="agent-peer">${(agent.peerId || 'unknown').slice(0, 16)}...</div>
        <div class="agent-status">${agent.status || (online ? 'idle' : 'offline')}</div>
      </div>
      <div class="agent-meta">
        <div class="rep-score">${agent.reputationScore || 0}</div>
        ${agent.teeVerified ? '<div class="tee-badge">TEE ✓</div>' : ''}
        ${agent.evolutionCount ? `<div class="evolution-count">v${agent.evolutionCount}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function updateAgentCount() {
  const el = document.getElementById('agents-online-count');
  if (el) {
    const count = Object.values(state.agents).filter(a => a.online !== false).length;
    el.textContent = `${count} online`;
  }
  const meshEl = document.getElementById('mesh-peer-count');
  if (meshEl) {
    meshEl.textContent = `${Object.keys(state.agents).length} peers`;
  }
}

// ─── Mesh Canvas ──────────────────────────────────────────────────────────────
let meshCtx = null;
let meshNodes = [];
let meshEdges = [];
let meshAnimFrame = null;

function initMeshCanvas() {
  const canvas = document.getElementById('mesh-canvas');
  if (!canvas) return;
  meshCtx = canvas.getContext('2d');
  resizeMeshCanvas();
  window.addEventListener('resize', resizeMeshCanvas);
  renderMesh();
  requestAnimationFrame(meshAnimate);
}

function resizeMeshCanvas() {
  const canvas = document.getElementById('mesh-canvas');
  if (!canvas) return;
  const container = canvas.parentElement;
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;
}

function renderMesh() {
  const canvas = document.getElementById('mesh-canvas');
  if (!canvas || !meshCtx) return;

  const agents = Object.values(state.agents);
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;
  const r = Math.min(W, H) * 0.35;

  // Position agents in a circle
  meshNodes = agents.map((agent, i) => {
    const angle = (i / agents.length) * Math.PI * 2 - Math.PI / 2;
    return {
      id: agent.peerId,
      role: agent.role || 'gateway',
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      online: agent.online !== false,
      busy: ['reviewing', 'debating', 'generating'].includes(agent.status),
    };
  });

  drawMesh();
}

function drawMesh() {
  const canvas = document.getElementById('mesh-canvas');
  if (!canvas || !meshCtx) return;
  const ctx = meshCtx;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw edges
  for (let i = 0; i < meshNodes.length; i++) {
    for (let j = i + 1; j < meshNodes.length; j++) {
      const a = meshNodes[i], b = meshNodes[j];
      if (!a.online || !b.online) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = 'rgba(42,42,53,0.8)';
      ctx.lineWidth = 1;
      ctx.stroke();
      // Lock icon on line midpoint (encryption indicator)
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      ctx.font = '8px sans-serif';
      ctx.fillStyle = 'rgba(139,92,246,0.4)';
      ctx.fillText('🔒', mx - 4, my + 3);
    }
  }

  // Draw animated edges
  for (const edge of meshEdges) {
    if (Date.now() - edge.time > 2000) continue;
    const alpha = 1 - (Date.now() - edge.time) / 2000;
    ctx.beginPath();
    ctx.moveTo(edge.x1, edge.y1);
    ctx.lineTo(edge.x2, edge.y2);
    ctx.strokeStyle = edge.color + Math.round(alpha * 255).toString(16).padStart(2, '0');
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Draw nodes
  for (const node of meshNodes) {
    const color = node.role === 'redteam' ? '#EF4444'
      : ROLE_COLORS[node.role] || '#8B5CF6';

    // Glow for busy nodes
    if (node.busy) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, 22, 0, Math.PI * 2);
      ctx.fillStyle = color + '22';
      ctx.fill();
    }

    // Node circle
    ctx.beginPath();
    ctx.arc(node.x, node.y, 14, 0, Math.PI * 2);
    ctx.fillStyle = node.online ? color + '33' : '#374151';
    ctx.fill();
    ctx.strokeStyle = node.online ? color : '#4B5563';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Icon
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ROLE_ICONS[node.role] || '●', node.x, node.y);

    // Label
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillStyle = node.online ? '#f0f0f2' : '#6B7280';
    ctx.fillText(node.role, node.x, node.y + 22);
  }

  // Prune old edges
  meshEdges = meshEdges.filter(e => Date.now() - e.time < 2000);
}

function meshAnimate() {
  drawMesh();
  requestAnimationFrame(meshAnimate);
}

function renderMeshEdge(fromId, toId, color) {
  const from = meshNodes.find(n => n.id === fromId || n.role === fromId);
  const to = meshNodes.find(n => n.id === toId || n.role === toId);
  if (from && to) {
    meshEdges.push({ x1: from.x, y1: from.y, x2: to.x, y2: to.y, color: color || '#8B5CF6', time: Date.now() });
  }
}

function animateMeshGossip(topic) {
  // Briefly animate all connections to show gossip propagation
  for (let i = 0; i < meshNodes.length - 1; i++) {
    const color = topic?.includes('critical') ? '#EF4444' : '#8B5CF6';
    meshEdges.push({
      x1: meshNodes[i].x, y1: meshNodes[i].y,
      x2: meshNodes[(i + 1) % meshNodes.length].x,
      y2: meshNodes[(i + 1) % meshNodes.length].y,
      color, time: Date.now(),
    });
  }
}

// ─── QR Code ──────────────────────────────────────────────────────────────────
async function loadQRCode(url) {
  try {
    const res = await fetch('/api/qrcode');
    const data = await res.json();
    const img = document.getElementById('qr-code');
    const urlEl = document.getElementById('qr-url');
    if (img && data.qr) img.src = data.qr;
    if (urlEl && (data.url || url)) urlEl.textContent = data.url || url;
  } catch (e) { console.warn('QR code load failed', e); }
}

// ─── Controls ─────────────────────────────────────────────────────────────────
async function injectGoal() {
  const input = document.getElementById('goal-input');
  const goal = input?.value?.trim();
  if (!goal) return;
  try {
    await fetch('/api/inject-goal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal, source: 'dashboard' }),
    });
    if (input) input.value = '';
  } catch (e) { alert('Failed to inject goal: ' + e.message); }
}

async function triggerReview() {
  const input = document.getElementById('pr-url-input');
  const url = input?.value?.trim();
  if (!url) return;
  try {
    await fetch('/api/trigger-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prUrl: url }),
    });
    if (input) input.value = '';
  } catch (e) { alert('Failed to trigger review: ' + e.message); }
}

async function castVote(verdict) {
  try {
    await fetch('/api/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict, reason: 'Judge advisory vote' }),
    });
    state.votes['human'] = { verdict, confidence: 80, agentRole: 'human' };
    renderVoteBars();
  } catch (e) { alert('Failed to cast vote: ' + e.message); }
}

async function toggleOffline() {
  const newOffline = !state.offlineMode;
  try {
    await fetch('/api/offline-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: newOffline }),
    });
    state.offlineMode = newOffline;
    updateOfflineBanner();
  } catch (e) { alert('Failed to toggle offline: ' + e.message); }
}

// ─── Tab Navigation ───────────────────────────────────────────────────────────
function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.panel').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.panel === tabName);
  });
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showTxToast(txHash, action) {
  const toast = document.createElement('div');
  toast.className = 'tx-toast';
  toast.innerHTML = `⛓ ${action || 'TX'}: <code>${txHash?.slice(0, 18) || ''}...</code>`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return str.replace(/[&<>"']/g, m => map[m]);
}

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.activeElement?.id === 'goal-input') {
    injectGoal();
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  renderPipelinePhases();
  initMeshCanvas();
  renderAgentCards();
  loadQRCode();

  // Mobile: activate first tab
  if (window.innerWidth < 640) switchTab('mesh');
});
