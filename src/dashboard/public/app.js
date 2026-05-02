'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
const S = {
  agents: {},
  debateRound: 0,
  offlineMode: false,
  queueLength: 0,
  currentPhase: -1,
  votes: {},
  connected: false,
  stats: { reviews: 0, exploits: 0, teeVerified: 0 },
  tee: { total: 0, verified: 0, unverified: 0, providers: [], chats: [] },
};

const ICONS = {
  gateway: '⬡', security: '◈', performance: '◆', style: '◇', redteam: '☠', coder: '⌥',
};
const COLORS = {
  gateway: '#14B8A6', security: '#3B82F6', performance: '#F59E0B',
  style: '#8B5CF6', redteam: '#EF4444', coder: '#10B981',
};
const HEX_FILLS = {
  gateway: '#14B8A6', security: '#3B82F6', performance: '#F59E0B',
  style: '#7C3AED',  redteam: '#EF4444',  coder: '#10B981',
};

const PHASES = [
  { id: 0, name: 'Goal Injection',   detail: 'Coder receives task via GossipSub' },
  { id: 1, name: 'Topology',         detail: 'Discovering online agents' },
  { id: 2, name: 'Fan-out',          detail: 'MCP calls to all reviewers (parallel)' },
  { id: 3, name: 'Red-Team',         detail: 'Exploit scan + A2A adversarial debate' },
  { id: 4, name: 'Guardrails',       detail: 'Human presence detection' },
  { id: 5, name: 'Consensus',        detail: 'Weighted vote convergecast' },
  { id: 6, name: 'Action',           detail: 'Merge / reject + 0G Chain record' },
];

// ─── Socket ───────────────────────────────────────────────────────────────────
const socket = io({ transports: ['websocket', 'polling'] });

socket.on('connect',    () => { S.connected = true;  setConn(true); });
socket.on('disconnect', () => { S.connected = false; setConn(false); });
socket.on('connected',  d  => { S.offlineMode = d.offlineMode; syncOffline(); loadQR(d.dashboardUrl); });

// Agents
socket.on('agent-online',  d => { S.agents[d.peerId] = { ...S.agents[d.peerId], ...d, online: true, status: 'idle' }; refreshAgents(); refreshMesh(); bumpStat('agents', Object.values(S.agents).filter(a=>a.online).length, true); });
socket.on('agent-offline', d => { if (S.agents[d.peerId]) S.agents[d.peerId].online = false; refreshAgents(); refreshMesh(); });
socket.on('agent-status',  d => { if (S.agents[d.peerId]) S.agents[d.peerId].status = d.status; refreshAgents(); refreshMesh(); });

// Pipeline
socket.on('pipeline-start',    d => { S.currentPhase = 0; S.votes = {}; renderPhases(); clearVerdict(); el('pipeline-status').innerHTML = `<span class="badge badge-cyan">PR #${d.prNumber}</span>`; S.stats.reviews++; animStat('stat-reviews', S.stats.reviews); });
socket.on('pipeline-phase',    d => { S.currentPhase = d.phase; renderPhases(); });
socket.on('pipeline-complete', d => {
  S.currentPhase = 7; renderPhases();
  showVerdict(d.approved, d.confidenceScore);
  if (d.txHash) txToast(d.txHash, d.action);
  const badge = d.approved ? '<span class="badge badge-green">APPROVED</span>' : '<span class="badge badge-red">REJECTED</span>';
  el('pipeline-status').innerHTML = badge;
  if (d.exploitsFound) { S.stats.exploits += d.exploitsFound; animStat('stat-exploits', S.stats.exploits); }
});
socket.on('pipeline-error', d => {
  el('pipeline-status').innerHTML = '<span class="badge badge-red">Error</span>';
  addMsg({ fromRole: 'gateway', type: 'error', content: `Pipeline error: ${d.error}`, ts: Date.now() });
});

