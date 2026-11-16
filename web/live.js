// WebSocket link to the relay server, with automatic reconnect.
export function connectLive({ onOpen, onClose, onState, onActors, onQuests, onPlayer, onDiscovered, onInventory, onMagic, onInput, onBuild }) {
  let delay = 500;

  function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/live`);
    ws.onopen = () => {
      delay = 500;
      onOpen();
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'state') onState?.(msg);
      else if (msg.t === 'actors') onActors(msg);
      else if (msg.t === 'quests') onQuests(msg);
      else if (msg.t === 'player') onPlayer(msg);
      else if (msg.t === 'discovered') onDiscovered(msg);
      else if (msg.t === 'inventory') onInventory(msg);
      else if (msg.t === 'magic') onMagic(msg);
      else if (msg.t === 'input') onInput(msg);
      else if (msg.t === 'build') onBuild?.(msg);
    };
    ws.onclose = () => {
      onClose();
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 5000);
    };
  }
  open();
}
