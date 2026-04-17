#!/bin/bash
# Maintenance script: send "memory check" to Claude CLI, then restart the bridge container.
# Scheduled at 5 AM and 5 PM ET via Windows Task Scheduler.

SECRET="claude-signal-bridge-s3cret"
HOST_URL="http://127.0.0.1:3101"
CONTAINER="claude-signal-bridge-claude-bridge-1"
LOGFILE="C:/users/jokky/documents/claude-signal-bridge/maintenance.log"

log() { echo "[$(date)] $*" | tee -a "$LOGFILE"; }

log "Starting maintenance cycle"

# Send "memory check" to Claude CLI via PTY host API.
# The /message endpoint is SSE — curl blocks until Claude finishes or 5-min timeout.
log "Sending 'memory check' to Claude..."
curl -s -N --max-time 300 \
  -H "Content-Type: application/json" \
  -H "X-Bridge-Secret: $SECRET" \
  -d '{"text":"memory check"}' \
  "$HOST_URL/message" > /dev/null 2>&1

log "Memory check finished, giving 10s buffer before restart..."
sleep 10

# Restart the bridge container
log "Restarting bridge container..."
docker restart "$CONTAINER"

log "Maintenance cycle complete"
