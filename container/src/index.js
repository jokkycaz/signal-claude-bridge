/**
 * Claude Signal Bridge — Docker container.
 * Connects to Signal via WebSocket (json-rpc mode), forwards messages to Claude PTY host,
 * sends responses back via Signal. Serves settings UI.
 */

import express from 'express';
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, getSetting, setSetting, getAllSettings, logMessage, getMessageLog } from './db.js';
import { renderPage } from './ui.js';

const ATTACHMENT_DIR = '/app/attachments';
// Windows path that Claude sees (host side)
const ATTACHMENT_HOST_DIR = process.env.ATTACHMENT_HOST_DIR || '';

const WEB_PORT = parseInt(process.env.WEB_PORT || '3100');

// --- State ---
let ws = null;
let wsConnected = false;
let reconnectTimer = null;

// --- Signal WebSocket ---

function connectSignal() {
  const apiUrl = getSetting('signal_api_url');
  const sender = getSetting('signal_sender');
  if (!apiUrl || !sender) {
    console.error('[Signal] Missing API URL or sender number');
    scheduleReconnect();
    return;
  }

  // Convert http:// to ws:// for WebSocket
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
  if (ws) {
    ws.removeAllListeners();
    ws.close();
    ws = null;
  }
  wsConnected = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// --- Signal Send (HTTP, works in json-rpc mode) ---

async function signalSend(recipient, message) {
  const apiUrl = getSetting('signal_api_url');
  const sender = getSetting('signal_sender');
  if (!apiUrl || !sender) return false;

  try {
    const chunks = splitMessage(message, 4000);
    for (const chunk of chunks) {
      let body;
      if (recipient.startsWith('group.')) {
        // Group message — internal_id needs base64 encoding for the API
        const internalId = recipient.substring(6); // strip "group."
        const encodedId = Buffer.from(internalId).toString('base64');
        body = JSON.stringify({
          message: chunk,
          number: sender,
          recipients: [`group.${encodedId}`],
        });
      } else {
        body = JSON.stringify({
          message: chunk,
          number: sender,
          recipients: [recipient],
        });
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

// --- Attachment handling ---

async function downloadAttachment(attachmentId, contentType) {
  const apiUrl = getSetting('signal_api_url');
  if (!apiUrl) return null;

  try {
    const ext = contentType?.includes('png') ? 'png'
      : contentType?.includes('gif') ? 'gif'
      : contentType?.includes('webp') ? 'webp'
      : 'jpg';
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
  // Named filter rules — each returns a reason string if matched, or null
  const filters = [
    // Spinner lines
    t => /^[✶✻✽✢·*●✦○◌◍◉⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*\S+…\s*$/.test(t) && 'spinner',
    // Box drawing
    t => /^[─╭╮╰╯│┌┐└┘┤├┬┴┼═]+$/.test(t) && 'box-drawing',
    t => /^[╭╮╰╯]─/.test(t) && 'box-drawing',
    t => /─{5,}/.test(t) && 'box-drawing',
    t => /╌{5,}/.test(t) && 'box-drawing',
    // Claude Code UI
    t => /Claude Code v\d/i.test(t) && 'cc-version',
    t => /Share Claude Code/i.test(t) && 'cc-promo',
    t => (/\/passes/i.test(t) && t.length < 30) && 'cc-passes',
    t => /earn.*\$\d+/i.test(t) && 'cc-earn-promo',
    // ASCII art
    t => /^[▝▜█▛▘▐▌\s\[\]✻·]+$/.test(t) && 'ascii-art',
    t => /~\\Documents\\/i.test(t) && 'path-leak',
    // UI phrases
    t => (/^not use\b/i.test(t) && t.length < 40) && 'ui-phrase',
    t => /^"[^"]{1,30}"[)\s]*$/.test(t) && 'quoted-phrase',
    // Tool output
    t => /^⎿/.test(t) && 'tool-result',
    t => /^●?\s*(Bash|Read|Write|Edit|Update|Glob|Grep|Agent|WebSearch|WebFetch)\(/.test(t) && 'tool-call',
    t => /^(Running|Waiting|Reading|Writing|Searching)…/.test(t) && 'tool-status',
    t => /^(Everything up-to-date|No output|\(No output\))$/i.test(t) && 'tool-empty',
    // Pipe-separated data
    t => (/\d+.*\|.*\d+/.test(t) && (t.match(/\|/g) || []).length >= 2) && 'pipe-data',
    // Git output
    t => /^[0-9a-f]{7,}\s+/i.test(t) && 'git-hash',
    t => /^Error: Exit code \d+/i.test(t) && 'exit-code',
    // Diff/edit lines
    t => /^\d+\s*[-+]/.test(t) && 'diff-line',
    t => (/^\d+\s*$/.test(t) && t.length < 5) && 'line-number',
    t => /^\d+\s+##/.test(t) && 'diff-header',
    t => /^\d+\s+[<‹]/.test(t) && 'diff-bracket',
    t => /^\d+\s+\|/.test(t) && 'diff-pipe',
    // HTML/markdown
    t => /^[<‹]!--/.test(t) && 'html-comment',
    t => /<!--.*-->/.test(t) && 'html-comment',
    t => (/^#+\s/.test(t) && t.length < 60) && 'md-header',
    t => /^\|.*\|/.test(t) && 'md-table',
    t => (/format:/i.test(t) && t.length < 80) && 'format-line',
    // File notifications
    t => /^(Updated|Created|Wrote|Saved|Edit file|Create file)\s/i.test(t) && 'file-notification',
    t => (/\.(md|json|txt|js|ts)\s*$/.test(t) && t.length < 40) && 'file-extension',
    // Section markers
    t => /^(Balances|Cooldowns|Inventories|Achievements|Quests|Pets|Farms|Fish)\s*$/i.test(t) && 'section-marker',
    // JSON
    t => /^\s*"(args|headers|origin|url|Host|Accept|User-Agent|Content-Type)"/.test(t) && 'json-fragment',
    t => /^\s*[\{\}\[\]]$/.test(t) && 'json-bracket',
    // Spinner with timing
    t => /^[✶✻✽✢·*●✦○◌◍◉⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*.+\s+for\s+\d+/i.test(t) && 'spinner-timing',
    // Expand/shortcut hints
    t => /ctrl\+o to expand/i.test(t) && 'expand-hint',
    t => /lines \(ctrl\+/i.test(t) && 'expand-hint',
    t => /esc\s*to\s*interrupt/i.test(t) && 'shortcut-hint',
    t => /for\s*shortcuts/i.test(t) && 'shortcut-hint',
    t => /ctrl\+[a-z]\s+to\s+/i.test(t) && 'shortcut-hint',
    t => /Enter to select.*navigate.*cancel/i.test(t) && 'shortcut-hint',
    // Claude Code notices
    t => /Claude Code has switched/i.test(t) && 'cc-notice',
    t => /claude install/i.test(t) && 'cc-notice',
    t => /clau\.de\//i.test(t) && 'cc-link',
    t => /Opus.*context|Sonnet.*context/i.test(t) && 'model-line',
    // Sender ID leak
    t => /^\[[\+0-9a-f-]{10,}\]/i.test(t) && 'sender-id-leak',
    // Prompt markers
    t => /^❯/.test(t) && 'prompt',
    t => /^>\s*$/.test(t) && 'prompt',
    t => /^X+$/.test(t) && 'x-line',
    // Navigation
    t => /↑\/↓\s*to\s*navigate/i.test(t) && 'nav-hint',
    t => /^☐\s/.test(t) && 'checkbox',
    // Timeout
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

  // Log filtered lines if any non-trivial content was dropped
  if (filtered.length > 0) {
    const interesting = filtered.filter(f =>
      !['box-drawing', 'spinner', 'tool-result', 'tool-call', 'tool-status',
        'prompt', 'shortcut-hint', 'expand-hint', 'nav-hint', 'spinner-timing',
        'cc-version', 'cc-promo', 'cc-notice', 'cc-link', 'model-line',
        'background-hint', 'timeout-hint', 'ascii-art', 'x-line'].includes(f.reason)
    );
    if (interesting.length > 0) {
      console.log(`[Filter] Dropped ${filtered.length} lines (${interesting.length} notable):`);
      for (const f of interesting) {
        console.log(`[Filter]   [${f.reason}] ${f.line}`);
      }
    }
  }

  return result
  // Clean up inline junk
  .replace(/\[\+?\d{10,}\]/g, '')  // strip phone numbers in brackets
  .replace(/\[[0-9a-f-]{20,}\]/gi, '')  // strip UUIDs in brackets
  .replace(/[✶✻✽✢·*●✦○◌◍◉]\s*\S+…/g, '')  // inline spinners
  .replace(/\s{3,}/g, ' ')  // collapse excessive spaces
  .replace(/\n{3,}/g, '\n\n')  // collapse excessive newlines
  .trim();
}

// --- Claude PTY Host ---
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'claude-signal-bridge-s3cret';
const hostHeaders = { 'Content-Type': 'application/json', 'X-Bridge-Secret': BRIDGE_SECRET };
console.log(`[Bridge] Using secret: ${BRIDGE_SECRET.substring(0, 10)}...`);

let awaitingPermission = false;

// Send message to Claude and stream responses back via callback
async function sendToClaudeStreaming(text, replyTo) {
  const hostUrl = getSetting('pty_host_url');
  if (!hostUrl) throw new Error('PTY host URL not configured');

  // If awaiting permission reply, type into PTY and stream the continuation
  if (awaitingPermission) {
    awaitingPermission = false;

    const res = await fetch(`${hostUrl}/type`, {
      method: 'POST',
      headers: hostHeaders,
      body: JSON.stringify({ text, stream: true }),
      signal: AbortSignal.timeout(330_000),
    });

    // Parse SSE stream from the continuation (same format as /message)
    if (res.headers.get('content-type')?.includes('text/event-stream')) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';

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
                  logMessage('outgoing', null, replyTo, null, msg);
                  await signalSend(replyTo, msg);
                }
              }
            } else if (event.type === 'permission' && event.data) {
              awaitingPermission = true;
              const permMsg = `[PERMISSION]\n${event.data}\n\nReply with a number to choose.`;
              logMessage('outgoing', null, replyTo, null, permMsg);
              await signalSend(replyTo, permMsg);
            }
          } catch {}
        }
      }
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
    throw new Error(`PTY host error: ${res.status} ${err}`);
  }

  // Parse SSE stream
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const event = JSON.parse(line.substring(6));

        if (event.type === 'text' && event.data) {
          const cleaned = cleanForSignal(event.data);
          if (!cleaned) continue;

          // Split on ● and send each block
          const blocks = cleaned.split(/^[●•]\s*/m).filter(b => b.trim());
          for (const block of blocks) {
            const msg = block.trim();
            if (msg.length > 0) {
              console.log(`[Bridge] Sending block (${msg.length} chars): ${msg.substring(0, 60)}...`);
              logMessage('outgoing', null, replyTo, null, msg);
              await signalSend(replyTo, msg);
            }
          }
        } else if (event.type === 'permission' && event.data) {
          awaitingPermission = true;
          const permMsg = `[PERMISSION]\n${event.data}\n\nReply with a number to choose.`;
          console.log(`[Bridge] Permission prompt`);
          logMessage('outgoing', null, replyTo, null, permMsg);
          await signalSend(replyTo, permMsg);
        }
        // 'done' type — stream ends naturally
      } catch {}
    }
  }
}

async function getClaudeStatus() {
  const hostUrl = getSetting('pty_host_url');
  if (!hostUrl) return { ready: false, busy: false, error: 'PTY host URL not configured' };

  try {
    const res = await fetch(`${hostUrl}/status`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return { ready: false, busy: false, error: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { ready: false, busy: false, error: err.message };
  }
}

// --- Message Handler ---

function isAllowed(source, groupId) {
  const allowedNumbers = getSetting('allowed_numbers').split(',').map(s => s.trim()).filter(Boolean);
  const allowedGroups = getSetting('allowed_groups').split(',').map(s => s.trim()).filter(Boolean);
  const normalized = source.replace(/[\s-]/g, '');

  // Check sender against allowed list (supports both phone numbers and UUIDs)
  const senderOk = allowedNumbers.length === 0 || allowedNumbers.some(allowed => {
    const norm = allowed.replace(/[\s-]/g, '');
    return norm === normalized || norm === source;
  });

  if (groupId) {
    if (getSetting('groups_enabled') !== 'true') return false;
    const groupOk = allowedGroups.length === 0 || allowedGroups.includes(groupId);
    return groupOk || senderOk;
  }
  return senderOk;
}

// Rate limiting — max messages per user per minute
const rateLimits = new Map(); // phone → { count, resetTime }
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

// Message queue — process one at a time, don't reject while busy
const messageQueue = [];
let processing = false;

async function handleMessage(envelope) {
  const source = envelope.envelope?.source || envelope.source || '';
  const body = envelope.envelope?.dataMessage?.message || envelope.dataMessage?.message || '';
  const groupId = envelope.envelope?.dataMessage?.groupInfo?.groupId || null;
  const attachments = envelope.envelope?.dataMessage?.attachments || envelope.dataMessage?.attachments || [];

  // Download any image attachments
  const imageFiles = [];
  for (const att of attachments) {
    if (att.contentType?.startsWith('image/') && att.id) {
      const saved = await downloadAttachment(att.id, att.contentType);
      if (saved) imageFiles.push(saved);
    }
  }

  console.log(`[Bridge] Debug: body="${body}", images=${imageFiles.length}, groupId=${groupId ? 'yes' : 'no'}`);
  if (!body?.trim() && imageFiles.length === 0) return;
  if (body.length > MAX_MESSAGE_LENGTH) {
    console.log(`[Bridge] Message too long from ${source} (${body.length} chars)`);
    return;
  }

  // Group messages must start with "claude" (case insensitive) to be processed
  // If awaiting permission, accept bare numbers or "{prefix} 1" as permission replies
  let messageBody = body;
  const groupPrefix = getSetting('group_prefix') || 'chad';
  const prefixRegex = new RegExp(`^${groupPrefix}\\b`, 'i');
  const prefixStripRegex = new RegExp(`^${groupPrefix}\\s*`, 'i');

  if (awaitingPermission) {
    const stripped = body.trim().replace(prefixStripRegex, '').trim();
    if (/^[1-9]$/.test(stripped) || /^(y|n|yes|no)$/i.test(stripped)) {
      // Check if this sender is allowed to approve
      const approvalNumbers = getSetting('approval_numbers').split(',').map(s => s.trim()).filter(Boolean);
      const normalizedSource = source.replace(/[\s-]/g, '');
      if (approvalNumbers.length > 0 && !approvalNumbers.some(a => a.replace(/[\s-]/g, '') === normalizedSource || a === source)) {
        console.log(`[Bridge] Permission reply blocked — ${source} not in approval_numbers`);
        return;
      }

      messageBody = stripped;
      const replyTo = groupId ? `group.${groupId}` : source;
      console.log(`[Bridge] Permission reply from ${source}: ${messageBody}`);
      logMessage('incoming', source, replyTo, groupId, messageBody);
      messageQueue.push({ body: messageBody, replyTo, groupId });
      processQueue();
      return;
    }
  }

  // Group messages must start with the configured prefix
  if (groupId) {
    if (!prefixRegex.test(body.trim())) return;
    messageBody = body.trim().replace(prefixStripRegex, '').trim();
    if (!messageBody && imageFiles.length === 0) return;
  }

  // If awaiting permission, hold non-approval messages
  if (awaitingPermission) {
    const approvalNumbers = getSetting('approval_numbers').split(',').map(s => s.trim()).filter(Boolean);
    const normalizedSource = source.replace(/[\s-]/g, '');
    const isApprover = approvalNumbers.length === 0 || approvalNumbers.some(a => a.replace(/[\s-]/g, '') === normalizedSource || a === source);

    if (!isApprover) {
      const replyTo = groupId ? `group.${groupId}` : source;
      console.log(`[Bridge] Holding message from ${source} — waiting for approval`);
      await signalSend(replyTo, `Hold up, ${groupPrefix} is waiting on an approval from the admin. Try again in a sec.`);
      return;
    }
  }

  // Block slash commands — they show interactive UI that locks up the PTY
  if (/^\/\w/.test(messageBody.trim())) {
    console.log(`[Bridge] Blocked slash command: ${messageBody.trim().split(' ')[0]}`);
    const replyTo = groupId ? `group.${groupId}` : source;
    await signalSend(replyTo, "Slash commands don't work through Signal — they lock up the terminal.");
    return;
  }

  console.log(`[Bridge] Incoming: source=${source}, groupId=${groupId}, body=${messageBody.substring(0, 40)}`);

  if (!isAllowed(source, groupId)) {
    console.log(`[Bridge] Blocked: source=${source}, groupId=${groupId}, allowedNumbers=${getSetting('allowed_numbers')}, allowedGroups=${getSetting('allowed_groups')}`);
    return;
  }

  if (isRateLimited(source)) {
    console.log(`[Bridge] Rate limited: ${source}`);
    return;
  }

  const replyTo = groupId ? `group.${groupId}` : source;
  // Build Eastern Time timestamp (e.g. "2026-04-16 3:30 PM EDT")
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
  const timeStr = now.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  });
  const timestamp = `${dateStr} ${timeStr}`;
  // Prepend sender ID, timestamp, and image references so Claude knows who's talking, when, and what they sent
  let taggedBody = `[${source}] [${timestamp}] ${messageBody}`;
  if (imageFiles.length > 0) {
    const imgRefs = imageFiles.map(f => `(sent image: ${f.hostPath})`).join(' ');
    taggedBody = `[${source}] [${timestamp}] ${imgRefs}${messageBody ? ' ' + messageBody : ' what is this image?'}`;
  }

  console.log(`[Bridge] ${source}${groupId ? ' (group)' : ''}: ${messageBody.substring(0, 80)}`);
  logMessage('incoming', source, replyTo, groupId, messageBody);

  messageQueue.push({ body: taggedBody, replyTo, groupId });
  processQueue();
}

async function processQueue() {
  if (processing || messageQueue.length === 0) return;
  processing = true;

  while (messageQueue.length > 0) {
    const { body, replyTo, groupId } = messageQueue.shift();

    // Wait for Claude to not be busy
    for (let i = 0; i < 60; i++) {
      try {
        const status = await getClaudeStatus();
        if (!status.busy) break;
      } catch {}
      await new Promise(r => setTimeout(r, 5000));
    }

    try {
      await sendToClaudeStreaming(body, replyTo);
    } catch (err) {
      console.error(`[Bridge] Error: ${err.message}`);
      logMessage('outgoing', null, replyTo, groupId, `Error: ${err.message}`);
      await signalSend(replyTo, `Error: ${err.message}`);
    }
  }

  processing = false;
}

// --- Web UI ---

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/', async (req, res) => {
  const settings = getAllSettings();
  const log = getMessageLog(50);
  const claudeStatus = await getClaudeStatus();
  res.send(renderPage(settings, log, {
    claudeReady: claudeStatus.ready,
    claudeBusy: claudeStatus.busy,
    claudeError: claudeStatus.error,
    signalConnected: wsConnected,
    enabled: settings.enabled === 'true',
  }));
});