// Debate / MCP
socket.on('mcp-call',       d => flashEdge(d.from || 'gateway', d.to || d.toRole, '#7C3AED'));
socket.on('a2a-debate',     d => { S.debateRound++; el('debate-round').textContent = `Round ${S.debateRound}`; addMsg({ fromRole: d.fromRole || 'redteam', type: d.type, content: d.content, severity: d.severity, cvssScore: d.cvssScore, ts: d.timestamp, conf: 70, isAtk: true }); flashEdge(d.from, d.to, '#EF4444'); });
socket.on('exploit-attempt', d => addMsg({ fromRole: 'redteam', type: 'exploit_scan', content: `${d.exploitCount || 0} exploit(s) found, ${d.criticalCount || 0} critical`, ts: d.timestamp, conf: 90, isAtk: true }));
socket.on('exploit-defense', d => { addMsg({ fromRole: 'security', type: d.mitigated ? 'defense' : 'concession', content: d.evidence || 'Analyzing...', ts: d.timestamp, conf: d.confidence || 70 }); flashEdge(d.from, 'gateway', '#10B981'); });
socket.on('review-finding',  d => { if (d.teeVerified) { S.stats.teeVerified++; animStat('stat-tee', S.stats.teeVerified); } });

// Consensus
socket.on('consensus-vote',   d => { S.votes[d.agentRole] = d; renderVotes(); });
socket.on('consensus-result', d => showVerdict(d.approved, d.confidenceScore));

// Offline / chain
socket.on('offline-status', d => { S.offlineMode = !d.online; syncOffline(); });
socket.on('action-queued',  d => { S.queueLength = d.queueLength; syncOffline(); addMsg({ fromRole: 'gateway', type: 'queue', content: `Queued: ${d.actionType} (${d.queueLength} total)`, ts: Date.now() }); });
socket.on('action-synced',  d => { S.queueLength = d.remaining; syncOffline(); });
socket.on('sync-complete',  d => { S.queueLength = 0; syncOffline(); addMsg({ fromRole: 'gateway', type: 'sync', content: `Sync complete — ${d.completed} actions replayed`, ts: Date.now() }); });
socket.on('chain-tx',       d => { txToast(d.txHash, d.action); addMsg({ fromRole: 'gateway', type: 'chain-tx', content: `On-chain: ${d.action} — ${d.txHash?.slice(0,20)}...`, ts: Date.now() }); });
socket.on('inft-update',    d => { const a = Object.values(S.agents).find(x=>x.role===d.role); if(a) a.evolutionCount=(a.evolutionCount||0)+1; refreshAgents(); addMsg({ fromRole: d.role, type: 'inft', content: `iNFT ${d.action}: ${d.role} agent (evolution #${d.version||'?'})`, ts: Date.now() }); });
socket.on('human-detected', d => addMsg({ fromRole: 'human', type: 'human', content: `Human detected — auto-merge paused. ${d.reason||''}`, ts: Date.now() }));
socket.on('goal-injected',  d => addMsg({ fromRole: d.source || 'dashboard', type: 'goal', content: `Goal: "${d.goal}"`, ts: d.timestamp }));
socket.on('gossip-broadcast', d => meshGossip(d.topic));

// TEE
socket.on('tee-attestation', d => {
  if (d.totalInferences !== undefined) {
    S.tee.total    = d.totalInferences;
    S.tee.verified = d.verified;
    S.tee.unverified = d.unverified;
    syncTEE();
  }
  S.stats.teeVerified = d.verified || S.stats.teeVerified;
  animStat('stat-tee', S.stats.teeVerified);
});

// ─── Connectivity ─────────────────────────────────────────────────────────────
function setConn(on) {
  const dot = el('conn-dot'), txt = el('conn-text');
  if (dot) dot.className = 'conn-dot ' + (on ? 'online' : 'offline');
  if (txt) txt.textContent = on ? 'Connected' : 'Disconnected';
}

