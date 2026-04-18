function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function statusDot(status) {
  if (!status) return '<span class="w-2 h-2 rounded-full bg-gray-500"></span>';
  if (status.ready && status.busy) return '<span class="w-2 h-2 rounded-full bg-yellow-400"></span>';
  if (status.ready) return '<span class="w-2 h-2 rounded-full bg-green-400"></span>';
  return '<span class="w-2 h-2 rounded-full bg-red-400"></span>';
}

function statusText(status) {
  if (!status) return 'Unknown';
  if (status.ready && status.busy) return 'Busy';
  if (status.ready) return 'Ready';
  if (status.error) return 'Offline';
  return 'Starting...';
}

function groupLabel(groupId, groupNames) {
  const name = groupNames[groupId];
  const short = groupId.substring(0, 8) + '...';
  return name ? `${name} (${short})` : short;
}

export function renderPage(settings, log, status) {
  const { profiles = [], groupNames = {}, signalConnected, enabled } = status;
  const onlineCount = profiles.filter(p => p.status?.ready).length;

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
          <span class="w-2 h-2 rounded-full ${signalConnected ? 'bg-green-400' : enabled ? 'bg-yellow-400' : 'bg-gray-500'}"></span>
          Signal: ${signalConnected ? 'Connected' : enabled ? 'Connecting...' : 'Paused'}
        </span>
        <span class="text-sm text-gray-400">Profiles: ${onlineCount}/${profiles.length} online</span>
        <form method="POST" action="/toggle" class="inline">
          <button type="submit" class="px-3 py-1.5 rounded text-xs font-medium ${enabled
            ? 'bg-yellow-900/30 text-yellow-400 hover:bg-yellow-900/50'
            : 'bg-green-900/30 text-green-400 hover:bg-green-900/50'}">
            ${enabled ? 'Pause' : 'Resume'}
          </button>
        </form>
      </div>
    </div>

    <!-- Global Settings -->
    <div class="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
      <h2 class="text-lg font-semibold mb-4">Global Settings</h2>
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
        </div>
        <div class="flex items-center gap-4">
          <label class="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
            <input type="checkbox" name="enabled" ${settings.enabled === 'true' ? 'checked' : ''}
              class="w-4 h-4 rounded bg-gray-800 border-gray-700">
            Bridge Enabled
          </label>
          <button type="submit"
            class="px-4 py-2 rounded bg-blue-900/30 text-blue-400 hover:bg-blue-900/50 text-sm font-medium">
            Save
          </button>
        </div>
      </form>
    </div>

    <!-- Profiles -->
    <div class="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
      <h2 class="text-lg font-semibold mb-4">Profiles</h2>
      <div class="space-y-4">
        ${profiles.map(p => `
          <details class="border border-gray-800 rounded-lg overflow-hidden">
            <summary class="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-800/50">
              <div class="flex items-center gap-3">
                ${statusDot(p.status)}
                <span class="font-medium">${esc(p.name)}</span>
                <code class="text-xs text-gray-500 bg-gray-800 px-1.5 py-0.5 rounded">${esc(p.prefix)}</code>
                <span class="text-xs text-gray-500">:${p.host_port}</span>
                <span class="text-xs text-gray-500">${statusText(p.status)}</span>
              </div>
              <div class="flex items-center gap-2">
                ${p.dm_enabled ? '<span class="text-xs text-purple-400 bg-purple-900/20 px-1.5 py-0.5 rounded">DM</span>' : ''}
                ${p.enabled ? '<span class="text-xs text-green-400">Active</span>' : '<span class="text-xs text-gray-500">Disabled</span>'}
              </div>
            </summary>
            <div class="px-4 pb-4 border-t border-gray-800">
              <form method="POST" action="/profiles/${esc(p.id)}" class="space-y-3 mt-3">
                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <label class="block text-xs text-gray-400 mb-1">Name</label>
                    <input type="text" name="name" value="${esc(p.name)}"
                      class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500">
                  </div>
                  <div>
                    <label class="block text-xs text-gray-400 mb-1">Prefix</label>
                    <input type="text" name="prefix" value="${esc(p.prefix)}"
                      class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500">
                  </div>
                  <div>
                    <label class="block text-xs text-gray-400 mb-1">Host Port</label>
                    <input type="number" name="host_port" value="${p.host_port}"
                      class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500">
                  </div>
                  <div>
                    <label class="block text-xs text-gray-400 mb-1">Project Directory</label>
                    <input type="text" name="project_dir" value="${esc(p.project_dir)}"
                      class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500">
                  </div>
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">Allowed Numbers <span class="text-gray-600">(comma-separated, empty = allow all)</span></label>
                  <input type="text" name="allowed_numbers" value="${esc(p.allowed_numbers)}"
                    class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500">
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">Allowed Groups <span class="text-gray-600">(comma-separated group IDs)</span></label>
                  <input type="text" name="allowed_groups" value="${esc(p.allowed_groups)}"
                    class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500">
                  ${p.allowed_groups ? `<p class="text-xs text-gray-600 mt-1">${p.allowed_groups.split(',').map(g => esc(groupLabel(g.trim(), groupNames))).join(', ')}</p>` : ''}
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">Approval Numbers <span class="text-gray-600">(who can approve permission prompts)</span></label>
                  <input type="text" name="approval_numbers" value="${esc(p.approval_numbers)}"
                    class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500">
                </div>
                <div class="flex items-center gap-4">
                  <label class="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
                    <input type="checkbox" name="dm_enabled" ${p.dm_enabled ? 'checked' : ''}
                      class="w-4 h-4 rounded bg-gray-800 border-gray-700">
                    DM Access
                  </label>
                  <label class="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
                    <input type="checkbox" name="enabled" ${p.enabled ? 'checked' : ''}
                      class="w-4 h-4 rounded bg-gray-800 border-gray-700">
                    Enabled
                  </label>
                  <button type="submit"
                    class="px-3 py-1.5 rounded bg-blue-900/30 text-blue-400 hover:bg-blue-900/50 text-xs font-medium">
                    Save Profile
                  </button>
                </div>
              </form>
              <form method="POST" action="/profiles/${esc(p.id)}/delete" class="mt-3"
                onsubmit="return confirm('Delete profile ${esc(p.name)}?')">
                <button type="submit" class="text-xs text-red-400 hover:text-red-300">Delete Profile</button>
              </form>
            </div>
          </details>
        `).join('')}

        <!-- Add Profile -->
        <details class="border border-dashed border-gray-700 rounded-lg overflow-hidden">
          <summary class="px-4 py-3 cursor-pointer text-gray-400 hover:text-gray-200 text-sm">+ Add Profile</summary>
          <div class="px-4 pb-4 border-t border-gray-800">
            <form method="POST" action="/profiles" class="space-y-3 mt-3">
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs text-gray-400 mb-1">Profile ID <span class="text-gray-600">(short slug)</span></label>
                  <input type="text" name="id" required placeholder="my-bot"
                    class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500">
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">Name</label>
                  <input type="text" name="name" required placeholder="My Bot"
                    class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500">
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">Prefix</label>
                  <input type="text" name="prefix" required placeholder="bot"
                    class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500">
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">Host Port</label>
                  <input type="number" name="host_port" required placeholder="3102"
                    class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500">
                </div>
                <div class="col-span-2">
                  <label class="block text-xs text-gray-400 mb-1">Project Directory</label>
                  <input type="text" name="project_dir" placeholder="C:\\path\\to\\project"
                    class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500">
                </div>
              </div>
              <div>
                <label class="block text-xs text-gray-400 mb-1">Allowed Numbers</label>
                <input type="text" name="allowed_numbers" placeholder="+14042959478"
                  class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500">
              </div>
              <div>
                <label class="block text-xs text-gray-400 mb-1">Allowed Groups</label>
                <input type="text" name="allowed_groups"
                  class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500">
              </div>
              <div>
                <label class="block text-xs text-gray-400 mb-1">Approval Numbers</label>
                <input type="text" name="approval_numbers" placeholder="+14042959478"
                  class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500">
              </div>
              <div class="flex items-center gap-4">
                <label class="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
                  <input type="checkbox" name="dm_enabled" checked
                    class="w-4 h-4 rounded bg-gray-800 border-gray-700">
                  DM Access
                </label>
                <button type="submit"
                  class="px-3 py-1.5 rounded bg-green-900/30 text-green-400 hover:bg-green-900/50 text-xs font-medium">
                  Create Profile
                </button>
              </div>
            </form>
          </div>
        </details>
      </div>
    </div>

    <!-- Message Log -->
    <div class="bg-gray-900 border border-gray-800 rounded-lg p-6">
      <h2 class="text-lg font-semibold mb-4">Message Log</h2>
      <div class="space-y-3 max-h-[500px] overflow-y-auto">
        ${log.length === 0 ? '<p class="text-gray-500 text-sm">No messages yet.</p>' : ''}
        ${log.map(m => `
          <div class="border-b border-gray-800/50 pb-2">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs font-medium ${m.direction === 'incoming' ? 'text-blue-400' : 'text-green-400'}">
                ${m.direction === 'incoming' ? 'In' : 'Out'}
              </span>
              ${m.profile_id ? `<code class="text-xs text-purple-400 bg-purple-900/20 px-1 rounded">${esc(m.profile_id)}</code>` : ''}
              <span class="text-xs text-gray-600">${new Date(m.timestamp).toLocaleString()}</span>
              ${m.sender ? `<span class="text-xs text-gray-600">${esc(m.sender.substring(0, 15))}</span>` : ''}
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
