// src/js/pages/contact_detail.js — one contact, one page, one tab per kind.
//
// The 喜好 / 忌讳 / 礼物 data used to live in two places at once: a global
// top-level page per kind (/#/likes, /#/taboos, /#/gifts) AND a preview
// section at the bottom of the contact detail page whose "管理 →" link
// jumped to yet another per-contact page. Three surfaces for the same rows
// meant the same "奶奶喜欢抹茶" could be edited from any of them.
//
// Now every attribute row belongs to exactly one contact, and the contact
// detail page owns all of it:
//
//   #/contacts/:id            → 概览 tab (统计 + 重要日期 + 回忆)
//   #/contacts/:id/likes      → 喜好 tab   (search / filter / 新增 / 批量删除)
//   #/contacts/:id/taboos     → 忌讳 tab
//   #/contacts/:id/gifts      → 礼物 tab
//
// The overview used to carry a 事件 section of its own, next to 重要日期.
// Both hold dated reminders for the same contact — a birthday saved as an
// event and a birthday saved as an important date were two different-looking
// rows in two different blocks — so they share one 重要日期 list now.
//
// The tab bar sits right under the contact header, so switching kind never
// leaves the contact. The global /likes /#/taboos /#/gifts pages are gone.
//
// Per-tab view state (search query, event filter, page, bulk selection) is
// keyed by "contactId:kind" in a module-level Map, so flipping to another
// tab and back keeps whatever the user had typed.

import { api, escapeHtml, displayName, eventKindAttr, contactColorIndex, formatRelative, countdownTo, categoryIcon, toast, getCachedAvatarDataUrl, fetchAvatarDataUrl, getCachedPhotoDataUrl, fetchPhotoDataUrl, wireDateInputs, repeatLabel, eventDisplayTitle, todayYmd } from '../api.js';
import { iconSVG, suggestIconKind } from '../icons.js';
import { register, navigate } from '../router.js';
import {
  bulkEnterLinkHtml, bulkToolbarHtml, bulkSelectableRowHtml,
  wireBulkEnter, wireBulkToolbar, wireBulkRowChecks,
} from '../bulk_delete.js';
import { memorialKindLabel } from '../diary_kinds.js';

// How many rows one page of a kind's list holds.
const PAGE_SIZE = 5;

// Internal short kind ("like" / "taboo" / "gift") ↔ URL long kind
// ("likes" / "taboos" / "gifts"). The tab bar and the route table talk in
// the short form; the URL uses the long form.
//
// `icon` is the glyph on each row's tile. It matches the glyph the 快速记录
// window uses for the same kind (src/js/quick_record.js), so the two places
// that record the same thing look the same.
const KIND_META = {
  like:  { title: '喜好', url: 'likes',  attrKind: 'like',  icon: '💖' },
  taboo: { title: '忌讳', url: 'taboos', attrKind: 'taboo', icon: '🚫' },
  gift:  { title: '礼物', url: 'gifts',  attrKind: 'gift',  icon: '🎁' },
};

// --- Per-contact / per-kind view state ---------------------------------
//
// Keyed by "contactId:kind". Holds the search query, the event filter, the
// current page, whether the add-form is open, and the bulk-delete
// selection (a Set so toggling a checkbox is O(1)).
const viewStates = new Map();

function viewState(contactId, kind) {
  const key = contactId + ':' + kind;
  let s = viewStates.get(key);
  if (!s) {
    s = {
      query: '', eventFilter: '', page: 0,
      formOpen: false,
      selectModeActive: false, selected: new Set(),
      // Called by the bulk toolbar whenever the selection changes, so the
      // page can refresh the "删除选中 (N)" counter without a full repaint.
      onChange: () => {},
    };
    viewStates.set(key, s);
  }
  return s;
}

// --- Pure filters -------------------------------------------------------
//
// The list carries two independent filters that compose (search ∩ event):
//   * "搜索描述…"    : case-insensitive substring of `description`
//   * event dropdown : the year / year-month the row's `event` falls in,
//                     plus "不限" and "未填事件"
// When either is active the rows are re-sorted so date-anchored entries
// rise to the top.

function matchesQuery(item, q) {
  if (!q) return true;
  const desc = (item && item.description) || '';
  return desc.toLowerCase().includes(q);
}

// `filterValue` is one of:
//   ''           — do not filter by event (show everything)
//   '__none__'   — show only items without an event
//   'YYYY'       — show items whose event starts with YYYY
//   'YYYY-MM'    — show items whose event starts with YYYY-MM
function matchesEvent(item, filterValue) {
  if (!filterValue) return true;
  const ev = (item && item.event) || '';
  if (filterValue === '__none__') return !ev;
  return ev.startsWith(filterValue);
}

function matchesEither(item, q, evFilter) {
  return matchesQuery(item, q) && matchesEvent(item, evFilter);
}