function syncOffline() {
  const banner = el('offline-banner');
  if (banner) banner.classList.toggle('hidden', !S.offlineMode);
  const qc = el('queue-count'); if(qc) qc.textContent = `${S.queueLength} queued`;
  const tog = el('offline-toggle');
  if (tog) { tog.textContent = S.offlineMode ? 'Restore Internet' : 'Kill Internet'; tog.className = 'cmd-btn ' + (S.offlineMode ? 'secondary' : 'danger'); }
  const headTog = el('offline-toggle-header');
  if (headTog) {
    headTog.textContent = S.offlineMode ? 'Restore Internet' : 'Kill Internet';
    headTog.className = 'offline-header-btn ' + (S.offlineMode ? 'online' : '');
  }
  const ts = el('toggle-status');
  if (ts) { ts.textContent = S.offlineMode ? 'MESH ONLY' : 'Connected'; ts.style.color = S.offlineMode ? '#F59E0B' : '#10B981'; }
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function animStat(id, val, replace) {
  const e = el(id);
  if (!e) return;
  e.textContent = val;
  e.classList.add('stat-flash');
  setTimeout(() => e.classList.remove('stat-flash'), 500);
}
function bumpStat(key, val) {
  const map = { agents: 'stat-agents', reviews: 'stat-reviews', exploits: 'stat-exploits', tee: 'stat-tee' };
  animStat(map[key], val);
}

// ─── Phases ───────────────────────────────────────────────────────────────────
function renderPhases() {
  const c = el('pipeline-phases'); if (!c) return;
  c.innerHTML = PHASES.map(p => {
    const cls = p.id < S.currentPhase ? 'complete' : p.id === S.currentPhase ? 'active' : '';
    const numContent = cls === 'complete' ? '✓' : cls === 'active' ? '▸' : p.id;
    return `<div class="phase-step ${cls}">
      <div class="phase-num">${numContent}</div>
      <div class="phase-info">
        <div class="phase-name">${p.name}</div>
        <div class="phase-detail">${p.detail}</div>
      </div>
    </div>`;
  }).join('');
}

function clearVerdict() {
  const r = el('consensus-result'); if(r){ r.className='consensus-verdict hidden'; r.textContent=''; }
  const c = el('consensus-confidence'); if(c) c.textContent = '—';
}

function showVerdict(approved, score) {
  const r = el('consensus-result'); if (!r) return;
  const pct = ((score||0)/100).toFixed(1);
  r.className = `consensus-verdict ${approved ? 'approved' : 'rejected'}`;
  r.innerHTML = `${approved ? '◉ APPROVED' : '✕ REJECTED'}<br><small style="font-size:11px;font-weight:400;letter-spacing:1px">${pct}% CONFIDENCE</small>`;
  const c = el('consensus-confidence'); if(c) c.textContent = `${pct}%`;
}

// ─── Vote Bars ────────────────────────────────────────────────────────────────
function renderVotes() {
  const c = el('vote-bars'); if (!c) return;
  const weights = { redteam:4, security:3, performance:2, style:1, human:2, coder:1 };
  const order   = ['redteam','security','performance','style','human'];
  c.innerHTML = order.filter(r => S.votes[r]).map(r => {
    const v = S.votes[r];
    const isOk = v.verdict === 'approve';
    const pct = Math.min(100, v.confidence || 70);
    const fillCls = r==='redteam' ? 'redteam' : r==='security' ? 'security' : (isOk ? 'approve' : 'reject');
    return `<div class="vote-row">
      <div class="vote-lbl">${ICONS[r]||'●'} ${r}</div>
      <div class="vote-track"><div class="vote-fill ${fillCls}" style="width:${pct}%"></div></div>
      <div class="vote-w">${weights[r]||1}×</div>
    </div>`;
  }).join('');
}

// ─── Debate / Terminal Feed ───────────────────────────────────────────────────
function addMsg(msg) {
  const feed = el('debate-feed'); if (!feed) return;
  const empty = feed.querySelector('.terminal-empty'); if (empty) empty.remove();

  const role = msg.fromRole || 'gateway';
  const conf = msg.conf !== undefined ? msg.conf : (msg.confidence || 70);
  const lvl  = conf >= 80 ? 'high' : conf >= 50 ? 'medium' : 'low';

  const typeMap = {
    exploit_challenge: '⚔ ATTACK', counter_attack: '⚔ COUNTER',
    defense: '◈ DEFENSE',          concession: '⚠ CONCEDE',
    exploit_scan: '◉ SCANNING',    queue: '▣ QUEUE',
    sync: '↺ SYNC',                'chain-tx': '⛓ CHAIN',
    inft: '◈ iNFT',                human: '◎ HUMAN',
    goal: '▸ GOAL',                error: '✕ ERROR',
  };
  const label = typeMap[msg.type] || msg.type || 'INFO';
  const time = new Date(msg.ts || Date.now()).toLocaleTimeString('en', { hour12: false });
  const sev = msg.severity ? ` <span class="chip ${msg.severity==='critical'||msg.severity==='high'?'crit':'medium'}">${msg.severity.toUpperCase()}</span>` : '';

  const div = document.createElement('div');
  div.className = `t-msg ${role}`;
  div.innerHTML = `
    <div class="t-header">
      <span class="t-role" style="color:${COLORS[role]||'#888'}">${label}${sev}</span>
      <span class="t-role" style="color:${COLORS[role]||'#888'};font-size:9px;opacity:0.7"> ← ${role}</span>
      <span class="t-time">${time}</span>
    </div>
    <div class="t-body">${esc(String(msg.content||'')).slice(0,400)}</div>
    ${conf!==undefined ? `<div class="t-conf">conf: <span class="chip ${lvl}">${conf}%</span></div>` : ''}
  `;
  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
  if (feed.children.length > 120) feed.children[0].remove();
}

// ─── Agent Cards ──────────────────────────────────────────────────────────────
function refreshAgents() {
  const c = el('agent-cards'); if (!c) return;
  const agents = Object.values(S.agents);
  if (!agents.length) {
    c.innerHTML = '<div style="color:var(--text-3);padding:20px;text-align:center;font-family:var(--mono);font-size:11px">Waiting for agents...</div>';
    return;
  }
  c.innerHTML = agents.map(a => {
    const role = a.role || 'gateway';
    const on   = a.online !== false;
    const busy = ['reviewing','debating','generating'].includes(a.status);
    const cls  = on ? (busy ? 'busy' : 'online') : 'offline';
    const fill = HEX_FILLS[role] || '#7C3AED';
    const dotColor = busy ? '#F59E0B' : on ? '#10B981' : '#374151';
    const stateLabel = busy ? a.status : (on ? 'idle' : 'offline');
    return `<div class="agent-card ${cls}">
      <div class="agent-hex">
        <svg class="hex-bg" viewBox="0 0 42 42">
          <polygon points="21,2 38,10.5 38,31.5 21,40 4,31.5 4,10.5"
            fill="${fill}22" stroke="${fill}" stroke-width="1.2" stroke-linejoin="round"/>
          ${busy ? `<polygon points="21,2 38,10.5 38,31.5 21,40 4,31.5 4,10.5" fill="none" stroke="${fill}" stroke-width="1" stroke-linejoin="round" opacity="0.4"><animate attributeName="stroke-opacity" values="0.4;0.9;0.4" dur="1.5s" repeatCount="indefinite"/></polygon>` : ''}
        </svg>
        <span class="agent-hex-icon">${ICONS[role]||'●'}</span>
      </div>
      <div class="agent-info">
        <div class="agent-name" style="color:${fill}">${role}</div>
        <div class="agent-peer">${(a.peerId||'').slice(0,20)}…</div>
        <div class="agent-state">
          <span class="state-dot" style="background:${dotColor};box-shadow:0 0 5px ${dotColor}"></span>
          <span class="state-label">${stateLabel}</span>
        </div>
      </div>
      <div class="agent-stats">
        <div class="rep-score">${a.reputationScore||0}</div>
        ${a.teeVerified ? '<div class="tee-chip">TEE ✓</div>' : ''}
        ${a.evolutionCount ? `<div class="evo-label">v${a.evolutionCount}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  const cnt = agents.filter(a=>a.online!==false).length;
  const ce = el('agents-online-count'); if(ce) ce.innerHTML = `<span class="badge badge-green">${cnt} online</span>`;
  el('mesh-peer-count').innerHTML = `<span class="badge badge-violet">${agents.length} peers</span>`;
  animStat('stat-agents', cnt);
}

function refreshAgents_noop() {}

// ─── Mesh Canvas ──────────────────────────────────────────────────────────────
let mCtx, mNodes = [], mEdges = [], mPackets = [];

function initMesh() {
  const cv = el('mesh-canvas'); if (!cv) return;
  mCtx = cv.getContext('2d');
  sizeMesh();
  window.addEventListener('resize', sizeMesh);
  requestAnimationFrame(animMesh);
}

function sizeMesh() {
  const cv = el('mesh-canvas'); if (!cv) return;
  const p = cv.parentElement;
  cv.width  = p.clientWidth;
  cv.height = p.clientHeight;
}

function refreshMesh() {
  const cv = el('mesh-canvas'); if (!cv || !mCtx) return;
  const agents = Object.values(S.agents);
  const W = cv.width, H = cv.height;
  const cx = W/2, cy = H/2;
  const r  = Math.min(W, H) * 0.36;

  mNodes = agents.map((a, i) => {
    const angle = (i / Math.max(agents.length,1)) * Math.PI * 2 - Math.PI/2;
    return {
      id: a.peerId, role: a.role||'gateway',
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      on: a.online !== false,
      busy: ['reviewing','debating','generating'].includes(a.status),
      t: 0,
    };
  });
}

function flashEdge(fromId, toId, color) {
  const a = mNodes.find(n => n.id===fromId || n.role===fromId);
  const b = mNodes.find(n => n.id===toId   || n.role===toId);
  if (!a || !b) return;
  mEdges.push({ x1:a.x,y1:a.y, x2:b.x,y2:b.y, color, born:Date.now() });
  // Launch a data packet
  mPackets.push({ x:a.x,y:a.y, tx:b.x,ty:b.y, x0:a.x,y0:a.y, color, born:Date.now(), dur:1000+Math.random()*500 });
}

function meshGossip(topic) {
  const color = topic?.includes('critical') ? '#EF4444' : '#7C3AED';
  for (let i=0; i<mNodes.length-1; i++) {
    const a = mNodes[i], b = mNodes[(i+1)%mNodes.length];
    mEdges.push({ x1:a.x,y1:a.y,x2:b.x,y2:b.y,color,born:Date.now() });
  }
}

function animMesh() {
  requestAnimationFrame(animMesh);
  const cv = el('mesh-canvas'); if(!cv||!mCtx) return;
  const ctx = mCtx;
  const now = Date.now();
  ctx.clearRect(0,0,cv.width,cv.height);

  // Draw static edges (dark mesh lines)
  for (let i=0; i<mNodes.length; i++) {
    for (let j=i+1; j<mNodes.length; j++) {
      const a=mNodes[i], b=mNodes[j];
      if (!a.on || !b.on) continue;
      ctx.beginPath();
      ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y);
      ctx.strokeStyle = 'rgba(100,80,200,0.08)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // Draw animated flash edges
  mEdges = mEdges.filter(e => now-e.born < 1800);
  for (const e of mEdges) {
    const alpha = 1 - (now-e.born)/1800;
    ctx.beginPath();
    ctx.moveTo(e.x1,e.y1); ctx.lineTo(e.x2,e.y2);
    ctx.strokeStyle = e.color + hex2(Math.round(alpha*180));
    ctx.lineWidth = 1.5;
    ctx.shadowColor = e.color;
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // Draw traveling data packets
  mPackets = mPackets.filter(p => now-p.born < p.dur);
  for (const p of mPackets) {
    const t = (now-p.born)/p.dur;
    const x = p.x0 + (p.tx-p.x0)*t;
    const y = p.y0 + (p.ty-p.y0)*t;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI*2);
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;
    // Trail
    ctx.beginPath();
    const tx0 = p.x0 + (p.tx-p.x0)*Math.max(0,t-0.15);
    const ty0 = p.y0 + (p.ty-p.y0)*Math.max(0,t-0.15);
    ctx.moveTo(tx0,ty0); ctx.lineTo(x,y);
    ctx.strokeStyle = p.color + '44';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Draw nodes
  for (const n of mNodes) {
    const col = COLORS[n.role] || '#7C3AED';
    const R = 18;

    // Outer glow for busy/active
    if (n.busy || n.on) {
      const grd = ctx.createRadialGradient(n.x,n.y,R,n.x,n.y,R*2.2);
      grd.addColorStop(0, col + (n.busy ? '44' : '22'));
      grd.addColorStop(1, col + '00');
      ctx.beginPath();
      ctx.arc(n.x,n.y,R*2.2,0,Math.PI*2);
      ctx.fillStyle = grd;
      ctx.fill();
    }

    // Hex shape
    ctx.beginPath();
    for (let k=0; k<6; k++) {
      const a = (k*Math.PI/3) - Math.PI/6;
      k===0 ? ctx.moveTo(n.x+R*Math.cos(a),n.y+R*Math.sin(a))
             : ctx.lineTo(n.x+R*Math.cos(a),n.y+R*Math.sin(a));
    }
    ctx.closePath();
    ctx.fillStyle = n.on ? col+'22' : '#1a1a2e';
    ctx.fill();
    ctx.strokeStyle = n.on ? col : '#2a2a40';
    ctx.lineWidth = n.busy ? 2 : 1.5;
    if (n.busy) { ctx.shadowColor = col; ctx.shadowBlur = 12; }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Icon
    ctx.font = '13px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = n.on ? '#fff' : '#44445a';
    ctx.fillText(ICONS[n.role]||'●', n.x, n.y);

    // Label
    ctx.font = '9px "JetBrains Mono",monospace';
    ctx.fillStyle = n.on ? col : '#44445a';
    ctx.fillText(n.role.toUpperCase(), n.x, n.y + R + 9);
  }
}

function hex2(v) { return Math.max(0,Math.min(255,v)).toString(16).padStart(2,'0'); }

// ─── Particle Background Canvas ───────────────────────────────────────────────
let bgCtx, bgParticles = [];

function initBg() {
  const cv = el('bg-canvas'); if (!cv) return;
  bgCtx = cv.getContext('2d');
  sizeBg();
  window.addEventListener('resize', sizeBg);

  // Spawn particles
  for (let i=0; i<80; i++) {
    bgParticles.push({
      x: Math.random() * cv.width,
      y: Math.random() * cv.height,
      r: 0.8 + Math.random() * 1.4,
      vx: (Math.random()-0.5)*0.25,
      vy: (Math.random()-0.5)*0.25,
      a: Math.random(),
    });
  }
  requestAnimationFrame(animBg);
}

function sizeBg() {
  const cv = el('bg-canvas'); if (!cv) return;
  cv.width  = window.innerWidth;
  cv.height = window.innerHeight;
}

function animBg() {
  requestAnimationFrame(animBg);
  const cv = el('bg-canvas'); if (!cv||!bgCtx) return;
  const ctx = bgCtx;
  const W = cv.width, H = cv.height;
  ctx.clearRect(0,0,W,H);

  // Update & draw particles
  for (const p of bgParticles) {
    p.x += p.vx; p.y += p.vy;
    if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
    if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
    ctx.fillStyle = `rgba(124,58,237,${0.3+p.a*0.3})`;
    ctx.fill();
  }

  // Draw connections between nearby particles
  for (let i=0; i<bgParticles.length; i++) {
    for (let j=i+1; j<bgParticles.length; j++) {
      const a=bgParticles[i], b=bgParticles[j];
      const dx=a.x-b.x, dy=a.y-b.y, dist=Math.sqrt(dx*dx+dy*dy);
      if (dist < 120) {
        ctx.beginPath();
        ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y);
        ctx.strokeStyle = `rgba(124,58,237,${(1-dist/120)*0.08})`;
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }
    }
  }
}

// ─── TEE Panel ────────────────────────────────────────────────────────────────
async function loadTEEProviders() {
  try {
    const res = await fetch('/api/tee-providers');
    const data = await res.json();
    renderTEEProviders(data.providers || []);
  } catch {}
}

async function refreshTEEAttestations() {
  try {
    const res = await fetch('/api/tee-attestations');
    const data = await res.json();
    S.tee = { ...S.tee, ...data.summary, providers: data.providers||[], chats: data.chats||[] };
    syncTEE();
  } catch {}
}

function syncTEE() {
  const t = S.tee;
  setT('tee-total', t.totalInferences||t.total||0);
  setT('tee-ok',    t.verified||0);
  setT('tee-fail',  t.unverified||0);
  el('tee-verified-badge').innerHTML = `<span class="badge badge-teal">${t.verified||0} verified</span>`;

  // Render recent chats
  const cl = el('tee-chat-list');
  if (cl && t.chats?.length) {
    cl.innerHTML = t.chats.slice(-8).reverse().map(c => {
      const dotCls = c.responseVerified===true?'ok':c.responseVerified===false?'no':'unk';
      const time = new Date(c.timestamp).toLocaleTimeString('en',{hour12:false});
      return `<div class="tee-chat-item">
        <span class="tee-chat-dot ${dotCls}"></span>
        <span class="tee-chat-id">${c.chatId}</span>
        <span class="tee-chat-time">${time}</span>
      </div>`;
    }).join('');
  }

  if (t.providers?.length) renderTEEProviders(t.providers);
}

function renderTEEProviders(providers) {
  const c = el('tee-provider-list'); if (!c) return;
  if (!providers.length) { c.innerHTML = '<div class="tee-empty-msg">No providers registered yet</div>'; return; }
  c.innerHTML = providers.map(p => {
    const vCls = p.serviceVerified===true?'ok':p.serviceVerified===false?'no':'unk';
    const vLbl = p.serviceVerified===true?'TDX ✓':p.serviceVerified===false?'FAILED':'UNVERIFIED';
    const addr = p.provider||p.providerAddress||'';
    return `<div class="tee-provider-item">
      <div class="tee-provider-icon">🔒</div>
      <div class="tee-provider-info">
        <div class="tee-provider-model">${p.model||'Unknown model'}</div>
        <div class="tee-provider-addr">${addr.slice(0,20)}…</div>
        <div class="tee-provider-type">${p.verifiability||p.serviceType||'—'} · ${p.inputPrice?p.inputPrice+' /tok':''}</div>
      </div>
      <div class="tee-verify-badge ${vCls}">${vLbl}</div>
    </div>`;
  }).join('');
}

// ─── QR Code ──────────────────────────────────────────────────────────────────
async function loadQR() {
  try {
    const d = await (await fetch('/api/qrcode')).json();
    const img = el('qr-code'), url = el('qr-url');
    if (img && d.qr) img.src = d.qr;
    if (url && d.url) url.textContent = d.url;
  } catch {}
}

// ─── Controls ─────────────────────────────────────────────────────────────────
async function injectGoal() {
  const inp = el('goal-input');
  const goal = inp?.value?.trim(); if (!goal) return;
  try {
    await post('/api/inject-goal', { goal, source: 'dashboard' });
    inp.value = '';
  } catch(e) { alert('Failed: ' + e.message); }
}

async function triggerReview() {
  const inp = el('pr-url-input');
  const url = inp?.value?.trim(); if (!url) return;
  try {
    await post('/api/trigger-review', { prUrl: url });
    inp.value = '';
  } catch(e) { alert('Failed: ' + e.message); }
}

async function castVote(verdict) {
  try {
    await post('/api/vote', { verdict, reason: 'Judge advisory vote' });
    S.votes['human'] = { verdict, confidence: 80, agentRole: 'human' };
    renderVotes();
  } catch(e) { alert('Failed: ' + e.message); }
}

async function toggleOffline() {
  try {
    const newOff = !S.offlineMode;
    await post('/api/offline-mode', { enabled: newOff });
    S.offlineMode = newOff; syncOffline();
  } catch(e) { alert('Failed: ' + e.message); }
}

// ─── Tab Nav ──────────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab===name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel===name));
  if (name === 'mesh') { sizeMesh(); refreshMesh(); }
  if (name === 'tee')  { refreshTEEAttestations(); }
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function txToast(hash, action) {
  const t = document.createElement('div');
  t.className = 'tx-toast';
  t.innerHTML = `⛓ ${action||'TX'}: <code style="color:var(--cyan-l)">${hash?.slice(0,22)||''}…</code>`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const el  = id => document.getElementById(id);
const setT = (id, v) => { const e=el(id); if(e) e.textContent=v; };
const post = (url, body) => fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
function esc(s) {
  return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.key==='Enter' && document.activeElement?.id==='goal-input') injectGoal();
  if (e.key==='Enter' && document.activeElement?.id==='pr-url-input') triggerReview();
});

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initBg();
  renderPhases();
  initMesh();
  refreshAgents();
  loadQR();
  loadTEEProviders();

  // Poll TEE attestations every 15s
  setInterval(refreshTEEAttestations, 15000);

  if (window.innerWidth < 640) switchTab('mesh');

  // Add stat-flash keyframe dynamically
  const style = document.createElement('style');
  style.textContent = `@keyframes stat-flash{0%{transform:scale(1)}50%{transform:scale(1.25);opacity:0.7}100%{transform:scale(1)}} .stat-flash{animation:stat-flash 0.4s ease;}`;
  document.head.appendChild(style);
});
