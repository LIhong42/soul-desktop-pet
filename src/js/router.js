// src/js/router.js — tiny hash-based router
const routes = {};
let onChangeCb = null;

// Tracks the path that was rendered most recently. Detail pages snapshot
// this on mount so the "back" link always points at the page the user was
// on before opening the detail page — even when the previous URL is
// something the detail page itself doesn't recognize (e.g. another
// contact's sub-page). Updated AFTER the handler runs so the snapshot taken
// inside a handler still reflects the prior page, not the current one.
let lastPath = '';

export function register(path, handler) {
  routes[path] = handler;
}

export function onChange(cb) { onChangeCb = cb; }

// Detail pages call this on mount to capture the URL the user came from.
// Returns the path WITHOUT a leading '#', suitable for navigate().
export function getReferrerPath() {
  return lastPath || '';
}

function parseHash() {
  const h = (location.hash || '#/').slice(1); // drop leading #
  const [path, query] = h.split('?');
  const params = {};
  if (query) {
    for (const kv of query.split('&')) {
      const [k, v] = kv.split('=');
      params[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
  }
  const m = matchRoute(path);
  if (!m) return null;
  return { ...m, params, path, query: query || '' };
}

// Find the route pattern that handles `path`.
//
// Match path with optional :param. Static (non-parameterized) patterns are
// matched BEFORE parameterized ones so that e.g. "/contacts/new" wins over
// "/contacts/:id" regardless of registration order. This is critical —
// otherwise "new" gets parsed as an id and contacts:get("new") returns null.
//
// The same precedence applies to "/events/memorial" (the 回忆 list, a
// static route) against "/events/:id" (one event): the static one wins,
// so "/events/memorial" is NOT an event id.
export function matchRoute(path) {
  const patterns = Object.keys(routes);
  const staticPatterns = patterns.filter((p) => !p.includes(':'));
  const dynamicPatterns = patterns.filter((p) => p.includes(':'));
  for (const pattern of [...staticPatterns, ...dynamicPatterns]) {
    const pp = pattern.split('/').filter(Boolean);
    const aa = path.split('/').filter(Boolean);
    if (pp.length !== aa.length) continue;
    let ok = true;
    const args = {};
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) {
        args[pp[i].slice(1)] = decodeURIComponent(aa[i]);
      } else if (pp[i] !== aa[i]) {
        ok = false; break;
      }
    }
    if (ok) return { handler: routes[pattern], pattern, args };
  }
  return null;
}

export async function dispatch() {
  const m = parseHash();
  if (!m) {
    location.hash = '#/today';
    return;
  }
  // The onChange hook is awaited: it is where the background artwork is
  // applied or torn down, and the page's own render() may ask for the same
  // artwork. Letting the two run concurrently would let them interleave —
  // one clears the background while the other is still fetching the URL —
  // and the page would end up half-painted.
  if (onChangeCb) await onChangeCb(m.path);
  try {
    await m.handler(m.args, m.params);
  } catch (e) {
    console.error('route error', e);
    document.getElementById('app').innerHTML =
      `<div class="empty">出错了：${(e && e.message) || e}</div>`;
  }
  // Update lastPath AFTER the handler resolves so a detail page's render()
  // sees the previous page's URL, not its own.
  lastPath = m.path;
}

export function navigate(path) {
  location.hash = '#' + path;
}

export function start() {
  window.addEventListener('hashchange', dispatch);
  if (!location.hash || location.hash === '#' || location.hash === '#/') {
    location.hash = '#/today';
  } else {
    dispatch();
  }
}