// Build the dropdown options from the items of one contact. Includes
// "不限" + "未填事件" + every distinct (year, year-month) tuple observed,
// sorted descending so the most-recent years/months appear first.
function buildEventFilterOptions(items) {
  const yearMonths = new Map(); // year → Set of "MM"
  for (const it of items || []) {
    const ev = it && it.event;
    if (!ev) continue;
    const m = /^(\d{4})(?:-(\d{2}))?/.exec(ev);
    if (!m) continue;
    const y = m[1];
    if (!yearMonths.has(y)) yearMonths.set(y, new Set());
    if (m[2]) yearMonths.get(y).add(m[2]);
  }
  const years = [...yearMonths.keys()].sort().reverse();
  const opts = [{ value: '', label: '不限' }, { value: '__none__', label: '未填事件' }];
  for (const y of years) {
    opts.push({ value: y, label: y + ' 年（全部月份）' });
    const months = [...yearMonths.get(y)].sort().reverse();
    for (const mo of months) opts.push({ value: `${y}-${mo}`, label: `${y}-${mo}` });
  }
  return opts;
}

// Sort helper: items with an event come first by date desc, then items
// without an event retain their original order at the tail.
function sortByEventDesc(items) {
  const indexed = items.map((it, i) => ({ it, i }));
  indexed.sort((a, b) => {
    const ea = a.it.event || '';
    const eb = b.it.event || '';
    if (ea && !eb) return -1;
    if (!ea && eb) return 1;
    if (ea && eb) {
      if (ea < eb) return 1;
      if (ea > eb) return -1;
    }
    return a.i - b.i;
  });
  return indexed.map((x) => x.it);
}

// A single row. Clicking it opens the shared attribute detail page
// (#/attributes/:id), where the row can be edited or deleted.
//
// The row is deliberately a one-liner: a tinted tile carrying the kind's
// glyph, the description, and a chevron on the right. The 事件 date used
// to sit under the description as a second line — it made every row
// two lines tall and the faded date line read as the "real" content, when
// the description is what the user scans for. The date is still one click
// away (the row → the detail page) and still drives the year/month filter
// dropdown above the list, so nothing is lost by dropping it here.
function renderItemRow(it, kind) {
  const meta = KIND_META[kind] || KIND_META.like;
  return `
    <div class="cd-attr-row attribute-clickable" data-id="${escapeHtml(it.id)}">
      <span class="cd-attr-icon" data-kind="${escapeHtml(meta.attrKind)}">${meta.icon}</span>
      <span class="cd-attr-text">${escapeHtml(it.description || '')}</span>
      <span class="cd-attr-go" aria-hidden="true"></span>
    </div>
  `;
}

// --- Header + tab bar ---------------------------------------------------

// The page's artwork.
//
// The page wears the SAME picture as the rest of the app — the one the user
// picked in 设置 (see main/page_background.js). It is painted edge to edge
// behind the whole page, not just behind the header. The image is a ~1.4 MB
// PNG, and it reaches the renderer as a `file://` URL (the renderer can't
// read the filesystem). Loading it takes long enough that a contact page
// painted on demand would show a bare page for a beat before the picture
// appeared.
//
// So it is fetched and preloaded as soon as this module is loaded — which
// happens at app start — and the page then paints with the image already
// in the cache.
//
// The picture is a *choice* the user can change at runtime, so the cached
// URL is only reused while it still matches what the main process reports.
// A stale URL would leave this page showing the previous picture while
// every other page already shows the new one.
let bannerUrl = '';
// The preloaded <img>. It is never drawn — the page paints the picture
// through CSS. It is held here only so the browser does not collect the
// image (and cancel its decode) before the page asks for it.
let bannerImage = null;
// The in-flight fetch. The module-load warm-up and the page's own render
// can ask for the artwork at the same time; sharing one promise means the
// second caller waits for the first answer instead of starting a second
// IPC round trip that could resolve out of order.
//
// The promise is cleared once it settles, so a LATER render asks again —
// that is how a background changed in 设置 reaches the page.
let bannerPending = null;

function warmBanner() {
  if (bannerPending) return bannerPending;
  bannerPending = (async () => {
    try {
      const info = await api.pageBackground.get();
      const current = info && info.current;
      const url = (current && current.url) || '';
      if (url === bannerUrl) return;
      bannerUrl = url;
      if (bannerUrl) {
        // The reference is kept so the preload isn't collected before it has
        // finished decoding.
        bannerImage = new Image();
        bannerImage.src = bannerUrl;
      }
    } catch (e) {
      // No artwork (or no IPC bridge): the page paints the plain warm
      // paper. Not an error worth interrupting the user over.
      console.error('[contact] could not load the page artwork', e);
    } finally {
      bannerPending = null;
    }
  })();
  return bannerPending;
}
warmBanner();

function detailAvatarHTML(c) {
  const url = c.custom_avatar_path ? getCachedAvatarDataUrl(c.id) : '';
  if (url) return `<img src="${escapeHtml(url)}" alt=""/>`;
  const name = c.icon_kind && c.icon_kind !== 'user'
    ? c.icon_kind
    : suggestIconKind(c.relationship);
  return iconSVG(name, { title: displayName(c), size: 32 });
}

