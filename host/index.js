/**
 * Claude PTY Host — Runs Claude CLI in a persistent terminal and exposes HTTP API.
 * Uses a shadow xterm-headless instance to track screen state for clean text extraction.
 *
 * API:
 *   POST /message  { "text": "..." }  → SSE stream of responses
 *   POST /type     { "text": "..." }  → type into PTY (permission replies)
 *   GET  /status   → { ready, busy, ... }
 *   GET  /health   → 200 OK
 *   POST /restart  → restart Claude
 *   POST /reset    → force clear busy state
 */

import pty from 'node-pty';
import stripAnsi from 'strip-ansi';
import express from 'express';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import xterm from '@xterm/headless';
const { Terminal } = xterm;

const __dirname = dirname(fileURLToPath(import.meta.url));
const logStream = fs.createWriteStream(join(__dirname, 'bridge.log'), { flags: 'a' });
const log = (...args) => logStream.write(`[${new Date().toLocaleTimeString()}] ${args.join(' ')}\n`);
console.log = log;
console.error = log;

// --- Config ---
const PORT = parseInt(process.env.PTY_PORT || '3101');
let PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const API_SECRET = process.env.BRIDGE_SECRET || 'csbr-' + Math.random().toString(36).substring(2, 15);
log(`API Secret: ${API_SECRET}`);
const SHELL = process.platform === 'win32' ? 'cmd.exe' : 'bash';
const COLS = process.stdout.columns || 120;
const ROWS = process.stdout.rows || 30;

// --- State ---
let ptyProcess = null;
let ready = false;
let busy = false;
let startupComplete = false;
let lastOutputTime = 0;

// --- Shadow terminal for text extraction ---
// Persistent xterm instance that receives ALL PTY bytes.
// Tracks the full screen state so we can snapshot and diff.
const shadowTerm = new Terminal({ cols: COLS, rows: ROWS, scrollback: 5000, allowProposedApi: true });

function snapshotScreen() {
  const lines = [];
  const buf = shadowTerm.buffer.active;
  // Read all lines including scrollback
  for (let i = 0; i <= buf.length; i++) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true) : '');
  }
  return lines;
}


// --- PTY Management ---

