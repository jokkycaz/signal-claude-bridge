/**
 * Reads profiles.json and launches a Claude PTY host instance for each profile
 * in a separate Windows Terminal tab.
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Try multiple locations for profiles.json
const candidates = [
  join(__dirname, '..', 'data', 'profiles.json'),   // Docker volume mount
  join(__dirname, '..', 'profiles.json'),            // Project root
];

let profiles = null;
for (const path of candidates) {
  try {
    profiles = JSON.parse(readFileSync(path, 'utf-8'));
    console.log(`Loaded ${profiles.length} profile(s) from ${path}`);
    break;
  } catch {}
}

if (!profiles || profiles.length === 0) {
  console.error('No profiles.json found or empty. Expected locations:');
  candidates.forEach(p => console.error(`  - ${p}`));
  console.error('\nCreate profiles via the Settings UI first, or create profiles.json manually:');
  console.error(JSON.stringify([{ id: 'chad', name: 'Chad', port: 3101, projectDir: 'C:\\path\\to\\project' }], null, 2));
  process.exit(1);
}

const bridgeSecret = process.env.BRIDGE_SECRET || 'claude-signal-bridge-s3cret';

for (const profile of profiles) {
  const { id, name, port, projectDir } = profile;
  if (!port || !projectDir) {
    console.warn(`Skipping profile "${id}": missing port or projectDir`);
    continue;
  }

  const title = `${name || id} (:${port})`;
  const envVars = `set BRIDGE_SECRET=${bridgeSecret}&& set PTY_PORT=${port}&& set PROJECT_DIR=${projectDir}`;
  const cmd = `wt -w 0 nt --title "${title}" -d "${join(__dirname)}" cmd /k "${envVars}&& node index.js"`;

  console.log(`Launching: ${title} → ${projectDir} on port ${port}`);
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch (err) {
    console.error(`Failed to launch ${id}: ${err.message}`);
  }
}

console.log(`\nAll ${profiles.length} host(s) launched.`);
