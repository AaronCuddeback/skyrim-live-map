// Builds maps with tools/extract_map.py: by itself the first time a game the relay has
// no map for connects, and again when someone asks for a rebuild (after a modlist update).
// Progress goes to every viewer as {"t":"build"} messages.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const normPath = (p) => (p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export function createMapBuilder({ dataDir, python, toolsDir, broadcast, onBuilt }) {
  let status = null;       // the last build's {"t":"build"} message
  const tried = new Set(); // game folders already built (or failed) this session

  function datasets() {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataDir, 'datasets.json'), 'utf8'));
    } catch {
      return [];
    }
  }

  function report(fields) {
    status = { t: 'build', ...status, ...fields };
    broadcast(JSON.stringify(status));
  }

  function run(args, info) {
    console.log(`\n[maps] building the map for ${info.label}`);
    status = null;
    report({ state: 'running', game: info.game ?? null, id: info.id ?? null, label: info.label, line: 'Starting…', error: null });
    let finished = false;
    const child = spawn(python, ['-u', path.join(toolsDir, 'extract_map.py'), ...args], {
      cwd: toolsDir,
      env: { ...process.env, SLM_DATA: dataDir, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });
    // A build is a minute of heavy CPU work; never let it compete with the game.
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch { /* best effort */ }
    const tail = [];
    let lastSent = 0;
    const take = (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        console.log(`[maps] ${line}`);
        tail.push(line.trim());
        if (tail.length > 8) tail.shift();
        if (Date.now() - lastSent > 500) {
          lastSent = Date.now();
          report({ line: line.trim() });
        }
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (err) => finish(1, err.message));
    child.on('close', (code) => finish(code));

    function finish(code, error) {
      if (finished) return;
      finished = true;
      if (code === 0) {
        const built = info.game ? datasets().find((d) => d.gamePath === normPath(info.game)) : datasets().find((d) => d.id === info.id);
        console.log(`[maps] done: ${built?.name ?? info.label}`);
        report({ state: 'done', id: built?.id ?? info.id ?? null, label: built?.name ?? info.label, line: 'Map ready' });
        onBuilt?.();
      } else {
        const why = error ?? tail.filter((l) => !l.startsWith('File ') && !l.startsWith('Traceback')).at(-1) ?? `exit code ${code}`;
        console.warn(`[maps] failed: ${why}`);
        report({ state: 'failed', error: why });
      }
    }
  }

  return {
    get status() { return status; },
    get busy() { return status?.state === 'running'; },

    // Each state packet: build a map for a game folder that doesn't have one yet.
    onState(state) {
      const game = state.game;
      if (!game || this.busy || tried.has(normPath(game))) return;
      tried.add(normPath(game));
      if (datasets().some((d) => d.gamePath === normPath(game))) return;
      const args = ['--game', game];
      // From plugin 0.9: where the MO2 that launched the game lives ("" = not MO2).
      if (typeof state.mo2 === 'string') args.push('--mo2-dir', state.mo2);
      run(args, { game, label: game });
    },

    // Rebuild an existing map from the setup it was made from.
    rebuild(id) {
      if (this.busy) return { ok: false, error: 'a map is already being built' };
      const entry = datasets().find((d) => d.id === id);
      if (!entry) return { ok: false, error: 'no such map' };
      const source = entry.source ?? {};
      const args = source.mo2
        ? ['--mo2', source.mo2, ...(source.profile ? ['--profile', source.profile] : [])]
        : ['--data', source.data ?? path.join(entry.gamePath, 'Data')];
      if (entry.name) args.push('--name', entry.name);
      run(args, { id, label: entry.name });
      return { ok: true };
    },
  };
}