// The header is a full-bleed banner: the contact's photo (or glyph), the
// name and the relationship sit on the artwork, washed out on the left so
// the text stays readable while the picture shows through on the right.
//
// The banner itself carries no artwork — the PAGE behind it does (see the
// `.cd-page` rule in src/css/contact.css). The banner only adds a local
// wash so the name and the avatar stay readable where the artwork is
// brightest.
function headerHTML(c) {
  return `
    <header class="cd-banner">
      <div class="cd-banner-inner">
        <div class="cd-avatar" style="color: var(--contact-${contactColorIndex(c.name)})">
          ${detailAvatarHTML(c)}
        </div>
        <div class="cd-banner-text">
          <h1>${escapeHtml(displayName(c))}${c.relationship
            ? `<span class="relationship-sep">·</span><span class="relationship">${escapeHtml(c.relationship)}</span>`
            : ''}</h1>
          <div class="cd-banner-actions">
            <a class="cd-edit-pill" href="#/contacts/${escapeHtml(c.id)}/edit">编辑基本信息<span class="cd-chevron"></span></a>
          </div>
        </div>
      </div>
    </header>
  `;
}

// The tab bar. Each tab is a real hash link, so the browser's back button
// and the "复制链接" affordance keep working, and the active tab is a
// server-rendered `is-active` class rather than a JS toggle.
//
// The 「返回」 link sits at the right end of the same row, so the banner
// stays as clean as the design draws it.
//
// The sheet the row sits on runs the full width of the page, but the row
// inside it follows the same reading column as the cards below — so the
// tabs line up with the content they switch between.
function tabBarHTML(c, active, counts) {
  const tabs = [
    { key: 'overview', label: '概览', href: `#/contacts/${escapeHtml(c.id)}` },
    { key: 'like',  label: KIND_META.like.title,  href: `#/contacts/${escapeHtml(c.id)}/${KIND_META.like.url}`,  count: counts.like },
    { key: 'taboo', label: KIND_META.taboo.title, href: `#/contacts/${escapeHtml(c.id)}/${KIND_META.taboo.url}`, count: counts.taboo },
    { key: 'gift',  label: KIND_META.gift.title,  href: `#/contacts/${escapeHtml(c.id)}/${KIND_META.gift.url}`,  count: counts.gift },
  ];
  return `
    <div class="cd-tabbar">
      <div class="cd-tabbar-inner">
        <nav class="cd-tabs" role="tablist">
          ${tabs.map((t) => `
            <a class="cd-tab${t.key === active ? ' is-active' : ''}"
               role="tab" aria-selected="${t.key === active}"
               href="${t.href}">
              ${escapeHtml(t.label)}${t.count === undefined ? '' : `<span class="cd-tab-count">${t.count}</span>`}
            </a>
          `).join('')}
        </nav>
        <a class="cd-back" href="#/contacts"><span class="icon-arrow-left"></span>返回</a>
      </div>
    </div>
  `;
}

// --- 概览 tab -----------------------------------------------------------

// Timestamp of the next occurrence of an annual date (month/day). Used to
// order the merged 重要日期 list by "how soon it comes up".
function nextAnnualTs(month, day) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let ts = new Date(now.getFullYear(), month - 1, day).getTime();
  if (ts < today) ts = new Date(now.getFullYear() + 1, month - 1, day).getTime();
  return ts;
}

// Timestamp of an event's next firing. An event without any date has no
// place in the ordering, so it sinks to the bottom of the list.
function nextEventTs(e) {
  const s = e.next_fire_at || e.remind_date || '';
  if (!s) return Number.MAX_SAFE_INTEGER;
  const t = Date.parse(String(s).slice(0, 10) + 'T00:00:00');
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
}

// "2027-3-1" — the date a chip shows. No zero padding, the way the design
// writes it, and the year is included because "3-1" alone is ambiguous
// about which occurrence is meant.
function ymdFromTs(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// The date part of a database timestamp ("2026-05-12 09:00:00" → "2026-5-12").
function ymdFromDb(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? `${+m[1]}-${+m[2]}-${+m[3]}` : '';
}

// The countdown line under a date chip: "还有 3 个月", "就是今天", or nothing
// when the moment has passed.
function countdownFromTs(ts) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts === today) return '就是今天';
  return countdownTo(new Date(ts)) || '';
}

