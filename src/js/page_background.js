// src/js/page_background.js — the shared background artwork for the pages
// that wear one.
//
// ---------------------------------------------------------------------------
// What this is
// ---------------------------------------------------------------------------
// The 今日 / 联系人 / 提醒 / 工作事件 / 抽卡 pages paint the artwork
// from `resources/ui/` behind their content. The image is chosen in the main
// process (main/page_background.js) and arrives as a `file://` URL, because
// the renderer can't read the filesystem and the main window's CSP only
// allows `file:` in `img-src`.
//
// The artwork is decoration, so every failure path here degrades to "no
// artwork" rather than to a broken page: a missing IPC bridge, an install
// with no `resources/ui` folder, or a stored id naming a file this machine
// doesn't have all end the same way.
//
// ---------------------------------------------------------------------------
// Why a module instead of a function inside one page
// ---------------------------------------------------------------------------
// The 今日 page used to own this by itself. Several pages now wear the same
// picture, and each of them has to *clean up* after itself when the user
// navigates away — a background left on the scroll container would follow
// the user to every other page (工具, 设置, 回忆 …) and paint the artwork
// there too.
//
// Centralising it here means the paint/teardown pair lives in one place, and
// the router's `onChange` hook (src/js/main.js) can decide from ONE list of
// routes whether the current page wears the artwork.
//
// ---------------------------------------------------------------------------
// The route list
// ---------------------------------------------------------------------------
// `BACKGROUND_ROUTES` is the single source of truth. The main process ships
// the same list (main/page_background.js → `active().routes`) so the two
// can't drift, but the renderer falls back to its own copy when the IPC
// bridge is unavailable — a page that can't ask for its background still has
// to paint *something* sensible rather than a bare surface.
//
// The list is matched EXACTLY, not by prefix: `/contacts` must not light up
// `/contacts/:id`, because the contact detail page paints the artwork on its
// OWN full-bleed wrapper (see src/css/contact.css) rather than on the
// scroll container — the scroll container's padding would cut the picture
// off at the edges.

import { api } from './api.js';

// The pages that wear the artwork. Kept in sync with
// main/page_background.js → BACKGROUND_ROUTES.
export const BACKGROUND_ROUTES = [
  '/today',
  '/contacts',
  '/reminders',
  '/events/work',
  '/card-life',
  // The 打卡墙 — the check-in wall for the 抽卡 page. It wears the
  // same artwork because it is the same page family and its translucent
  // paper sheets are drawn for that picture.
  '/card-life/stats',
];

// The scroll container the artwork is painted onto.
const contentEl = () => document.querySelector('.content');

/**
 * Does this route wear the background artwork?
 *
 * Exact match, so `/contacts/:id` (the contact detail page, which paints the
 * artwork on its own wrapper) does not inherit the list page's background.
 */
export function routeHasBackground(route, routes) {
  const list = (routes && routes.length) ? routes : BACKGROUND_ROUTES;
  return list.includes(route);
}

/**
 * Paint the background onto the scroll container.
 *
 * `background-image` takes the URL, and the `no-art` class is dropped so the
 * artwork shows again after the user turned it off and back on.
 *
 * The artwork is applied to the scroll container rather than to a wrapper
 * inside the page, because the page's own content (a grid of cards, a
 * centred reading column) needs to sit *on* the picture rather than scroll
 * it away.
 */
export async function applyBackground() {
  const el = contentEl();
  if (!el) return;
  try {
    const info = await api.pageBackground.get();
    const current = info && info.current;
    if (current && current.url) {
      el.style.setProperty('--page-bg-image', `url("${current.url}")`);
      el.classList.add('page-bg');
      el.classList.remove('no-art');
    } else {
      // The user turned the background off, or this install has no artwork.
      el.classList.add('page-bg', 'no-art');
      el.style.removeProperty('--page-bg-image');
    }
  } catch (e) {
    console.warn('[bg] could not load the page background:', e);
    el.classList.add('page-bg', 'no-art');
    el.style.removeProperty('--page-bg-image');
  }
}

/**
 * Remove the background again.
 *
 * Called when the user navigates to a page that doesn't wear one — leaving
 * it up would paint the artwork behind every other page too.
 */
export function clearBackground() {
  const el = contentEl();
  if (!el) return;
  el.classList.remove('page-bg', 'no-art');
  el.style.removeProperty('--page-bg-image');
}

/**
 * Paint the background if `route` wears one, and take it away if it doesn't.
 *
 * This is the single entry point the router uses. It is idempotent: calling
 * it twice for the same route paints the same thing twice, which is what
 * makes it safe for a page to call it on its own render as well.
 */
export async function applyBackgroundForRoute(route, routes) {
  if (routeHasBackground(route, routes)) {
    await applyBackground();
  } else {
    clearBackground();
  }
}
