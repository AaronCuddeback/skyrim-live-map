// Character sheet: inventory and magic, rebuilt from the plugin's batched packets.
const INVENTORY_CATEGORIES = [
  ['all', 'All', '🎒'], ['weapon', 'Weapons', '⚔'], ['apparel', 'Apparel', '🛡'], ['potion', 'Potions', '🧪'],
  ['poison', 'Poisons', '☠'], ['food', 'Food', '🍖'], ['ingredient', 'Ingredients', '🌿'], ['scroll', 'Scrolls', '📜'],
  ['book', 'Books', '📕'], ['ammo', 'Ammo', '🏹'], ['soulgem', 'Soul gems', '💎'], ['key', 'Keys', '🗝'], ['misc', 'Misc', '📦'],
];
const MAGIC_CATEGORIES = [
  ['all', 'All', '✨'], ['alteration', 'Alteration', '🌀'], ['conjuration', 'Conjuration', '👻'], ['destruction', 'Destruction', '🔥'],
  ['illusion', 'Illusion', '🎭'], ['restoration', 'Restoration', '✚'], ['power', 'Powers', '⭐'], ['shout', 'Shouts', '🗣'], ['other', 'Other', '•'],
];
const EQUIPPED = { left: 'Left hand', right: 'Right hand', both: 'Both hands', power: 'Equipped' };

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function createSheet({ root, list, cats, summary, search, sort, tabs }) {
  const data = { inventory: null, magic: null };
  const batches = {};
  const state = { tab: 'inventory', category: 'all' };
  let lastRender = '';

  function receive(type, msg) {
    const field = type === 'inventory' ? 'items' : 'spells';
    let b = batches[type];
    if (!b || b.seq !== msg.seq) b = batches[type] = { seq: msg.seq, parts: msg.parts, got: new Set(), entries: [] };
    if (b.got.has(msg.part)) return;
    b.got.add(msg.part);
    b.entries.push(...msg[field]);
    if (b.got.size === b.parts) {
      data[type] = b.entries;
      if (!root.hidden && state.tab === type) render();
    }
  }

  function categories() {
    return state.tab === 'inventory' ? INVENTORY_CATEGORIES : MAGIC_CATEGORIES;
  }

  function render() {
    const entries = data[state.tab];
    const query = search.value.trim().toLowerCase();
    const counts = {};
    for (const e of entries ?? []) counts[e.k] = (counts[e.k] ?? 0) + 1;

    // Category chips: only the ones you have something in.
    const chips = categories().filter(([key]) => key === 'all' || counts[key]);
    if (!chips.some(([key]) => key === state.category)) state.category = 'all';
    const chipsHtml = chips.map(([key, label, icon]) =>
      `<button class="chip" data-cat="${key}" aria-pressed="${key === state.category}">${icon} ${label} <small>${key === 'all' ? entries?.length ?? 0 : counts[key]}</small></button>`).join('');

    let rows = (entries ?? []).filter((e) => (state.category === 'all' || e.k === state.category) && (!query || e.n.toLowerCase().includes(query)));
    const by = sort.value;
    rows.sort((a, b) => {
      if (state.tab === 'inventory') {
        if (by === 'value') return b.v * b.c - a.v * a.c || a.n.localeCompare(b.n);
        if (by === 'weight') return b.w * b.c - a.w * a.c || a.n.localeCompare(b.n);
        if (by === 'ratio') return (b.w ? b.v / b.w : Infinity) - (a.w ? a.v / a.w : Infinity) || a.n.localeCompare(b.n);
      } else if (by === 'value') {
        return b.c - a.c || a.n.localeCompare(b.n); // "value" = magicka cost for spells
      }
      // Equipped first, then alphabetical.
      return Boolean(b.e || b.eq) - Boolean(a.e || a.eq) || a.n.localeCompare(b.n);
    });

    let summaryText;
    let rowsHtml;
    if (!entries) {
      summaryText = '';
      rowsHtml = '<li class="empty">Waiting for the game… (needs SkyrimLiveMap plugin 0.6.0 or newer)</li>';
    } else if (state.tab === 'inventory') {
      const weight = entries.reduce((n, e) => n + e.w * e.c, 0);
      const value = entries.reduce((n, e) => n + e.v * e.c, 0);
      summaryText = `${entries.length} items · ${Math.round(weight)} weight · ${value.toLocaleString()} gold in value`;
      rowsHtml = rows.map((e) => {
        const icon = INVENTORY_CATEGORIES.find(([key]) => key === e.k)?.[2] ?? '📦';
        const stat = e.d ? `<span class="stat">⚔ ${e.d}</span>` : e.a ? `<span class="stat">🛡 ${e.a}</span>` : '';
        const tags = [e.e && '<span class="tag eq">Equipped</span>', e.f && '<span class="tag">★</span>', e.x && '<span class="tag ench">Enchanted</span>', e.q && '<span class="tag quest">Quest</span>'].filter(Boolean).join('');
        return `<li><span class="ic">${icon}</span><span class="nm">${escape(e.n)}${e.c > 1 ? ` <small>×${e.c}</small>` : ''}${tags}</span><span class="meta">${stat}<span>${(e.w * e.c).toFixed(e.w * e.c < 10 ? 1 : 0)} wt</span><span>${(e.v * e.c).toLocaleString()} g</span></span></li>`;
      }).join('') || '<li class="empty">Nothing here.</li>';
    } else {
      summaryText = `${entries.filter((e) => e.k !== 'shout' && e.k !== 'power').length} spells · ${entries.filter((e) => e.k === 'power').length} powers · ${entries.filter((e) => e.k === 'shout').length} shouts`;
      rowsHtml = rows.map((e) => {
        const icon = MAGIC_CATEGORIES.find(([key]) => key === e.k)?.[2] ?? '•';
        const tag = e.eq ? `<span class="tag eq">${EQUIPPED[e.eq] ?? 'Equipped'}</span>` : '';
        const cost = e.c ? `<span>${e.c} mp</span>` : '';
        return `<li><span class="ic">${icon}</span><span class="nm">${escape(e.n)}${tag}${e.fx ? `<small class="fx">${escape(e.fx)}</small>` : ''}</span><span class="meta">${cost}</span></li>`;
      }).join('') || '<li class="empty">Nothing here.</li>';
    }

    // Skip identical re-renders so the list doesn't jump while you scroll.
    const key = chipsHtml + summaryText + rowsHtml;
    if (key === lastRender) return;
    lastRender = key;
    cats.innerHTML = chipsHtml;
    summary.textContent = summaryText;
    list.innerHTML = rowsHtml;
  }

  cats.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cat]');
    if (!chip) return;
    state.category = chip.dataset.cat;
    render();
  });
  search.addEventListener('input', render);
  sort.addEventListener('change', render);
  for (const tab of tabs) {
    tab.addEventListener('click', () => open(tab.dataset.tab));
  }

  function open(tab) {
    state.tab = tab;
    state.category = 'all';
    search.value = '';
    sort.querySelector('[value="value"]').textContent = tab === 'inventory' ? 'Value' : 'Magicka cost';
    sort.querySelector('[value="weight"]').hidden = tab !== 'inventory';
    sort.querySelector('[value="ratio"]').hidden = tab !== 'inventory';
    if (tab !== 'inventory' && (sort.value === 'weight' || sort.value === 'ratio')) sort.value = 'name';
    for (const t of tabs) t.setAttribute('aria-pressed', String(t.dataset.tab === tab));
    root.hidden = false;
    lastRender = '';
    render();
  }

  return {
    receive,
    open,
    close: () => { root.hidden = true; },
    get isOpen() { return !root.hidden; },
  };
}
