import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import path from 'path';
import os from 'os';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { globalTEERegistry } from '../integrations/og-tee-attestation.js';

const app = express();
const httpServer = createServer(app);

export const io = new SocketIOServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'src/dashboard/public')));

// ─── Local network IP detection ───────────────────────────────────────────────

function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (!iface) continue;
    for (const info of iface) {
      if (info.family === 'IPv4' && !info.internal) {
        return info.address;
      }
    }
  }
  return 'localhost';
}

export const localIP = getLocalIP();
export const dashboardUrl = `http://${localIP}:${config.dashboard.port}`;

// ─── API endpoints ────────────────────────────────────────────────────────────

app.get('/api/qrcode', async (_req, res) => {
  try {
    const qrDataUrl = await QRCode.toDataURL(dashboardUrl, { width: 300, margin: 2 });
    res.json({ qr: qrDataUrl, url: dashboardUrl });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/status', (_req, res) => {
  res.json({
    status: 'running',
    url: dashboardUrl,
    localIP,
    port: config.dashboard.port,
    timestamp: Date.now(),
  });
});

// ─── TEE Attestation endpoints ───────────────────────────────────────────────

// Returns all TEE proof data gathered since process start:
//   providers  — one entry per 0G Compute provider, with RA verification status
//   chats      — one entry per inference call, with per-response verification status
//   summary    — aggregated counts
// The frontend uses this to show the real-time TEE verification status panel.
app.get('/api/tee-attestations', (_req, res) => {
  res.json(globalTEERegistry.toJSON());
});

// Expose the OGComputeClient provider list so the dashboard can show
// available TeeML services. Registered by gateway at startup.
let listTeeProvidersHandler: (() => Promise<unknown[]>) | null = null;
export function registerTeeProviderLister(fn: () => Promise<unknown[]>): void {
  listTeeProvidersHandler = fn;
}

app.get('/api/tee-providers', async (_req, res) => {
  try {
    const providers = listTeeProvidersHandler ? await listTeeProvidersHandler() : [];
    res.json({ providers });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Goal injection endpoint — broadcasts via AXL GossipSub
// The gateway agent registers a handler for this via injectGoalHandler
let injectGoalHandler: ((goal: string, source: string) => Promise<void>) | null = null;

export function registerGoalHandler(handler: (goal: string, source: string) => Promise<void>): void {
  injectGoalHandler = handler;
}

app.post('/api/inject-goal', async (req, res) => {
  const { goal, source = 'dashboard' } = req.body as { goal?: string; source?: string };
  if (!goal || typeof goal !== 'string' || goal.trim().length === 0) {
    res.status(400).json({ error: 'goal is required' });
    return;
  }
  try {
    if (injectGoalHandler) {
      await injectGoalHandler(goal.trim(), source);
    }
    io.emit('goal-injected', { goal: goal.trim(), source, timestamp: Date.now() });
    res.json({ success: true, goal: goal.trim() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Human advisory vote
app.post('/api/vote', (req, res) => {
  const { verdict, prHash, reason } = req.body as {
    verdict?: 'approve' | 'reject';
    prHash?: string;
    reason?: string;
  };
  if (!verdict || !['approve', 'reject'].includes(verdict)) {
    res.status(400).json({ error: 'verdict must be "approve" or "reject"' });
    return;
  }
  const vote = {
    type: 'human-vote',
    verdict,
    prHash,
    reason,
    source: 'judge',
    timestamp: Date.now(),
  };
  io.emit('human-vote', vote);
  emitMeshEvent('gossip-broadcast', {
    topic: 'adversa:human-activity',
    data: vote,
  });
  res.json({ success: true });
});

// Trigger manual review by PR URL
app.post('/api/trigger-review', (req, res) => {
  const { prUrl } = req.body as { prUrl?: string };
  if (!prUrl) {
    res.status(400).json({ error: 'prUrl is required' });
    return;
  }
  io.emit('manual-review-triggered', { prUrl, timestamp: Date.now() });
  res.json({ success: true, prUrl });
});

// Offline mode toggle (demo only)
app.post('/api/offline-mode', (req, res) => {
  const { enabled } = req.body as { enabled?: boolean };
  offlineModeEnabled = enabled ?? true;
  io.emit('offline-status', { online: !offlineModeEnabled, timestamp: Date.now() });
  res.json({ success: true, offlineMode: offlineModeEnabled });
});

let offlineModeEnabled = false;
export function isOfflineModeEnabled(): boolean { return offlineModeEnabled; }

// ─── Agent state cache (for replay on new connections) ───────────────────────

const agentStateCache = new Map<string, Record<string, unknown>>();

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', socket => {
  logger.info('Dashboard client connected', { id: socket.id });

  // Send current state on connect
  socket.emit('connected', {
    dashboardUrl,
    localIP,
    timestamp: Date.now(),
    offlineMode: offlineModeEnabled,
  });

  // Replay all currently known agents so the client sees them immediately
  for (const agent of agentStateCache.values()) {
    if (agent.online) {
      socket.emit('agent-online', { ...agent, timestamp: Date.now() });
    }
  }

  socket.on('disconnect', () => {
    logger.debug('Dashboard client disconnected', { id: socket.id });
  });
});

// ─── Event emission helpers ───────────────────────────────────────────────────

export function emitMeshEvent(event: string, data: Record<string, unknown>): void {
  const payload = { ...data, timestamp: Date.now() };

  // Keep agent state cache up to date for new-client replay
  if (event === 'agent-online') {
    const peerId = data.peerId as string;
    if (peerId) {
      agentStateCache.set(peerId, { ...agentStateCache.get(peerId), ...data, online: true });
    }
  } else if (event === 'agent-offline') {
    const peerId = data.peerId as string;
    if (peerId) {
      const existing = agentStateCache.get(peerId);
      if (existing) agentStateCache.set(peerId, { ...existing, online: false });
    }
  } else if (event === 'agent-status') {
    const peerId = data.peerId as string;
    if (peerId && agentStateCache.has(peerId)) {
      const existing = agentStateCache.get(peerId)!;
      agentStateCache.set(peerId, { ...existing, status: data.status });
    }
  }

  io.emit(event, payload);
}

// ─── Server start ─────────────────────────────────────────────────────────────

export function startDashboardServer(): Promise<void> {
  return new Promise(resolve => {
    httpServer.listen(config.dashboard.port, config.dashboard.host, () => {
      logger.info('Dashboard server started', { url: dashboardUrl });
      logger.info(`Dashboard QR code available at: ${dashboardUrl}/api/qrcode`);
      resolve();
    });
  });
}

// Allow running standalone for dashboard-only mode
if (require.main === module) {
  startDashboardServer().catch(console.error);
}
