// In-game hotkeys. The plugin sends { t: 'input', a: action, s: 1 } when a key goes
// down (repeated while it's held) and s: 0 when it's released. Zoom and pan keys act
// for as long as they're held; the others fire once per press.
const HOLD_TIMEOUT = 0.8; // seconds without a repeat before a held key counts as released
const CONTINUOUS = new Set(['zoomIn', 'zoomOut', 'panUp', 'panDown', 'panLeft', 'panRight']);

export function createRemote(actions) {
  const held = new Map(); // action -> seconds left before it times out

  function handle(msg) {
    if (!msg.a) return;
    if (msg.tap) {
      // One step, from a button in the in-game menu.
      if (msg.a === 'zoomIn') actions.zoom(1 / 1.5);
      else if (msg.a === 'zoomOut') actions.zoom(1.5);
      else if (msg.a.startsWith('pan')) {
        const dir = { panUp: [0, 1], panDown: [0, -1], panLeft: [-1, 0], panRight: [1, 0] }[msg.a];
        actions.pan(dir[0], dir[1], 0.35);
      } else actions[msg.a]?.();
      return;
    }
    if (CONTINUOUS.has(msg.a)) {
      if (msg.s) held.set(msg.a, HOLD_TIMEOUT);
      else held.delete(msg.a);
    } else if (msg.s && !msg.repeat) {
      actions[msg.a]?.();
    }
  }

  function tick(dt) {
    if (!held.size) return;
    let zoom = 0, x = 0, y = 0;
    for (const [action, left] of held) {
      if (left - dt <= 0) held.delete(action);
      else held.set(action, left - dt);
      if (action === 'zoomIn') zoom -= 1;
      if (action === 'zoomOut') zoom += 1;
      if (action === 'panLeft') x -= 1;
      if (action === 'panRight') x += 1;
      if (action === 'panUp') y += 1;
      if (action === 'panDown') y -= 1;
    }
    if (zoom) actions.zoom(Math.exp(zoom * dt * 1.4));
    if (x || y) actions.pan(x, y, dt);
  }

  return { handle, tick };
}
