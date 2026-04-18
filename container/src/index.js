/**
 * Claude Signal Bridge — Docker container.
 * Connects to Signal via WebSocket (json-rpc mode), forwards messages to Claude PTY hosts,
 * sends responses back via Signal. Supports multiple profiles, each with its own CLI.
 */

import express from 'express';
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import {
  getDb, getSetting, setSetting, getAllSettings,
  getProfiles, getProfile, createProfile, updateProfile, deleteProfile,
  upsertGroupName, getGroupNames,
  logMessage, getMessageLog
} from './db.js';
import { renderPage } from './ui.js';

const ATTACHMENT_DIR = '/app/attachments';
const ATTACHMENT_HOST_DIR = process.env.ATTACHMENT_HOST_DIR || '';
const WEB_PORT = parseInt(process.env.WEB_PORT || '3100');
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'claude-signal-bridge-s3cret';
const hostHeaders = { 'Content-Type': 'application/json', 'X-Bridge-Secret': BRIDGE_SECRET };

// --- Per-Profile State ---
// Map<profileId, { profile, awaitingPermission, messageQueue, processing, hostUrl }>
const profileStates = new Map();

function loadProfileStates() {
  const profiles = getProfiles();
  // Remove stale profiles
  for (const [id] of profileStates) {
    if (!profiles.some(p => p.id === id)) profileStates.delete(id);
  }
  // Add/update profiles
  for (const profile of profiles) {
    const existing = profileStates.get(profile.id);
    if (existing) {
      existing.profile = profile;
      existing.hostUrl = `http://host.docker.internal:${profile.host_port}`;
    } else {
      profileStates.set(profile.id, {
        profile,
        awaitingPermission: false,
        messageQueue: [],
        processing: false,
        hostUrl: `http://host.docker.internal:${profile.host_port}`,
      });
    }
  }
  console.log(`[Bridge] Loaded ${profileStates.size} profile(s): ${[...profileStates.keys()].join(', ')}`);
}

// --- Signal WebSocket ---
let ws = null;
let wsConnected = false;
let reconnectTimer = null;

function connectSignal() {
  const apiUrl = getSetting('signal_api_url');
  const sender = getSetting('signal_sender');
  if (!apiUrl || !sender) {
    console.error('[Signal] Missing API URL or sender number');
    scheduleReconnect();
    return;
  }

  const wsUrl = apiUrl.replace(/^http/, 'ws') + `/v1/receive/${encodeURIComponent(sender)}`;
  console.log(`[Signal] Connecting WebSocket: ${wsUrl}`);

  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    wsConnected = true;
    console.log('[Signal] WebSocket connected — listening for messages');
  });

  ws.on('message', async (data) => {
    try {
      const envelope = JSON.parse(data.toString());
      await handleMessage(envelope);
    } catch (err) {
      console.error(`[Signal] Message parse error: ${err.message}`);
    }
  });

  ws.on('close', (code, reason) => {
    wsConnected = false;
    console.log(`[Signal] WebSocket closed (${code}): ${reason || 'no reason'}`);
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    wsConnected = false;
    console.error(`[Signal] WebSocket error: ${err.message}`);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (getSetting('enabled') === 'true') {
      console.log('[Signal] Reconnecting...');
      connectSignal();
    }
  }, 5000);
}