// One row of the 重要日期 section — a row from the `important_dates` table.
function importantDateRow(d) {
  const kindTone = d.kind === 'birthday' ? 'birthday'
                 : d.kind === 'anniversary' ? 'anniversary'
                 : 'important';
  const icon = d.kind === 'birthday' ? '🎂'
             : d.kind === 'anniversary' ? '💝'
             : '📅';
  // The chip shows when the date comes up *next* — "2027-3-1" — instead of
  // the bare "每年 3-1", and the countdown underneath says how far away it
  // is. Together they answer "when is it?" in one glance.
  const next = nextAnnualTs(d.month, d.day);
  const cd = countdownFromTs(next);
  const meta = [
    `每年 ${d.month}-${d.day}`,
    d.year ? `${d.year}年生` : '',
    d.remind_enabled === 0 ? '已关闭' : `提醒 ${d.remind_time || '09:00'}`,
    (d.remind_enabled !== 0 && d.advance_days > 0) ? `提前 ${d.advance_days} 天` : '',
  ].filter(Boolean).join(' · ');
  return `
    <div class="card list-row clickable" data-kind="important" data-important="${escapeHtml(d.id)}">
      <div class="lr-id">
        <span class="cat-icon" data-tone="${kindTone}">${icon}</span>
      </div>
      <div class="lr-main">
        <div class="lr-title">${escapeHtml(d.label)} <span class="tag" style="margin-left:6px">${escapeHtml(kindLabel(d.kind))}</span></div>
        <div class="lr-meta">${escapeHtml(meta)}</div>
      </div>
      <div class="lr-side">
        <div class="time-chip"><span class="chip-dot"></span>${ymdFromTs(next)}</div>
        ${cd ? `<div class="time-chip muted">${escapeHtml(cd)}</div>` : ''}
      </div>
    </div>
  `;
}

// One row of the same section — a row from the `events` table (a birthday
// or anniversary the user created as an event, or any dated reminder).
function eventRow(e) {
  const kind = eventKindAttr(e);
  const at = e.next_fire_at || e.remind_date || '';
  const dateText = ymdFromDb(at);
  const cd = countdownTo(at);
  // A reminder that fires within the day is worth shouting about; the
  // countdown line turns warm, the chip stays quiet.
  const soon = !!cd && /分钟|小时/.test(cd);
  return `
    <div class="card list-row clickable" data-kind="${escapeHtml(kind)}" data-id="${escapeHtml(e.id)}" data-category="${escapeHtml(e.category || 'general')}">
      <div class="lr-id">
        <span class="cat-icon" data-tone="${escapeHtml(kind)}">${escapeHtml(categoryIcon(e.category, e.tag_kind))}</span>
      </div>
      <div class="lr-main">
        <div class="lr-title">${escapeHtml(eventDisplayTitle(e) || '(无标题)')}</div>
        <div class="lr-meta">${escapeHtml(repeatLabel(e))}${e.active ? '' : ' · 已结束'}</div>
      </div>
      <div class="lr-side">
        ${dateText ? `<div class="time-chip"><span class="chip-dot"></span>${dateText}</div>` : ''}
        ${cd ? `<div class="time-chip muted${soon ? ' cd-soon' : ''}">${escapeHtml(cd)}</div>` : ''}
      </div>
    </div>
  `;
}

// A memorial event row. The tile holds the first photo when there is one —
// the memory *is* the picture — and falls back to the category glyph.
function memorialRow(e) {
  const photoId = e.first_photo_id || (e.photo_ids && e.photo_ids[0]) || '';
  const details = [e.place, e.activities, e.notes].filter(Boolean).join(' · ');
  const meta = [
    e.photo_count > 0 ? `${e.photo_count} 张照片` : '回忆',
    details ? clip(details, 28) : '',
  ].filter(Boolean).join(' · ');
  return `
    <div class="card list-row clickable" data-kind="memorial" data-memorial="${escapeHtml(e.id)}">
      <div class="lr-id">
        <span class="cd-thumb">
          <span class="cat-icon" data-tone="memorial">${escapeHtml(categoryIcon('memorial', null))}</span>
          ${photoId ? `<img alt="" data-photo-id="${escapeHtml(photoId)}" hidden/>` : ''}
        </span>
      </div>
      <div class="lr-main">
        <div class="lr-title">${escapeHtml(e.title || '(无标题)')} <span class="tag" style="margin-left:6px">${escapeHtml(memorialKindLabel(e.kind))}</span></div>
        <div class="lr-meta">${escapeHtml(meta)}</div>
      </div>
      <div class="lr-side">
        <div class="time-chip cd-clock-chip"><span class="cd-clock"></span>${escapeHtml(formatRelative(e.occurred_at))}</div>
      </div>
    </div>
  `;
}

// Trim a meta line to a readable length.
function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// The memorial tiles show their first photo as soon as the bytes arrive.
// The photos come from the main process as data URLs (the CSP forbids any
// other scheme), so the first paint shows the glyph and the photo swaps in
// when the cache resolves.
function paintMemorialThumbs(root) {
  root.querySelectorAll('img[data-photo-id]').forEach((img) => {
    const id = img.dataset.photoId;
    const cached = getCachedPhotoDataUrl(id);
    if (cached) { showThumb(img, cached); return; }
    fetchPhotoDataUrl(id).then((url) => {
      if (url) showThumb(img, url);
    });
  });
}

function showThumb(img, url) {
  if (url) img.src = url;
  img.hidden = false;
  const glyph = img.parentElement && img.parentElement.querySelector('.cat-icon');
  if (glyph) glyph.classList.add('hidden');
}

