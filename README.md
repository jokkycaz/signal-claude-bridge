# Claude Signal Bridge

Text Claude Code from your phone via Signal. Supports private chats and group chats with a configurable bot persona.

## How It Works

```
Phone (Signal) → signal-cli (Docker) → Bridge Container (Docker)
    → HTTP → Host (Windows/Mac/Linux) → node-pty → Claude CLI
    ← shadow xterm extracts clean text ← sends back via Signal
```

- **Host**: Runs Claude Code CLI in a persistent visible terminal via `node-pty`. A shadow `xterm-headless` instance tracks the screen state for clean text extraction. You can type in the terminal directly AND receive messages from Signal — same conversation.
- **Container**: Receives Signal messages via WebSocket, forwards to the host, cleans up TUI artifacts from the response, and sends clean text back via Signal.
- **Settings UI**: Web interface at `localhost:3100` for configuring the bridge.

## Features

- **Persistent CLI** — Claude stays running and hot. No cold starts between messages.
- **Visible terminal** — watch Claude think, type directly, same conversation as Signal.
- **Group chat support** — configurable trigger prefix (e.g., "chad"), group enable/disable toggle.
- **Permission prompts** — relayed to Signal with numbered options. Reply with a number to approve/deny.
- **Approval control** — restrict who can approve tool permissions.
- **Image support** — send images via Signal, Claude can view them.
- **Message queue** — handles concurrent messages sequentially.
- **Rate limiting** — configurable per-user limits.
- **Auth** — shared secret between host and container.
- **Bot persona** — driven by CLAUDE.md in your project folder. Full memory system.

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (Max/Pro subscription)
- [Node.js](https://nodejs.org/) 18+
- [Docker](https://www.docker.com/) with Docker Compose
- [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) container running in `json-rpc` mode
- A registered Signal number for the bot

## Setup

### 1. Clone and install

```bash
git clone https://github.com/youruser/claude-signal-bridge.git
cd claude-signal-bridge
cd host && npm install && cd ..
```

### 2. Configure

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Key settings:
- `BRIDGE_SECRET` — shared secret between host and container
- `SIGNAL_SENDER` — your bot's Signal phone number
- `ALLOWED_NUMBERS` — comma-separated phone numbers/UUIDs allowed to message
- `PROJECT_DIR` — folder Claude opens in (where your CLAUDE.md lives)
- `GROUP_PREFIX` — word that triggers the bot in group chats (default: "chad")

### 3. Set up signal-cli

You need a signal-cli-rest-api container running in `json-rpc` mode on the same Docker network. The bridge connects via WebSocket.

### 4. Create your bot persona (optional)

Create a folder for your bot and add a `CLAUDE.md`:

```bash
mkdir ~/my-bot
```

Write a `CLAUDE.md` with personality rules, then set `PROJECT_DIR` to that folder.

### 5. Start

**Windows:**
```bash
start.bat
```

**Manual:**
```bash
# Terminal 1: Start the host
cd host
set BRIDGE_SECRET=your-secret
set PROJECT_DIR=C:\path\to\your\project
node index.js

# Terminal 2: Start the container
docker compose up -d
```

### 6. Open settings

Go to `http://localhost:3100` to configure Signal API URL, allowed numbers, group settings, etc.

## Architecture

### Host (`host/index.js`)
- Spawns Claude CLI in `node-pty` (persistent, visible terminal)
- Shadow `@xterm/headless` terminal receives all PTY bytes for text extraction
- Snapshots screen → finds input message → extracts white `●` response blocks below it
- SSE streaming endpoint for real-time response delivery
- Permission prompt detection and relay
- Express API on port 3101

### Container (`container/src/`)
- Connects to signal-cli via WebSocket (json-rpc mode)
- Message queue with sequential processing
- `cleanForSignal()` filters TUI artifacts from responses
- Splits responses on `●` markers — each becomes a separate Signal message
- Settings UI (Tailwind dark theme) on port 3100
- SQLite for settings persistence and message log
- Rate limiting, auth, group prefix handling

### Text Extraction (the hard part)

Claude Code renders a rich TUI via Ink (React for CLI) with cursor positioning, spinners, box-drawing, and status bars. The bridge uses a **persistent shadow terminal** approach:

1. `@xterm/headless` Terminal instance receives every PTY byte — tracks full screen state
2. On response complete (prompt detected), snapshot the screen buffer
3. Find the input message on screen as an anchor point
4. Extract only white `●` blocks (Claude's prose) below the input
5. Skip green `●` (tool calls), spinners, status bars, and other TUI chrome
6. Container-side cleanup removes any remaining artifacts

## Settings

All configurable via the web UI at `localhost:3100`:

| Setting | Description |
|---------|-------------|
| Signal API URL | signal-cli REST API endpoint |
| Sender Number | Bot's Signal phone number |
| Allowed Numbers | Who can message (phone numbers and/or UUIDs) |
| Allowed Groups | Group IDs (empty = all allowed) |
| Approval Numbers | Who can approve permission prompts |
| PTY Host URL | Host API endpoint |
| Project Directory | Folder Claude opens in |
| Group Chat Prefix | Trigger word for group messages |
| Bridge Enabled | Master on/off toggle |
| Group Messages | Enable/disable group chat support |

## License

MIT