function startClaude() {
  log(`Starting Claude CLI in ${PROJECT_DIR}`);

  ptyProcess = pty.spawn(SHELL, [], {
    name: 'xterm-256color',
    cols: COLS, rows: ROWS,
    cwd: PROJECT_DIR,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  let startupBuffer = '';
  let claudeLaunched = false;

  ptyProcess.onData((data) => {
    lastOutputTime = Date.now();

    // Feed EVERY byte to the shadow terminal
    shadowTerm.write(data);

    if (!startupComplete) {
      startupBuffer += data;
      const clean = stripAnsi(startupBuffer);
      if (!claudeLaunched && (clean.includes('PS ') || clean.includes('$ ') || /\w:\\[^>]*>/.test(clean))) {
        claudeLaunched = true;
        setTimeout(() => ptyProcess.write('claude\r'), 500);
      }
      if (claudeLaunched && isClaudePrompt(clean)) {
        startupComplete = true;
        ready = true;
        log('Claude CLI is ready');
      }
    }

    // Pipe to visible terminal
    process.stdout.write(data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    log(`PTY exited (${exitCode}), restarting in 5s...`);
    ready = false; busy = false; startupComplete = false;
    setTimeout(startClaude, 5000);
  });
}

function isClaudePrompt(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const t = lines[i].trim();
    if (/^❯\s*$/.test(t)) return true;
    if (/^>(\s|$)/.test(t)) return true;
    if (/^You:/.test(t)) return true;
  }
  return false;
}

function isPermissionPrompt(text) {
  return /Do you want to /i.test(text)
    || /Enter to select.*navigate/i.test(text)
    || /Allow\s+(Read|Write|Edit|Bash|Glob|Grep|Agent|Skill|WebFetch|WebSearch)/i.test(text)
    || /Esc to cancel.*Tab to amend/i.test(text);
}

// --- Extract response from screen diff ---

function extractResponseFromScreen(screenLines, inputMessage) {
  // Find the LAST occurrence of the input message on screen — response comes after it
  let inputLineIdx = -1;
  if (inputMessage) {
    const inputSnippet = inputMessage.trim().substring(0, 30);
    for (let i = screenLines.length - 1; i >= 0; i--) {
      if (inputSnippet && screenLines[i].includes(inputSnippet)) {
        inputLineIdx = i;
        break;
      }
    }
  }

  // Start scanning from after the input line (or from top if not found)
  const startIdx = inputLineIdx >= 0 ? inputLineIdx + 1 : 0;
  const responseLines = [];
  let capturing = false;
  let lastWhiteDotIdx = -1;

  for (let i = startIdx; i < screenLines.length; i++) {
    const t = screenLines[i].trim();
    if (!t) {
      if (capturing) responseLines.push('');
      continue;
    }

    // White ● = response text
    if (/^●/.test(t)) {
      const afterDot = t.replace(/^●\s*/, '');

      // Green dots = tool calls — stop capturing
      if (/^(Bash|Read|Write|Edit|Update|Glob|Grep|Agent|WebSearch|WebFetch|Web Search|Explore|Skill)\s*[\((:]/i.test(afterDot)) {
        capturing = false;
        continue;
      }
      if (/^(Read|Wrote|Created|Updated|Edited|Running|Waiting|Searching)\s+\d/i.test(afterDot)) {
        capturing = false;
        continue;
      }

      capturing = true;
      lastWhiteDotIdx = responseLines.length;
      if (afterDot) responseLines.push(afterDot);
      continue;
    }

    // Stop capturing at the prompt — everything after is old content
    if (/^❯\s*$/.test(t)) {
      capturing = false;
      break; // Done — nothing after the prompt is part of this response
    }

    if (isJunkLine(t)) continue;

    if (capturing) {
      responseLines.push(t);
    }
  }

  // Trim empty lines
  while (responseLines.length > 0 && !responseLines[0]) responseLines.shift();
  while (responseLines.length > 0 && !responseLines[responseLines.length - 1]) responseLines.pop();

  const result = responseLines.join('\n').trim();

  // Debug: dump screen buffer on every extraction so we can diagnose truncation
  {
    const debugFile = join(__dirname, 'extraction-debug.log');
    const inputSnippet = inputMessage ? inputMessage.trim().substring(0, 30) : '(none)';
    const totalNonEmpty = screenLines.filter(l => l.trim()).length;
    let dump = `\n=== EXTRACTION (${result.length} chars) @ ${new Date().toLocaleString()} ===\n`;
    dump += `inputSnippet: "${inputSnippet}"\n`;
    dump += `inputLineIdx: ${inputLineIdx}\n`;
    dump += `startIdx: ${startIdx}\n`;
    dump += `screenLines.length: ${screenLines.length}\n`;
    dump += `non-empty lines: ${totalNonEmpty}\n`;
    dump += `--- SCREEN LINES (startIdx-10 to end, showing line index) ---\n`;
    const dumpStart = Math.max(0, startIdx - 10);
    for (let i = dumpStart; i < screenLines.length; i++) {
      const line = screenLines[i];
      if (line.trim() || i >= startIdx) {
        const marker = i === inputLineIdx ? ' <<<INPUT' : i === startIdx ? ' <<<START' : '';
        // Show char codes for first 5 chars to catch invisible/unexpected characters
        const codes = [...line.trim().substring(0, 5)].map(c => c.charCodeAt(0).toString(16)).join(',');
        dump += `  [${i}] (${codes}) ${line.substring(0, 200)}${marker}\n`;
      }
    }
    dump += `=== END ===\n`;
    fs.appendFileSync(debugFile, dump);
    log(`Extraction: ${result.length} chars — debug dumped to extraction-debug.log`);
  }

  return result;
}

function extractPermissionFromScreen(screenLines) {
  const permLines = [];
  let foundQuestion = false;

  for (const line of screenLines) {
    const t = line.trim();
    if (!t) continue;

    if (/Do you want to /i.test(t) || /Allow\s+\w/i.test(t)) {
      foundQuestion = true;
      permLines.push(t);
      continue;
    }

    if (foundQuestion) {
      const optMatch = t.match(/^(?:❯\s*)?(\d+)\.\s+(.+)/);
      if (optMatch) {
        permLines.push(`${optMatch[1]}. ${optMatch[2]}`);
        continue;
      }
      if (/^(?:❯\s*)?(Yes|No)/i.test(t)) {
        permLines.push(t.replace(/^❯\s*/, ''));
        continue;
      }
      if (/^Esc to cancel/i.test(t)) break;
      if (/Tab to amend/i.test(t)) break;
    }
  }

  return permLines.join('\n') || 'Claude is asking for permission. Check the terminal.';
}

function isJunkLine(t) {
  if (/^[─╭╮╰╯│┌┐└┘┤├┬┴┼═╌]+$/.test(t)) return true;
  if (/─{5,}/.test(t)) return true;
  if (/╌{5,}/.test(t)) return true;
  if (/^[✶✻✽✢·*○◌◍◉⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(t)) return true;
  if (/to\s*interrupt/i.test(t)) return true;
  if (/for\s*shortcuts/i.test(t)) return true;
  if (/^❯/.test(t)) return true;
  if (/^X+$/.test(t)) return true;
  if (/XX$/.test(t)) return true;
  if (/^⎿/.test(t)) return true;
  if (/ctrl\+[a-z]/i.test(t)) return true;
  if (/^(Bash|Read|Write|Edit|Update|Glob|Grep|Agent|WebSearch|WebFetch)\s*[\((:]/i.test(t)) return true;
  if (/^(Running|Waiting|Reading|Writing|Searching)…/.test(t)) return true;
  if (/^(Read|Wrote|Created|Updated|Edited)\s+\d/i.test(t)) return true;
  if (/Do you want to /i.test(t)) return true;
  if (/^Esc to cancel/i.test(t)) return true;
  if (/^Tab to amend/i.test(t)) return true;
  if (/Enter to select/i.test(t)) return true;
  if (/^(?:❯\s*)?\d+\.\s+(Yes|No)/i.test(t)) return true;
  if (/timeout\s+\d+/i.test(t)) return true;
  if (/Claude Code/i.test(t)) return true;
  if (/Share Claude/i.test(t)) return true;
  if (/clau\.de\//i.test(t)) return true;
  if (/^[▐▛█▜▌▝▘\s\[\]✻·]+$/.test(t)) return true;
  if (/~\\Documents\\/i.test(t)) return true;
  if (/^\d+\s+(##|[<‹]|[|])/.test(t)) return true;
  if (/^##\s/.test(t) && t.length < 60) return true;
  if (/^[<‹]!--/.test(t)) return true;
  if (/<!--.*-->/.test(t)) return true;
  if (/format:/i.test(t) && t.length < 80) return true;
  if (/^(Bash command|Create file|Edit file|Write file|Delete file)$/i.test(t)) return true;
  if (/This command requires approval/i.test(t)) return true;
  if (/^(git |curl |echo |cat |ls |cd |rm |docker |npm )/i.test(t) && t.length < 100) return true;
  // Line numbers or number sequences from scrollback
  if (/^[\d\s]+$/.test(t)) return true;
  if (/earn.*\$\d+/i.test(t)) return true;
  if (/\/passes/i.test(t) && t.length < 30) return true;
  return false;
}

// --- Streaming message handler ---

function handleMessageStream(text, onEvent) {
  busy = true;
  lastOutputTime = Date.now();
  const startTime = Date.now();
  let resolved = false;
  let checking = false;

  log(`Message stream started`);

  const cleanup = () => {
    clearInterval(checkTimer);
    clearTimeout(timeout);
    busy = false;
    resolved = true;
  };

  const timeout = setTimeout(() => {
    if (resolved) return;
    log('Response timed out after 5 minutes');
    const postSnapshot = snapshotScreen();
    const content = extractResponseFromScreen(postSnapshot, text);
    if (content) onEvent({ type: 'text', data: content });
    cleanup();
    onEvent({ type: 'done' });
  }, 300_000);

  const checkTimer = setInterval(() => {
    if (resolved || checking) return;
    checking = true;
    try {
      const idle = Date.now() - lastOutputTime;
      const elapsed = Date.now() - startTime;
      if (idle < 1000) return; // Still receiving output

      const clean = stripAnsi(shadowTerm.buffer.active.getLine(ROWS - 1)?.translateToString(true) || '');

      // Check the shadow terminal's last non-empty lines for prompt/permission
      const buf = shadowTerm.buffer.active;
      const lastLines = [];
      let lastNonEmptyRow = 0;
      for (let i = 0; i <= buf.length; i++) {
        const line = buf.getLine(i);
        if (line && line.translateToString(true).trim()) lastNonEmptyRow = i;
      }
      for (let i = Math.max(0, lastNonEmptyRow - 10); i <= lastNonEmptyRow; i++) {
        const line = buf.getLine(i);
        if (line) lastLines.push(line.translateToString(true).trim());
      }
      const lastLinesText = lastLines.join('\n');

      // Permission prompt (not in first 3s)
      if (elapsed > 3000 && isPermissionPrompt(lastLinesText)) {
        const postSnapshot = snapshotScreen();
        const content = extractResponseFromScreen(postSnapshot, text);
        if (content) onEvent({ type: 'text', data: content });
        const perm = extractPermissionFromScreen(postSnapshot);
        cleanup();
        onEvent({ type: 'permission', data: perm });
        onEvent({ type: 'done' });
        return;
      }

      // Claude prompt (not in first 5s)
      if (elapsed > 5000) {
        const hasPrompt = lastLines.some(l => /^❯\s*$/.test(l) || /^>\s*$/.test(l));
        if (hasPrompt) {
          const postSnapshot = snapshotScreen();
          const content = extractResponseFromScreen(postSnapshot, text);
          log(`Prompt detected. Extracted ${content.length} chars`);
          cleanup();
          if (content) onEvent({ type: 'text', data: content });
          onEvent({ type: 'done' });
          return;
        }
      }

      // Force extract — last resort fallback if prompt detection fails.
      // Only trigger if screen shows no signs of active tool work.
      if (idle >= 30000) {
        // Check if recent screen lines show tool activity (edits, diffs, running indicators).
        // If so, Claude is still working — don't force extract yet.
        const toolActive = lastLines.some(l =>
          /^●?\s*(Bash|Read|Write|Edit|Update|Glob|Grep|Agent|WebSearch|WebFetch|Skill)\s*[\((:]/i.test(l)
          || /^⎿/.test(l)
          || /^(Running|Waiting|Reading|Writing|Searching|Editing)/.test(l)
          || /Added \d+ line|Removed \d+ line/i.test(l)
          || /^\d+[+-]\|/.test(l)
        );

        if (toolActive) {
          log(`Force extract deferred — tool activity detected (idle ${idle}ms)`);
        } else {
          const postSnapshot = snapshotScreen();
          const content = extractResponseFromScreen(postSnapshot, text);
          log(`Force extract after ${idle}ms idle (no tool activity)`);
          cleanup();
          if (content) onEvent({ type: 'text', data: content });
          onEvent({ type: 'done' });
        }
      }
    } finally {
      checking = false;
    }
  }, 500);

  // Write the message to Claude
  ptyProcess.write(text + '\r');
}

// --- HTTP API ---

const app = express();
app.use(express.json());

function requireAuth(req, res, next) {
  const token = req.headers['x-bridge-secret'] || req.query.secret;
  if (token !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/status', (req, res) => {
  res.json({ ready, busy, startupComplete, projectDir: PROJECT_DIR });
});

app.post('/restart', requireAuth, (req, res) => {
  const { projectDir } = req.body || {};
  if (projectDir) PROJECT_DIR = projectDir;
  ready = false; busy = false; startupComplete = false;
  if (ptyProcess) ptyProcess.kill();
  res.json({ ok: true, projectDir: PROJECT_DIR });
});

app.post('/type', requireAuth, (req, res) => {
  const { text, stream } = req.body || {};
  if (!text || !ptyProcess) return res.status(400).json({ error: 'Missing text or PTY not running' });

  const input = text.trim();

  if (/^[1-9]$/.test(input)) {
    const choice = parseInt(input);
    for (let i = 1; i < choice; i++) {
      ptyProcess.write('\x1b[B');
    }
    setTimeout(() => ptyProcess.write('\r'), 200);
  } else if (/^(y|n|yes|no)$/i.test(input)) {
    ptyProcess.write(input.charAt(0) + '\r');
  } else {
    return res.status(400).json({ error: 'Only numeric choices (1-9) or y/n allowed' });
  }

  if (stream) {
    setTimeout(() => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      handleMessageStream('', (event) => {
        log(`Type-stream event: ${event.type} ${(event.data || '').substring(0, 60)}`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'done') res.end();
      });
    }, 500);
  } else {
    busy = true;
    lastOutputTime = Date.now();
    res.json({ ok: true });
  }
});

app.post('/reset', requireAuth, (req, res) => {
  busy = false;
  res.json({ ok: true });
});

app.post('/message', requireAuth, (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing text field' });
  if (busy) return res.status(429).json({ error: 'Claude is busy' });
  if (!ready) return res.status(503).json({ error: 'Claude is not ready' });

  log(`Message: ${text.substring(0, 80)}`);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  handleMessageStream(text, (event) => {
    log(`Event: ${event.type} ${(event.data || '').substring(0, 80)}`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.type === 'done') res.end();
  });

  req.on('close', () => {});
});

// --- Terminal resize ---
process.stdout.on('resize', () => {
  if (ptyProcess) {
    const newCols = process.stdout.columns;
    const newRows = process.stdout.rows;
    ptyProcess.resize(newCols, newRows);
    shadowTerm.resize(newCols, newRows);
  }
});

// --- Stdin passthrough ---
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (data) => {
  if (ptyProcess) ptyProcess.write(data.toString());
});

// --- Start ---
app.listen(PORT, '127.0.0.1', () => {
  log(`API listening on http://127.0.0.1:${PORT}`);
  startClaude();
});