async function renderOverview(c) {
  const body = document.getElementById('cd-body');
  body.innerHTML = `<div class="empty">载入中…</div>`;
  const [dates, events, memorial] = await Promise.all([
    api.importantDates.list(c.id),
    api.events.list({ contact_id: c.id }),
    api.memorialEvents.list({ contact_id: c.id }),
  ]);

  // 重要日期 and 事件 used to be two separate blocks on this page. Both
  // hold dated reminders for this contact, and a birthday saved as an
  // event looked nothing like a birthday saved as an important date — so
  // one block sat empty while the other was full. They now share a single
  // list, ordered by how soon each row comes up.
  const dated = [
    ...dates.map((d) => ({ source: 'date', row: d, at: nextAnnualTs(d.month, d.day) })),
    ...events.map((e) => ({ source: 'event', row: e, at: nextEventTs(e) })),
  ].sort((a, b) => (a.at - b.at)
    || (a.source === b.source ? 0 : a.source === 'date' ? -1 : 1));

  const datedRows = dated.map((item) => item.source === 'date'
    ? importantDateRow(item.row)
    : eventRow(item.row)).join('');

  body.innerHTML = `
    <div class="section-header">
      <h2>重要日期</h2>
      <div class="row" style="gap:8px;">
        <button class="btn" id="add-date">+ 重要日期</button>
        <button class="btn secondary" id="add-event">+ 事件</button>
      </div>
    </div>
    ${datedRows
      ? datedRows
      : `<div class="empty">还没有重要日期</div>`}

    <div class="section-header">
      <h2>回忆</h2>
      <button class="btn secondary" id="add-memorial">+ 新增</button>
    </div>
    ${memorial.length === 0
      ? `<div class="empty">还没有回忆</div>`
      : memorial.map(memorialRow).join('')}
  `;

  paintMemorialThumbs(body);

  document.getElementById('add-date').onclick = () => showDateDialog(c.id);
  document.getElementById('add-event').onclick = () => navigate('/events/new?category=general&contact_id=' + c.id);
  const addMemorial = document.getElementById('add-memorial');
  if (addMemorial) addMemorial.onclick = () => navigate('/diary/new?contact_id=' + encodeURIComponent(c.id));
  body.querySelectorAll('.card.clickable').forEach((el) => {
    el.onclick = () => {
      if (el.dataset.important) {
        navigate('/important-dates/' + el.dataset.important);
      } else if (el.dataset.memorial) {
        navigate('/diary/' + encodeURIComponent(el.dataset.memorial));
      } else if (el.dataset.id) {
        navigate('/events/' + el.dataset.id + '?category=' + (el.dataset.category || 'general'));
      }
    };
  });
}

// --- 喜好 / 忌讳 / 礼物 tab ---------------------------------------------

// The collapsible "新增条目" form. It lives at the top of the tab, above
// the list, so adding a row never needs a separate page.
function addFormHTML(kind, st) {
  return `
    <div class="card cd-add-card${st.formOpen ? '' : ' hidden'}" id="cd-add-card">
      <div class="section-header"><h2>新增${KIND_META[kind].title}条目</h2></div>
      <div class="field">
        <label>描述 *</label>
        <input type="text" id="cd-add-desc" placeholder="例如：抹茶甜点"/>
      </div>
      <div class="field">
        <label>事件（记录时间）</label>
        <input type="date" id="cd-add-event" value="${escapeHtml(todayYmd())}"/>
      </div>
      <div class="row" style="margin-top:14px; gap:8px;">
        <button type="button" class="btn" id="cd-add-save">添加</button>
        <button type="button" class="btn secondary" id="cd-add-cancel">取消</button>
      </div>
    </div>
  `;
}