app.post('/settings', async (req, res) => {
  const oldProjectDir = getSetting('project_dir');
  for (const field of ['signal_api_url', 'signal_sender', 'allowed_numbers', 'allowed_groups', 'pty_host_url', 'poll_interval_ms', 'project_dir']) {
    if (req.body[field] !== undefined) setSetting(field, req.body[field]);
  }
  setSetting('enabled', req.body.enabled === 'on' ? 'true' : 'false');
  setSetting('groups_enabled', req.body.groups_enabled === 'on' ? 'true' : 'false');
  if (req.body.approval_numbers !== undefined) setSetting('approval_numbers', req.body.approval_numbers);
  if (req.body.group_prefix !== undefined) setSetting('group_prefix', req.body.group_prefix);

  // If project_dir changed, tell the host to restart Claude in the new dir
  const newProjectDir = getSetting('project_dir');
  if (newProjectDir && newProjectDir !== oldProjectDir) {
    try {
      const hostUrl = getSetting('pty_host_url');
      await fetch(`${hostUrl}/restart`, {
        method: 'POST',
        headers: hostHeaders,
        body: JSON.stringify({ projectDir: newProjectDir }),
        signal: AbortSignal.timeout(5_000),
      });
      console.log(`[Bridge] Restarted host with project dir: ${newProjectDir}`);
    } catch (err) {
      console.error(`[Bridge] Failed to restart host: ${err.message}`);
    }
  }

  // Reconnect Signal WebSocket if settings changed
  disconnectSignal();
  if (getSetting('enabled') === 'true') {
    connectSignal();
  }

  res.redirect('/');
});

app.post('/toggle', (req, res) => {
  const current = getSetting('enabled');
  const newVal = current === 'true' ? 'false' : 'true';
  setSetting('enabled', newVal);

  if (newVal === 'true') {
    connectSignal();
  } else {
    disconnectSignal();
  }

  res.redirect('/');
});

app.get('/api/status', async (req, res) => {
  res.json({ claude: await getClaudeStatus(), signalConnected: wsConnected, enabled: getSetting('enabled') === 'true' });
});

app.get('/api/log', (req, res) => {
  res.json(getMessageLog(parseInt(req.query.limit) || 50));
});

// --- Start ---

getDb();

app.listen(WEB_PORT, '0.0.0.0', () => {
  console.log(`[Bridge] Settings UI at http://localhost:${WEB_PORT}`);
  if (getSetting('enabled') === 'true') {
    connectSignal();
  }
});

process.on('SIGINT', () => { disconnectSignal(); process.exit(0); });
process.on('SIGTERM', () => { disconnectSignal(); process.exit(0); });