function disconnectSignal() {
  if (ws) { ws.removeAllListeners(); ws.close(); ws = null; }
  wsConnected = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

// --- Signal Send ---

async function signalSend(recipient, message) {
  const apiUrl = getSetting('signal_api_url');
  const sender = getSetting('signal_sender');
  if (!apiUrl || !sender) return false;

  try {
    const chunks = splitMessage(message, 4000);
    for (const chunk of chunks) {
      let body;
      if (recipient.startsWith('group.')) {
        const internalId = recipient.substring(6);
        const encodedId = Buffer.from(internalId).toString('base64');
        body = JSON.stringify({ message: chunk, number: sender, recipients: [`group.${encodedId}`] });
      } else {
        body = JSON.stringify({ message: chunk, number: sender, recipients: [recipient] });
      }

      const res = await fetch(`${apiUrl}/v2/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.error(`[Signal] Send failed: ${res.status} ${errText}`);
        return false;
      }
    }
    return true;
  } catch (err) {
    console.error(`[Signal] Send error: ${err.message}`);
    return false;
  }
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    let idx = remaining.lastIndexOf('\n', maxLen);
    if (idx < maxLen * 0.5) idx = maxLen;
    chunks.push(remaining.substring(0, idx));
    remaining = remaining.substring(idx).trimStart();
  }
  return chunks;
}

// --- Attachments ---

async function downloadAttachment(attachmentId, contentType) {
  const apiUrl = getSetting('signal_api_url');
  if (!apiUrl) return null;

  try {
    const ext = contentType?.includes('png') ? 'png'
      : contentType?.includes('gif') ? 'gif'
      : contentType?.includes('webp') ? 'webp' : 'jpg';
    const filename = `${attachmentId}.${ext}`;
    const localPath = path.join(ATTACHMENT_DIR, filename);
    const hostPath = path.join(ATTACHMENT_HOST_DIR, filename);

    const res = await fetch(`${apiUrl}/v1/attachments/${attachmentId}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.error(`[Attachment] Download failed: ${res.status}`);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(localPath, buffer);
    console.log(`[Attachment] Saved ${filename} (${buffer.length} bytes)`);
    return { filename, localPath, hostPath, size: buffer.length };
  } catch (err) {
    console.error(`[Attachment] Error: ${err.message}`);
    return null;
  }
}

// --- Response cleanup for Signal ---

function cleanForSignal(text) {
  const filters = [
    t => /^[✶✻✽✢·*●✦○◌◍◉⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*\S+…\s*$/.test(t) && 'spinner',
    t => /^[─╭╮╰╯│┌┐└┘┤├┬┴┼═]+$/.test(t) && 'box-drawing',
    t => /^[╭╮╰╯]─/.test(t) && 'box-drawing',
    t => /─{5,}/.test(t) && 'box-drawing',
    t => /╌{5,}/.test(t) && 'box-drawing',
    t => /Claude Code v\d/i.test(t) && 'cc-version',
    t => /Share Claude Code/i.test(t) && 'cc-promo',
    t => (/\/passes/i.test(t) && t.length < 30) && 'cc-passes',
    t => /earn.*\$\d+/i.test(t) && 'cc-earn-promo',
    t => /^[▝▜█▛▘▐▌\s\[\]✻·]+$/.test(t) && 'ascii-art',
    t => /~\\Documents\\/i.test(t) && 'path-leak',
    t => (/^not use\b/i.test(t) && t.length < 40) && 'ui-phrase',
    t => /^"[^"]{1,30}"[)\s]*$/.test(t) && 'quoted-phrase',
    t => /^⎿/.test(t) && 'tool-result',
    t => /^●?\s*(Bash|Read|Write|Edit|Update|Glob|Grep|Agent|WebSearch|WebFetch)\(/.test(t) && 'tool-call',
    t => /^(Running|Waiting|Reading|Writing|Searching)…/.test(t) && 'tool-status',
    t => /^(Everything up-to-date|No output|\(No output\))$/i.test(t) && 'tool-empty',
    t => (/\d+.*\|.*\d+/.test(t) && (t.match(/\|/g) || []).length >= 2) && 'pipe-data',
    t => /^[0-9a-f]{7,}\s+/i.test(t) && 'git-hash',
    t => /^Error: Exit code \d+/i.test(t) && 'exit-code',
    t => /^\d+\s*[-+]/.test(t) && 'diff-line',
    t => (/^\d+\s*$/.test(t) && t.length < 5) && 'line-number',
    t => /^\d+\s+##/.test(t) && 'diff-header',
    t => /^\d+\s+[<‹]/.test(t) && 'diff-bracket',
    t => /^\d+\s+\|/.test(t) && 'diff-pipe',
    t => /^[<‹]!--/.test(t) && 'html-comment',
    t => /<!--.*-->/.test(t) && 'html-comment',
    t => (/^#+\s/.test(t) && t.length < 60) && 'md-header',
    t => /^\|.*\|/.test(t) && 'md-table',
    t => (/format:/i.test(t) && t.length < 80) && 'format-line',
    t => /^(Updated|Created|Wrote|Saved|Edit file|Create file)\s/i.test(t) && 'file-notification',
    t => (/\.(md|json|txt|js|ts)\s*$/.test(t) && t.length < 40) && 'file-extension',
    t => /^(Balances|Cooldowns|Inventories|Achievements|Quests|Pets|Farms|Fish)\s*$/i.test(t) && 'section-marker',
    t => /^\s*"(args|headers|origin|url|Host|Accept|User-Agent|Content-Type)"/.test(t) && 'json-fragment',
    t => /^\s*[\{\}\[\]]$/.test(t) && 'json-bracket',
    t => /^[✶✻✽✢·*●✦○◌◍◉⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*.+\s+for\s+\d+/i.test(t) && 'spinner-timing',
    t => /ctrl\+o to expand/i.test(t) && 'expand-hint',
    t => /lines \(ctrl\+/i.test(t) && 'expand-hint',
    t => /esc\s*to\s*interrupt/i.test(t) && 'shortcut-hint',
    t => /for\s*shortcuts/i.test(t) && 'shortcut-hint',
    t => /ctrl\+[a-z]\s+to\s+/i.test(t) && 'shortcut-hint',
    t => /Enter to select.*navigate.*cancel/i.test(t) && 'shortcut-hint',
    t => /Claude Code has switched/i.test(t) && 'cc-notice',
    t => /claude install/i.test(t) && 'cc-notice',
    t => /clau\.de\//i.test(t) && 'cc-link',
    t => /Opus.*context|Sonnet.*context/i.test(t) && 'model-line',
    t => /^\[[\+0-9a-f-]{10,}\]/i.test(t) && 'sender-id-leak',
    t => /^❯/.test(t) && 'prompt',
    t => /^>\s*$/.test(t) && 'prompt',
    t => /^X+$/.test(t) && 'x-line',
    t => /↑\/↓\s*to\s*navigate/i.test(t) && 'nav-hint',
    t => /^☐\s/.test(t) && 'checkbox',
    t => /timeout\s+\d+[ms]/i.test(t) && 'timeout-hint',
    t => /ctrl\+b to run in background/i.test(t) && 'background-hint',
  ];

  const filtered = [];

  const result = text.split('\n').filter(line => {
    const t = line.trim();
    if (!t) return true;
    for (const filter of filters) {
      const reason = filter(t);
      if (reason) {
        filtered.push({ reason, line: t.substring(0, 120) });
        return false;
      }
    }
    return true;
  }).join('\n');

  // Log filtered lines to persistent file
  if (filtered.length > 0) {
    const trivial = new Set(['box-drawing', 'spinner', 'tool-result', 'tool-call', 'tool-status',
      'prompt', 'shortcut-hint', 'expand-hint', 'nav-hint', 'spinner-timing',
      'cc-version', 'cc-promo', 'cc-notice', 'cc-link', 'model-line',
      'background-hint', 'timeout-hint', 'ascii-art', 'x-line']);
    const interesting = filtered.filter(f => !trivial.has(f.reason));
    if (interesting.length > 0) {
      try {
        let entry = `[${new Date().toLocaleString()}] Dropped ${filtered.length} lines (${interesting.length} notable):\n`;
        for (const f of interesting) entry += `  [${f.reason}] ${f.line}\n`;
        fs.appendFileSync('/app/logs/filter-debug.log', entry + '\n');
      } catch {}
      console.log(`[Filter] Dropped ${filtered.length} lines (${interesting.length} notable)`);
    }
  }

  return result
  .replace(/\[\+?\d{10,}\]/g, '')
  .replace(/\[[0-9a-f-]{20,}\]/gi, '')
  .replace(/[✶✻✽✢·*●✦○◌◍◉]\s*\S+…/g, '')
  .replace(/\s{3,}/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();
}

// --- Profile Routing ---

function normalizeNumber(num) {
  return num.replace(/[\s-]/g, '');
}

function numberInList(source, list) {
  if (!list) return false;
  const numbers = list.split(',').map(s => s.trim()).filter(Boolean);
  if (numbers.length === 0) return true; // empty list = allow all
  const normalized = normalizeNumber(source);
  return numbers.some(n => normalizeNumber(n) === normalized || n === source);
}

function findProfileForGroup(groupId) {
  for (const [, state] of profileStates) {
    if (!state.profile.enabled) continue;
    const groups = state.profile.allowed_groups.split(',').map(s => s.trim()).filter(Boolean);
    if (groups.includes(groupId)) return state;
  }
  return null;
}

function findProfileForDM(source, body) {
  const trimmed = body.trim();

  // Check all DM-enabled profiles for prefix match
  for (const [, state] of profileStates) {
    if (!state.profile.enabled || !state.profile.dm_enabled) continue;
    if (!numberInList(source, state.profile.allowed_numbers)) continue;

    const prefix = state.profile.prefix;
    const prefixRegex = new RegExp(`^${prefix}\\b`, 'i');
    if (prefixRegex.test(trimmed)) return state;
  }

  // No prefix match — find a default (single DM-enabled profile for this sender)
  const candidates = [];
  for (const [, state] of profileStates) {
    if (!state.profile.enabled || !state.profile.dm_enabled) continue;
    if (numberInList(source, state.profile.allowed_numbers)) candidates.push(state);
  }
  if (candidates.length === 1) return candidates[0];

  return null;
}

function findProfileAwaitingPermission(source, groupId) {
  for (const [, state] of profileStates) {
    if (!state.awaitingPermission) continue;
    if (groupId) {
      const groups = state.profile.allowed_groups.split(',').map(s => s.trim()).filter(Boolean);
      if (groups.includes(groupId)) return state;
    } else {
      if (numberInList(source, state.profile.approval_numbers)) return state;
    }
  }
  return null;
}

// --- Claude Communication (per-profile) ---

async function sendToClaudeStreaming(state, text, replyTo) {
  const { hostUrl, profile } = state;

  // If awaiting permission reply, type into PTY and stream the continuation
  if (state.awaitingPermission) {
    state.awaitingPermission = false;

    const res = await fetch(`${hostUrl}/type`, {
      method: 'POST',
      headers: hostHeaders,
      body: JSON.stringify({ text, stream: true }),
      signal: AbortSignal.timeout(330_000),
    });

    if (res.headers.get('content-type')?.includes('text/event-stream')) {
      await processSSEStream(res, state, replyTo);
    }
    return;
  }

  // Stream response via SSE
  const res = await fetch(`${hostUrl}/message`, {
    method: 'POST',
    headers: hostHeaders,
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(330_000),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => 'Unknown');
    throw new Error(`PTY host error (${profile.id}): ${res.status} ${err}`);
  }

  await processSSEStream(res, state, replyTo);
}

async function processSSEStream(res, state, replyTo) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const event = JSON.parse(line.substring(6));

        if (event.type === 'text' && event.data) {
          const cleaned = cleanForSignal(event.data);
          if (!cleaned) continue;

          const blocks = cleaned.split(/^[●•]\s*/m).filter(b => b.trim());
          for (const block of blocks) {
            const msg = block.trim();
            if (msg.length > 0) {
              console.log(`[Bridge:${state.profile.id}] Sending block (${msg.length} chars): ${msg.substring(0, 60)}...`);
              logMessage('outgoing', null, replyTo, null, msg, state.profile.id);
              await signalSend(replyTo, msg);
            }
          }
        } else if (event.type === 'permission' && event.data) {
          state.awaitingPermission = true;
          const permMsg = `[PERMISSION]\n${event.data}\n\nReply with a number to choose.`;
          console.log(`[Bridge:${state.profile.id}] Permission prompt`);
          logMessage('outgoing', null, replyTo, null, permMsg, state.profile.id);
          await signalSend(replyTo, permMsg);
        }
      } catch {}
    }
  }
}

async function getClaudeStatus(state) {
  try {
    const res = await fetch(`${state.hostUrl}/status`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return { ready: false, busy: false, error: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { ready: false, busy: false, error: err.message };
  }
}

// --- Per-Profile Queue ---

async function processQueue(state) {
  if (state.processing || state.messageQueue.length === 0) return;
  state.processing = true;

  while (state.messageQueue.length > 0) {
    const { body, replyTo, groupId } = state.messageQueue.shift();

    // Wait for this profile's Claude to not be busy
    for (let i = 0; i < 60; i++) {
      try {
        const status = await getClaudeStatus(state);
        if (!status.busy) break;
      } catch {}
      await new Promise(r => setTimeout(r, 5000));
    }

    try {
      await sendToClaudeStreaming(state, body, replyTo);
    } catch (err) {
      console.error(`[Bridge:${state.profile.id}] Error: ${err.message}`);
      logMessage('outgoing', null, replyTo, groupId, `Error: ${err.message}`, state.profile.id);
      await signalSend(replyTo, `Error: ${err.message}`);
    }
  }

  state.processing = false;
}

// --- Message Handler ---

const rateLimits = new Map();
const MAX_MESSAGES_PER_MINUTE = 10;
const MAX_MESSAGE_LENGTH = 4000;

function isRateLimited(source) {
  const now = Date.now();
  const limit = rateLimits.get(source);
  if (!limit || now > limit.resetTime) {
    rateLimits.set(source, { count: 1, resetTime: now + 60000 });
    return false;
  }
  limit.count++;
  return limit.count > MAX_MESSAGES_PER_MINUTE;
}

async function handleMessage(envelope) {
  const source = envelope.envelope?.source || envelope.source || '';
  const body = envelope.envelope?.dataMessage?.message || envelope.dataMessage?.message || '';
  const groupId = envelope.envelope?.dataMessage?.groupInfo?.groupId || null;
  const groupName = envelope.envelope?.dataMessage?.groupInfo?.groupName || null;
  const attachments = envelope.envelope?.dataMessage?.attachments || envelope.dataMessage?.attachments || [];

  // Learn group names
  if (groupId && groupName) {
    upsertGroupName(groupId, groupName);
  }

  // Download image attachments
  const imageFiles = [];
  for (const att of attachments) {
    if (att.contentType?.startsWith('image/') && att.id) {
      const saved = await downloadAttachment(att.id, att.contentType);
      if (saved) imageFiles.push(saved);
    }
  }

  if (!body?.trim() && imageFiles.length === 0) return;
  if (body.length > MAX_MESSAGE_LENGTH) {
    console.log(`[Bridge] Message too long from ${source} (${body.length} chars)`);
    return;
  }

  // --- Permission reply handling ---
  // Check if any profile is awaiting permission and this could be a reply
  const awaitingState = findProfileAwaitingPermission(source, groupId);
  if (awaitingState) {
    const prefix = awaitingState.profile.prefix;
    const prefixStripRegex = new RegExp(`^${prefix}\\s*`, 'i');
    const stripped = body.trim().replace(prefixStripRegex, '').trim();

    if (/^[1-9]$/.test(stripped) || /^(y|n|yes|no)$/i.test(stripped)) {
      const replyTo = groupId ? `group.${groupId}` : source;
      console.log(`[Bridge:${awaitingState.profile.id}] Permission reply from ${source}: ${stripped}`);
      logMessage('incoming', source, replyTo, groupId, stripped, awaitingState.profile.id);
      awaitingState.messageQueue.push({ body: stripped, replyTo, groupId });
      processQueue(awaitingState);
      return;
    }
  }

  // --- Route to profile ---
  let profileState = null;
  let messageBody = body;

  if (groupId) {
    // Group message: find profile by group, check prefix
    profileState = findProfileForGroup(groupId);
    if (!profileState) return; // no profile claims this group

    const prefix = profileState.profile.prefix;
    const prefixRegex = new RegExp(`^${prefix}\\b`, 'i');
    const prefixStripRegex = new RegExp(`^${prefix}\\s*`, 'i');

    if (!prefixRegex.test(body.trim())) return; // doesn't start with prefix
    messageBody = body.trim().replace(prefixStripRegex, '').trim();
    if (!messageBody && imageFiles.length === 0) return;

    // Check sender is allowed
    if (!numberInList(source, profileState.profile.allowed_numbers)) {
      console.log(`[Bridge] Blocked: ${source} not in ${profileState.profile.id} allowed_numbers`);
      return;
    }
  } else {
    // DM: find profile by prefix match or default
    profileState = findProfileForDM(source, body);
    if (!profileState) return;

    // Strip prefix if present
    const prefix = profileState.profile.prefix;
    const prefixRegex = new RegExp(`^${prefix}\\b`, 'i');
    const prefixStripRegex = new RegExp(`^${prefix}\\s*`, 'i');
    if (prefixRegex.test(body.trim())) {
      messageBody = body.trim().replace(prefixStripRegex, '').trim();
    }
  }

  // If this profile is awaiting permission and sender isn't an approver, hold the message
  if (profileState.awaitingPermission) {
    if (!numberInList(source, profileState.profile.approval_numbers)) {
      const replyTo = groupId ? `group.${groupId}` : source;
      console.log(`[Bridge:${profileState.profile.id}] Holding message from ${source} — waiting for approval`);
      await signalSend(replyTo, `Hold up, ${profileState.profile.prefix} is waiting on an approval from the admin. Try again in a sec.`);
      return;
    }
  }

  // Block slash commands
  if (/^\/\w/.test(messageBody.trim())) {
    console.log(`[Bridge:${profileState.profile.id}] Blocked slash command: ${messageBody.trim().split(' ')[0]}`);
    const replyTo = groupId ? `group.${groupId}` : source;
    await signalSend(replyTo, "Slash commands don't work through Signal — they lock up the terminal.");
    return;
  }

  if (isRateLimited(source)) {
    console.log(`[Bridge] Rate limited: ${source}`);
    return;
  }

  const replyTo = groupId ? `group.${groupId}` : source;

  // Build Eastern Time timestamp
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const timeStr = now.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short'
  });
  const timestamp = `${dateStr} ${timeStr}`;

  let taggedBody = `[${source}] [${timestamp}] ${messageBody}`;
  if (imageFiles.length > 0) {
    const imgRefs = imageFiles.map(f => `(sent image: ${f.hostPath})`).join(' ');
    taggedBody = `[${source}] [${timestamp}] ${imgRefs}${messageBody ? ' ' + messageBody : ' what is this image?'}`;
  }

  console.log(`[Bridge:${profileState.profile.id}] Incoming: source=${source}, body=${messageBody.substring(0, 80)}`);
  logMessage('incoming', source, replyTo, groupId, messageBody, profileState.profile.id);

  profileState.messageQueue.push({ body: taggedBody, replyTo, groupId });
  processQueue(profileState);
}

// --- Web UI & API ---

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/', async (req, res) => {
  const settings = getAllSettings();
  const profiles = getProfiles();
  const groupNames = getGroupNames();

  // Get status for each profile
  const profileStatuses = [];
  for (const profile of profiles) {
    const state = profileStates.get(profile.id);
    const status = state ? await getClaudeStatus(state) : { ready: false, busy: false, error: 'No state' };
    profileStatuses.push({ ...profile, status });
  }

  const log = getMessageLog(50);
  res.send(renderPage(settings, log, {
    profiles: profileStatuses,
    groupNames,
    signalConnected: wsConnected,
    enabled: settings.enabled === 'true',
  }));
});

app.post('/settings', async (req, res) => {
  for (const field of ['signal_api_url', 'signal_sender', 'poll_interval_ms']) {
    if (req.body[field] !== undefined) setSetting(field, req.body[field]);
  }
  setSetting('enabled', req.body.enabled === 'on' ? 'true' : 'false');

  disconnectSignal();
  if (getSetting('enabled') === 'true') connectSignal();

  res.redirect('/');
});

// --- Profile CRUD API ---

app.post('/profiles', (req, res) => {
  try {
    const { id, name, prefix, project_dir, host_port, allowed_numbers, allowed_groups, approval_numbers, dm_enabled } = req.body;
    if (!id || !prefix) return res.status(400).json({ error: 'id and prefix are required' });
    if (getProfile(id)) return res.status(409).json({ error: 'Profile already exists' });

    // Validate port uniqueness
    const profiles = getProfiles();
    const port = parseInt(host_port) || 3101;
    if (profiles.some(p => p.host_port === port)) {
      return res.status(400).json({ error: `Port ${port} is already in use by another profile` });
    }

    createProfile({ id, name: name || id, prefix, project_dir, host_port: port, allowed_numbers, allowed_groups, approval_numbers, dm_enabled: dm_enabled !== false && dm_enabled !== 'false' });
    loadProfileStates();
    res.redirect('/');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/profiles/:id', (req, res) => {
  try {
    const profile = getProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    const data = { ...req.body };
    if (data.dm_enabled !== undefined) data.dm_enabled = data.dm_enabled === 'on' || data.dm_enabled === true || data.dm_enabled === 'true';
    if (data.enabled !== undefined) data.enabled = data.enabled === 'on' || data.enabled === true || data.enabled === 'true';
    if (data.host_port) data.host_port = parseInt(data.host_port);

    updateProfile(req.params.id, data);
    loadProfileStates();
    res.redirect('/');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/profiles/:id/delete', (req, res) => {
  deleteProfile(req.params.id);
  loadProfileStates();
  res.redirect('/');
});

app.post('/toggle', (req, res) => {
  const current = getSetting('enabled');
  const newVal = current === 'true' ? 'false' : 'true';
  setSetting('enabled', newVal);
  if (newVal === 'true') connectSignal();
  else disconnectSignal();
  res.redirect('/');
});

app.get('/api/status', async (req, res) => {
  const statuses = {};
  for (const [id, state] of profileStates) {
    statuses[id] = await getClaudeStatus(state);
  }
  res.json({ profiles: statuses, signalConnected: wsConnected, enabled: getSetting('enabled') === 'true' });
});

app.get('/api/log', (req, res) => {
  res.json(getMessageLog(parseInt(req.query.limit) || 50));
});

app.get('/api/profiles', (req, res) => {
  res.json(getProfiles());
});

// --- Start ---

getDb();
loadProfileStates();
console.log(`[Bridge] Using secret: ${BRIDGE_SECRET.substring(0, 10)}...`);

app.listen(WEB_PORT, '0.0.0.0', () => {
  console.log(`[Bridge] Settings UI at http://localhost:${WEB_PORT}`);
  if (getSetting('enabled') === 'true') connectSignal();
});

process.on('SIGINT', () => { disconnectSignal(); process.exit(0); });
process.on('SIGTERM', () => { disconnectSignal(); process.exit(0); });
