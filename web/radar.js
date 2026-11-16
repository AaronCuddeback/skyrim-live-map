// Player-relative radar, shown inside interiors where the world map doesn't apply.
const COLORS = { hostile: '#e05252', ally: '#55c776', neutral: '#e3cf8c', dead: '#6d6b67' };
const RANGE = 2500; // Skyrim units from center to edge (~36 m)

export function drawRadar(canvas, state) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, c = w / 2, r = c - 6, k = r / RANGE;
  ctx.clearRect(0, 0, w, w);

  ctx.strokeStyle = 'rgba(200,169,106,0.25)';
  ctx.lineWidth = 2;
  for (const f of [1, 0.66, 0.33]) {
    ctx.beginPath();
    ctx.arc(c, c, r * f, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Rotate the world so the player always faces up.
  const cos = Math.cos(state.h), sin = Math.sin(state.h);
  for (const a of state.actors ?? []) {
    const dx = a.x - state.x, dy = a.y - state.y;
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    const dist = Math.hypot(rx, ry);
    if (dist > RANGE * 1.05) continue;
    const px = c + rx * k, py = c - ry * k;
    const above = a.z - state.z;
    ctx.fillStyle = COLORS[a.state] ?? COLORS.neutral;
    ctx.globalAlpha = Math.abs(above) > 300 ? 0.45 : 1; // different floor
    ctx.beginPath();
    ctx.arc(px, py, a.state === 'hostile' ? 9 : 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.fillStyle = '#f3d58a';
  ctx.strokeStyle = '#1a1408';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(c, c - 18);
  ctx.lineTo(c + 12, c + 12);
  ctx.lineTo(c, c + 5);
  ctx.lineTo(c - 12, c + 12);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
}
