// Skyrim-style compass strip: turns with the way the player is facing and shows quest
// targets and your destination by their bearing.
const FIELD = 180; // degrees of the horizon shown across the strip
const LABELS = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };

// Signed difference a - b in degrees, wrapped to -180..180.
function wrap(deg) {
  return ((deg % 360) + 540) % 360 - 180;
}

// Bearing from (x, y) to (tx, ty) in Skyrim units: 0 = north, clockwise.
export function bearing(x, y, tx, ty) {
  return (Math.atan2(tx - x, ty - y) * 180) / Math.PI;
}

export function createCompass(canvas) {
  const ctx = canvas.getContext('2d');
  let shown = null; // smoothed heading in degrees
  let target = null;
  let marks = []; // { deg, kind: 'quest' | 'dest' }

  function setHeading(radians) {
    target = (radians * 180) / Math.PI;
    if (shown === null) shown = target;
  }

  function setMarks(next) {
    marks = next;
  }

  function draw(dt) {
    if (target === null) return;
    shown += wrap(target - shown) * (1 - Math.exp(-dt * 12));

    const dpr = devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const mid = w / 2, perDeg = w / FIELD;
    const x = (deg) => mid + wrap(deg - shown) * perDeg;

    // Ticks every 15°, letters at the eight points.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let deg = 0; deg < 360; deg += 15) {
      const d = wrap(deg - shown);
      if (Math.abs(d) > FIELD / 2) continue;
      const px = x(deg);
      const fade = 1 - (Math.abs(d) / (FIELD / 2)) ** 3;
      const label = LABELS[deg];
      ctx.globalAlpha = fade;
      if (label) {
        const cardinal = label.length === 1;
        ctx.fillStyle = cardinal ? '#e9cf8f' : '#c8a96a';
        ctx.font = cardinal ? '700 15px Cinzel, Georgia, serif' : '500 11px Cinzel, Georgia, serif';
        ctx.fillText(label, px, h / 2 - 2);
      } else {
        ctx.fillStyle = 'rgba(236, 230, 218, 0.45)';
        ctx.fillRect(px - 0.5, h / 2 - 6, 1, 8);
      }
    }

    // Targets: off-strip ones sit at the edge, dimmed, so you know which way to turn.
    for (const m of marks) {
      const d = wrap(m.deg - shown);
      const off = Math.abs(d) > FIELD / 2 - 4;
      const px = mid + Math.max(-FIELD / 2 + 4, Math.min(FIELD / 2 - 4, d)) * perDeg;
      ctx.globalAlpha = off ? 0.45 : 1;
      ctx.fillStyle = m.kind === 'dest' ? '#7fd3ff' : '#ffc850';
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (m.kind === 'dest') {
        ctx.arc(px, h - 7, 4, 0, Math.PI * 2);
      } else {
        ctx.moveTo(px, h - 3);
        ctx.lineTo(px - 5, h - 11);
        ctx.lineTo(px + 5, h - 11);
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
    }

    // Facing notch.
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#e9cf8f';
    ctx.beginPath();
    ctx.moveTo(mid, 3);
    ctx.lineTo(mid - 4, -1);
    ctx.lineTo(mid + 4, -1);
    ctx.closePath();
    ctx.fill();
  }

  return { setHeading, setMarks, draw };
}
