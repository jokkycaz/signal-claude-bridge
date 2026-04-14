function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

export function renderPage(settings, log, status) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Claude Signal Bridge</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>tailwind.config = { darkMode: 'class' }</script>
  <meta http-equiv="refresh" content="10">
</head>
<body class="dark bg-gray-950 text-gray-100 min-h-screen">
  <div class="max-w-4xl mx-auto p-6">

    <!-- Header -->
    <div class="flex items-center justify-between mb-8">
      <h1 class="text-2xl font-bold">Claude Signal Bridge</h1>
      <div class="flex items-center gap-3">
        <span class="inline-flex items-center gap-1.5 text-sm">
          <span class="w-2 h-2 rounded-full ${status.claudeReady ? (status.claudeBusy ? 'bg-yellow-400' : 'bg-green-400') : 'bg-red-400'}"></span>
          Claude: ${status.claudeReady ? (status.claudeBusy ? 'Busy' : 'Ready') : status.claudeError ? 'Disconnected' : 'Starting...'}
        </span>
        <span class="inline-flex items-center gap-1.5 text-sm">
          <span class="w-2 h-2 rounded-full ${status.signalConnected ? 'bg-green-400' : status.enabled ? 'bg-yellow-400' : 'bg-gray-500'}"></span>
          Signal: ${status.signalConnected ? 'Connected' : status.enabled ? 'Connecting...' : 'Paused'}
        </span>
        <form method="POST" action="/toggle" class="inline">
          <button type="submit" class="px-3 py-1.5 rounded text-xs font-medium ${status.enabled
            ? 'bg-yellow-900/30 text-yellow-400 hover:bg-yellow-900/50'
            : 'bg-green-900/30 text-green-400 hover:bg-green-900/50'}">
            ${status.enabled ? 'Pause' : 'Resume'}
          </button>
        </form>
      </div>
    </div>

    <!-- Settings -->
    <div class="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
      <h2 class="text-lg font-semibold mb-4">Settings</h2>
      <form method="POST" action="/settings" class="space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-sm text-gray-400 mb-1">Signal API URL</label>
            <input type="text" name="signal_api_url" value="${esc(settings.signal_api_url)}"
              class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">Sender Number (bot)</label>
            <input type="text" name="signal_sender" value="${esc(settings.signal_sender)}"
              class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">Allowed Numbers (comma-separated)</label>
            <input type="text" name="allowed_numbers" value="${esc(settings.allowed_numbers)}"
              placeholder="+1234567890"
              class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">Approval Numbers (who can approve prompts)</label>
            <input type="text" name="approval_numbers" value="${esc(settings.approval_numbers)}"
              placeholder="+1234567890"
              class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
            <p class="text-xs text-gray-600 mt-1">Only these numbers/UUIDs can approve permission prompts. Empty = anyone allowed can approve.</p>
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">Allowed Groups (comma-separated)</label>
            <input type="text" name="allowed_groups" value="${esc(settings.allowed_groups)}"
              class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">Claude PTY Host URL</label>
            <input type="text" name="pty_host_url" value="${esc(settings.pty_host_url)}"
              class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">Claude Project Directory</label>
            <input type="text" name="project_dir" value="${esc(settings.project_dir)}"
              placeholder="C:\\path\\to\\your\\project"
              class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
            <p class="text-xs text-gray-600 mt-1">Changing this restarts the Claude session.</p>
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">Group Chat Prefix</label>
            <input type="text" name="group_prefix" value="${esc(settings.group_prefix)}"
              placeholder="chad"
              class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500">
            <p class="text-xs text-gray-600 mt-1">Word that triggers the bot in group chats.</p>
          </div>
        </div>
        <div class="flex items-center gap-4">
          <label class="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
            <input type="checkbox" name="enabled" ${settings.enabled === 'true' ? 'checked' : ''}
              class="w-4 h-4 rounded bg-gray-800 border-gray-700">
            Bridge Enabled
          </label>
          <label class="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
            <input type="checkbox" name="groups_enabled" ${settings.groups_enabled === 'true' ? 'checked' : ''}
              class="w-4 h-4 rounded bg-gray-800 border-gray-700">
            Group Messages
          </label>
          <button type="submit"
            class="px-4 py-2 rounded bg-blue-900/30 text-blue-400 hover:bg-blue-900/50 text-sm font-medium">
            Save Settings
          </button>
        </div>
      </form>
    </div>

    <!-- Message Log -->
    <div class="bg-gray-900 border border-gray-800 rounded-lg p-6">
      <h2 class="text-lg font-semibold mb-4">Message Log</h2>
      <div class="space-y-3 max-h-[500px] overflow-y-auto">
        ${log.length === 0 ? '<p class="text-gray-500 text-sm">No messages yet. Send a Signal message to get started.</p>' : ''}
        ${log.map(m => `
          <div class="border-b border-gray-800/50 pb-2">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs font-medium ${m.direction === 'incoming' ? 'text-blue-400' : 'text-green-400'}">
                ${m.direction === 'incoming' ? 'You' : 'Claude'}
              </span>
              <span class="text-xs text-gray-600">${new Date(m.timestamp).toLocaleString()}</span>
              ${m.sender ? `<span class="text-xs text-gray-600">${esc(m.sender)}</span>` : ''}
            </div>
            <pre class="text-sm text-gray-300 whitespace-pre-wrap font-sans">${esc(m.message?.substring(0, 500) || '')}</pre>
          </div>
        `).join('')}
      </div>
    </div>
  </div>
</body>
</html>`;
}
