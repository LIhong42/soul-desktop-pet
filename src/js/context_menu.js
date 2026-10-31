// src/js/context_menu.js — a small right-click menu for the renderer.
//
// The diary page used to keep its controls in bars that sat between the
// writing and the pictures: a 「插入图片 / 删除此段」 row under every text
// block and a layout switcher under every gallery. On a page that holds
// both words and pictures those bars broke the flow of the document — the
// buttons read as part of what was written.
//
// So the controls moved into a right-click menu: the very same buttons,
// but they appear where the user asks for them. One menu element is
// reused and refilled, the same way the photo lightbox is.
//
// The menu is built from plain items:
//   { label, act, value?, selected?, danger?, disabled? }  a button
//   { row: [ …items ] }                                   a row of buttons
//   { info: true, label }                                  a muted, inert line
//   { sep: true }                                          a divider
//
// `act` and `value` travel back to the caller's `onAction(act, value)`,
// so the caller decides what every entry means.

let menuEl = null;
let current = null;

// Build the menu element once and keep it for the life of the page.
function ensureEl() {
  if (menuEl) return menuEl;

  menuEl = document.createElement('div');
  menuEl.id = 'ctx-menu';
  menuEl.className = 'ctx-menu';
  menuEl.style.display = 'none';
  document.body.appendChild(menuEl);

  // A press on the menu must not move the focus off whatever the user
  // was working in (a textarea whose selection the menu acts on), and it
  // must not let the browser open its own menu.
  menuEl.addEventListener('mousedown', (e) => e.preventDefault());
  menuEl.addEventListener('contextmenu', (e) => e.preventDefault());

  menuEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ctx-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.ctxAct;
    const value = btn.dataset.ctxValue || '';
    const handler = current ? current.onAction : null;
    // The menu goes away before the action runs: an action may open a
    // file picker or rebuild the page, and a menu left on screen would
    // cover the result.
    closeContextMenu();
    if (handler) handler(act, value);
  });

  // A press anywhere else closes the menu. The check is on the capture
  // phase, so the menu is already gone when the press reaches the page.
  document.addEventListener('mousedown', (e) => {
    if (menuEl.contains(e.target)) return;
    closeContextMenu();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeContextMenu();
  });

  // The menu is anchored to a point on the screen, so anything that moves
  // that point (a scroll, a resize, another window taking the focus)
  // has to take the menu down with it.
  window.addEventListener('blur', closeContextMenu);
  window.addEventListener('resize', closeContextMenu);
  window.addEventListener('scroll', closeContextMenu, true);

  return menuEl;
}

// Build one entry of the menu.
function renderItem(item) {
  if (!item) return document.createComment('ctx');
  if (item.sep) {
    const sep = document.createElement('div');
    sep.className = 'ctx-sep';
    return sep;
  }
  if (item.info) {
    const info = document.createElement('div');
    info.className = 'ctx-info';
    // It carries an act too, so a reader of the menu can tell the inert
    // lines from the buttons.
    info.dataset.ctxAct = 'info';
    info.textContent = item.label || '';
    return info;
  }
  if (item.row) {
    const row = document.createElement('div');
    row.className = 'ctx-row';
    for (const sub of item.row) row.appendChild(renderItem(sub));
    return row;
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ctx-item'
    + (item.selected ? ' selected' : '')
    + (item.danger ? ' danger' : '');
  btn.textContent = item.label || '';
  btn.dataset.ctxAct = item.act || '';
  if (item.value) btn.dataset.ctxValue = item.value;
  if (item.disabled) btn.disabled = true;
  if (item.title) btn.title = item.title;
  return btn;
}

// Open the menu at a point on the screen. `items` describes the entries,
// `onAction(act, value)` is called when one of them is picked.
export function openContextMenu(opts) {
  const { x = 0, y = 0, items = [], onAction = null } = opts || {};
  const el = ensureEl();
  current = { onAction };

  el.innerHTML = '';
  for (const item of items) el.appendChild(renderItem(item));
  el.style.display = 'block';

  // Put it at the pointer, then pull it back inside the window if it
  // would hang over an edge.
  const rect = el.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - rect.width - 8);
  }
  if (top + rect.height > window.innerHeight - 8) {
    top = Math.max(8, top - rect.height);
  }
  el.style.left = Math.round(left) + 'px';
  el.style.top = Math.round(top) + 'px';
  return el;
}

// Take the menu down.
export function closeContextMenu() {
  if (!menuEl) return;
  menuEl.style.display = 'none';
  menuEl.innerHTML = '';
  current = null;
}

// Is a menu on screen right now?
export function isContextMenuOpen() {
  return !!menuEl && menuEl.style.display === 'block';
}