function renderKindTab(c, kind, itemsByKind) {
  const meta = KIND_META[kind];
  const st = viewState(c.id, kind);
  const body = document.getElementById('cd-body');

  const all = itemsByKind[kind] || [];
  const count = all.length;

  body.innerHTML = `
    <div class="section-header">
      <h2>${meta.title}<span class="cd-count">${count}</span></h2>
      <div class="row" style="gap:10px; align-items:center;">
        ${bulkEnterLinkHtml()}
        <button type="button" class="btn" id="cd-add-toggle">+ 新增条目</button>
      </div>
    </div>

    ${addFormHTML(kind, st)}

    <div class="list-host" data-kind="${escapeHtml(kind)}">
      <div class="filter-row">
        <input type="text" class="section-search" data-kind="${escapeHtml(kind)}"
               placeholder="搜索描述…" value="${escapeHtml(st.query)}"/>
        <select class="section-event-filter" data-kind="${escapeHtml(kind)}">
          ${buildEventFilterOptions(all).map((o) => `<option value="${escapeHtml(o.value)}" ${o.value === st.eventFilter ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
        </select>
      </div>
      <div class="list-tail" data-kind="${escapeHtml(kind)}"></div>
    </div>
  `;

  // The list tail is repainted on every filter / page / bulk change; the
  // filter row above it is never touched, so the search input keeps its
  // caret and its IME composition context across keystrokes.
  const tail = body.querySelector('.list-tail');

  function visibleItems() {
    const items = itemsByKind[kind] || [];
    const q = st.query.trim().toLowerCase();
    const filtered = items.filter((it) => matchesEither(it, q, st.eventFilter));
    const ordered = (q || st.eventFilter) ? sortByEventDesc(filtered) : filtered;
    return { q, filtered, ordered };
  }

  function paintTail() {
    const { q, ordered } = visibleItems();
    const totalPages = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
    if (st.page >= totalPages) st.page = totalPages - 1;
    if (st.page < 0) st.page = 0;
    const start = st.page * PAGE_SIZE;
    const visible = ordered.slice(start, start + PAGE_SIZE);
    const filtersActive = !!(q || st.eventFilter);
    const selectActive = !!st.selectModeActive;

    const rowsHtml = visible.map((it) => {
      const inner = renderItemRow(it, kind);
      if (selectActive) {
        // Select mode renders every row as its own bulk-row card. The
        // shared helper's markup is what the toolbar's "全选" scans for,
        // so it has to be used verbatim here.
        return bulkSelectableRowHtml(inner, it.id, st.selected.has(it.id), kind);
      }
      return inner;
    }).join('');

    const listHtml = visible.length
      ? (selectActive
          ? rowsHtml
          : `<div class="card" data-kind="${escapeHtml(kind)}">${rowsHtml}</div>`)
      : (filtersActive
          ? `<div class="empty">没有匹配的${meta.title}</div>`
          : `<div class="empty">还没有${meta.title}条目 · 点右上「+ 新增条目」添加</div>`);

    const matchFooter = filtersActive
      ? `<div class="meta" style="padding:6px 0">匹配 ${ordered.length} 条${q ? ' · 关键词：' + escapeHtml(st.query) : ''}${st.eventFilter ? ' · 事件：' + escapeHtml(st.eventFilter === '__none__' ? '未填事件' : st.eventFilter) : ''}</div>`
      : '';

    const toolbarHtml = selectActive ? bulkToolbarHtml({
      count: st.selected.size,
      total: ordered.length,
      kindLabel: '条' + meta.title,
    }) : '';

    tail.innerHTML = `
      ${toolbarHtml}
      ${listHtml}
      ${matchFooter}
      ${renderPager(st, totalPages)}
    `;

    // In select mode the toolbar takes over the action area, so the
    // "批量删除" entry link steps aside.
    const enterLink = body.querySelector('[data-bulk-enter]');
    if (enterLink) enterLink.classList.toggle('hidden', selectActive);

    wireRows();
    wirePager();
    if (selectActive) wireBulkInSection();
  }

  function renderPager(state, totalPages) {
    if (totalPages <= 1) return '';
    const cur = state.page + 1; // 1-based for display
    const prevDisabled = state.page <= 0;
    const nextDisabled = state.page >= totalPages - 1;
    return `
      <div class="row between" style="margin-top:8px">
        <button type="button" class="btn secondary section-page" data-kind="${escapeHtml(kind)}" data-action="prev" ${prevDisabled ? 'disabled' : ''}>← 上一页</button>
        <div class="meta">第 ${cur} / ${totalPages} 页</div>
        <button type="button" class="btn secondary section-page" data-kind="${escapeHtml(kind)}" data-action="next" ${nextDisabled ? 'disabled' : ''}>下一页 →</button>
      </div>
    `;
  }

  function wireRows() {
    if (st.selectModeActive) return;
    tail.querySelectorAll('.attribute-clickable').forEach((row) => {
      row.onclick = () => navigate('/attributes/' + row.dataset.id);
    });
  }

  function wirePager() {
    tail.querySelectorAll('.section-page').forEach((btn) => {
      btn.onclick = (e) => {
        e.preventDefault();
        const action = btn.dataset.action;
        if (action === 'prev') st.page = Math.max(0, st.page - 1);
        if (action === 'next') st.page = st.page + 1;
        paintTail();
      };
    });
  }

  function wireBulkInSection() {
    const handlers = {
      kindLabel: '条' + meta.title,
      onDelete: async (ids) => {
        const result = await api.attributes.deleteMany(ids);
        st.selectModeActive = false;
        st.selected = new Set();
        // A full page reload: the tab bar counters, the section title
        // count and the list all have to agree afterwards.
        await reload();
        return result;
      },
      onExit: () => {
        st.selectModeActive = false;
        st.selected = new Set();
        paintTail();
      },
    };
    // The bulk toolbar calls this whenever the selection changes (e.g.
    // "全选"). Refresh the "删除选中 (N)" counter without rebuilding the
    // whole list — a rebuild would steal focus from the checkbox.
    st.onChange = () => {
      const t = tail.querySelector('[data-bulk-toolbar]');
      if (!t) return;
      tail.querySelectorAll('.bulk-row-check').forEach((cb) => {
        const id = cb.dataset.bulkId;
        if (!id) return;
        cb.checked = st.selected.has(id);
      });
      const { ordered } = visibleItems();
      t.outerHTML = bulkToolbarHtml({
        count: st.selected.size,
        total: ordered.length,
        kindLabel: '条' + meta.title,
      });
      wireBulkToolbar(tail, st, handlers);
    };
    // Per-row checkbox flips — keep the Set in sync, then refresh the
    // toolbar count.
    wireBulkRowChecks(tail, st);
    wireBulkToolbar(tail, st, handlers);
  }

  // Re-render the whole page for this contact + tab. Used after a
  // mutation (add / delete) so every counter on screen is re-derived from
  // the DB.
  async function reload() {
    await render({ id: c.id }, kind);
  }

  // --- wiring -----------------------------------------------------------

  const search = body.querySelector('.section-search');
  if (search) {
    // The live <input> is NEVER replaced — only the list tail below it is
    // repainted, so the IME composition context survives every keystroke
    // (typing "汉" no longer drops the intermediate pinyin strokes, and
    // backspace works without re-clicking).
    let settleTimer = null;
    const apply = () => {
      settleTimer = null;
      st.query = search.value;
      st.page = 0; // a new filter always starts at page 1
      paintTail();
    };
    search.addEventListener('input', () => {
      // 120ms debounce collapses IME composition bursts into one repaint.
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(apply, 120);
    });
    search.addEventListener('compositionend', () => {
      if (settleTimer) clearTimeout(settleTimer);
      apply();
    });
  }

  const eventFilter = body.querySelector('.section-event-filter');
  if (eventFilter) {
    eventFilter.onchange = (e) => {
      st.eventFilter = e.target.value;
      st.page = 0;
      paintTail();
    };
  }

  // "批量删除" entry link in the section header.
  wireBulkEnter(body, () => {
    // Nothing to pick from — entering select mode would only show an
    // empty list with a toolbar on top.
    if (!itemsByKind[kind] || !itemsByKind[kind].length) return;
    st.selectModeActive = true;
    st.selected = new Set();
    paintTail();
  });

  // "+ 新增条目" toggle + the add form itself.
  const addToggle = body.querySelector('#cd-add-toggle');
  if (addToggle) {
    addToggle.onclick = () => {
      st.formOpen = !st.formOpen;
      // Adding a row and picking rows to delete are different modes —
      // opening the form leaves select mode behind.
      if (st.formOpen && st.selectModeActive) {
        st.selectModeActive = false;
        st.selected = new Set();
        paintTail();
      }
      const card = body.querySelector('#cd-add-card');
      if (card) card.classList.toggle('hidden', !st.formOpen);
      if (st.formOpen) {
        const desc = body.querySelector('#cd-add-desc');
        if (desc) desc.focus();
      }
    };
  }

  const addSave = body.querySelector('#cd-add-save');
  if (addSave) {
    addSave.onclick = async () => {
      const descEl = body.querySelector('#cd-add-desc');
      const evEl = body.querySelector('#cd-add-event');
      const description = (descEl.value || '').trim();
      if (!description) { toast('请填写描述'); descEl.focus(); return; }
      // Empty event → today (local), matching the rest of the app.
      const event = evEl.value || todayYmd();
      try {
        await api.attributes.create({
          contact_id: c.id,
          kind: meta.attrKind,
          description,
          event,
        });
        toast('已添加');
      } catch (e) {
        toast('操作失败：' + (e.message || e));
        return;
      }
      st.formOpen = false;
      const card = body.querySelector('#cd-add-card');
      if (card) card.classList.add('hidden');
      await reload();
    };
  }

  const addCancel = body.querySelector('#cd-add-cancel');
  if (addCancel) {
    addCancel.onclick = () => {
      st.formOpen = false;
      const card = body.querySelector('#cd-add-card');
      if (card) card.classList.add('hidden');
    };
  }

  // Click anywhere on the date input to open the calendar picker.
  wireDateInputs(body);

  paintTail();
}

// --- Page entry ---------------------------------------------------------

async function render(args, tab) {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty">载入中…</div>`;

  const c = await api.contacts.get(args.id);
  if (!c) {
    app.innerHTML = `<div class="empty">联系人不存在</div>`;
    return;
  }
  // Warm the avatar data URL cache so the header photo paints on the same
  // tick as the rest of the page (the first IPC populates the cache; the
  // second paint uses the cached value).
  if (c.custom_avatar_path) fetchAvatarDataUrl(c.id);

  const [likes, taboos, gifts] = await Promise.all([
    api.attributes.list('like',  { contact_id: c.id }),
    api.attributes.list('taboo', { contact_id: c.id }),
    api.attributes.list('gift',  { contact_id: c.id }),
  ]);
  const itemsByKind = { like: likes, taboo: taboos, gift: gifts };
  const counts = { like: likes.length, taboo: taboos.length, gift: gifts.length };

  // The page's artwork. It is preloaded when this module loads (see
  // warmBanner above), so the URL is normally already known by the time the
  // page paints. The fetch is repeated on every render because the user can
  // change the background in 设置 at any time — the cached URL is only
  // reused while it still matches the main process's answer.
  await warmBanner();

  // The artwork URL goes on the PAGE, which paints it edge to edge behind
  // everything. An empty URL means the artwork isn't installed (or the user
  // turned the background off) — the page then falls back to plain warm
  // paper instead of a broken image.
  const art = bannerUrl
    ? ` style="--cd-banner-image:url(&quot;${escapeHtml(bannerUrl)}&quot;)"`
    : '';
  app.innerHTML = `
    <div class="cd-page${bannerUrl ? '' : ' no-art'}"${art}>
      ${headerHTML(c)}
      ${tabBarHTML(c, tab, counts)}
      <div class="cd-body" id="cd-body"></div>
    </div>
  `;

  if (tab === 'overview') {
    await renderOverview(c);
  } else {
    renderKindTab(c, tab, itemsByKind);
  }
}

// Label for an important-date row's `kind` column. (The event repeat
// modes use the shared repeatLabel() from api.js instead.)
function kindLabel(k) {
  return ({ birthday: '生日', anniversary: '纪念日', deceased_date: '忌日', custom: '自定义' }[k]) || k || '';
}

function showDateDialog(contactId) {
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>新增重要日期</h3>
        <button class="icon-btn" id="x">✕</button>
      </div>
      <div class="modal-body">
        <div class="field"><label>名称（例：生日）</label><input type="text" id="d-label"/></div>
        <div class="form-row">
          <div class="field"><label>月</label><input type="number" id="d-month" min="1" max="12" value="1"/></div>
          <div class="field"><label>日</label><input type="number" id="d-day" min="1" max="31" value="1"/></div>
        </div>
        <div class="form-row">
          <div class="field"><label>年（可选）</label><input type="number" id="d-year" placeholder="1990"/></div>
          <div class="field"><label>类型</label>
            <select id="d-kind">
              <option value="birthday">生日</option>
              <option value="anniversary">纪念日</option>
              <option value="deceased_date">忌日</option>
              <option value="custom">自定义</option>
            </select>
          </div>
        </div>
        <div class="field"><label>提醒时间</label><input type="time" id="d-time" value="09:00"/></div>
        <div class="form-row">
          <div class="field">
            <label>提前提醒（天）</label>
            <input type="number" id="d-advance" min="0" max="60" value="7"/>
            <div class="meta">提前这么多天开始每天提醒一次，0 = 只在当天提醒</div>
          </div>
          <div class="field">
            <label>提醒开关</label>
            <label><input type="checkbox" id="d-remind-enabled" checked/> 启用提醒</label>
            <div class="meta">关闭后保留这条日期记录，但不再提醒</div>
          </div>
        </div>
        <div class="row" style="margin-top:14px; gap:8px;">
          <button class="btn" id="save">保存</button>
          <button class="btn secondary" id="cancel">取消</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  // Click anywhere on the time input to open the time picker.
  wireDateInputs(modal);
  modal.querySelector('#x').onclick = () => modal.remove();
  modal.querySelector('#cancel').onclick = () => modal.remove();
  modal.querySelector('#save').onclick = async () => {
    const advanceDays = Math.floor(Number(modal.querySelector('#d-advance').value));
    const input = {
      label: modal.querySelector('#d-label').value.trim() || '生日',
      month: parseInt(modal.querySelector('#d-month').value, 10),
      day: parseInt(modal.querySelector('#d-day').value, 10),
      year: modal.querySelector('#d-year').value ? parseInt(modal.querySelector('#d-year').value, 10) : null,
      kind: modal.querySelector('#d-kind').value,
      remind_time: modal.querySelector('#d-time').value || '09:00',
      advance_days: Number.isFinite(advanceDays) && advanceDays >= 0 ? Math.min(advanceDays, 60) : 7,
      remind_enabled: modal.querySelector('#d-remind-enabled').checked,
    };
    if (input.month < 1 || input.month > 12 || input.day < 1 || input.day > 31) {
      toast('日期不合法');
      return;
    }
    await api.importantDates.create(contactId, input);
    modal.remove();
    toast('已添加');
    // Re-render in place: the hash is unchanged, so a navigate() would be
    // a no-op (no hashchange → no re-render) and the new date would not
    // show up.
    await render({ id: contactId }, 'overview');
  };
}

// --- Routes -------------------------------------------------------------
//
// The three kind routes replaced the old "#/contacts/:id/:kind" manage
// pages (contact_list_edit.js) — the tab body IS the manage page now.
register('/contacts/:id',        (args) => render(args, 'overview'));
register('/contacts/:id/likes',  (args) => render(args, 'like'));
register('/contacts/:id/taboos', (args) => render(args, 'taboo'));
register('/contacts/:id/gifts',  (args) => render(args, 'gift'));
