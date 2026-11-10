// src/js/album_builder.js — Convert selected memorial events into an
// AlbumLayout the editor and PDF renderer can consume.
//
// Responsibilities:
//   1. Pre-filter HEIC / missing files so they never occupy a slot
//   2. Per event, group embeddable photos and assign them to layout templates
//      based on photo count + photo aspect ratios (when available) + a
//      deterministic per-event seed (avoids A-B-A-B repetition)
//   3. Populate the text slot of every page with a caption derived from
//      the event's title, date, notes/activities/food
//   4. Initialize per-photo transform = {x:50, y:50, zoom:1} so the
//      editor's "centered, no zoom" default applies uniformly
//   5. Build a cover (title, subtitle, date range)
//
// Output:
//   { themeId, pageShape, pages: PageModel[], cover: CoverModel, stats }
//
// PageModel = {
//   templateId: string,
//   slots: Array<{ type, photoId?, transform?, text?, placeholder? }>
// }

import {
  getTheme,
  getLayoutTemplate,
  pickLayoutForPhotoCount,
  LAYOUT_TEMPLATES as LAYOUT_TEMPLATES_LIST,
} from './album_layouts.js';

// ---- helpers ----------------------------------------------------------------

function ymd(s) {
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function isEmbeddable(photo) {
  if (!photo) return false;
  if (!isImageRow(photo)) return false;
  if (photo._is_heic) return false;
  if (photo._is_heif) return false;
  if (photo.mime && /heic|heif/i.test(photo.mime)) return false;
  // We don't have fs here; trust the caller's pre-filter. The PDF renderer
  // additionally does fs.existsSync + catches image() errors.
  return true;
}

// Is this row a picture? A movie and a sound live in the same table as
// the pictures — the `mime` column says which is which — and the album
// lays out pictures only. The extension is the fallback for rows whose
// mime was never written.
const IMAGE_MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.heic': 'image/heic', '.heif': 'image/heic',
};

export function isImageRow(photo) {
  if (!photo) return false;
  if (photo.mime) return String(photo.mime).toLowerCase().startsWith('image/');
  const name = String(photo.relative_path || photo.original_name || '');
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  const mime = IMAGE_MIME_BY_EXT[name.slice(dot).toLowerCase()];
  return !!mime;
}

// Build a human-readable caption from an event row. We bias toward shorter
// text because caption slots are typically narrow.
function buildEventCaption(ev) {
  const parts = [];
  const date = ymd(ev.occurred_at);
  if (date) parts.push(date);
  const contacts = Array.isArray(ev.contact_names) ? ev.contact_names.filter(Boolean) : [];
  if (contacts.length) {
    parts.push(contacts.length === 1 ? contacts[0] : `${contacts[0]} 等 ${contacts.length} 人`);
  }
  // Pull the first non-empty detail line, prefer notes then activities
  const detailPriority = [ev.notes, ev.activities, ev.food, ev.outfit, ev.place];
  for (const d of detailPriority) {
    if (d && String(d).trim()) {
      const trimmed = String(d).trim();
      const short = trimmed.length > 60 ? trimmed.slice(0, 59) + '…' : trimmed;
      parts.push(short);
      break;
    }
  }
  return parts.join(' · ');
}

function buildPageTitle(ev) {
  return ev.title || '(无标题)';
}

// Per-event starting template seed so consecutive events don't all start
// on the same template. We mix event id hash + index.
function seedForEvent(ev, idx) {
  const s = String(ev.id || idx);
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h + idx);
}

// Group a list of photos into chunks of <= maxPerPage, with chunk count
// driven by the page-shape constraints. Returns an array of photo arrays.
function chunkPhotos(photos, maxPerPage) {
  const out = [];
  for (let i = 0; i < photos.length; i += maxPerPage) {
    out.push(photos.slice(i, i + maxPerPage));
  }
  return out;
}

// Find the largest photo slot AR (w/h) within a template, for matching.
// slot must be type:'photo'. Returns NaN if template has no photo slot.
function templatePhotoSlotAR(template) {
  const ps = template.slots.find((s) => s.type === 'photo');
  if (!ps || !ps.h) return NaN;
  return ps.w / ps.h;
}

// Heuristic: given a list of photos and a template, return a "fit score"
// where higher = better. Considers (a) whether the photo count fits and
// (b) whether the dominant photo AR matches the slot AR.
function templateFitScore(template, photos) {
  const { minPhotos, maxPhotos, requiresText } = template.constraints;
  if (photos.length < minPhotos || photos.length > maxPhotos) return -1;
  let score = 10;
  // Reward exact photo count match
  if (photos.length === maxPhotos) score += 5;
  if (photos.length === minPhotos) score += 2;
  // AR match (if we know photo dimensions)
  const slotAR = templatePhotoSlotAR(template);
  const ars = photos
    .map((p) => (p.width && p.height ? p.width / p.height : NaN))
    .filter((n) => Number.isFinite(n));
  if (Number.isFinite(slotAR) && ars.length) {
    const avgAR = ars.reduce((a, b) => a + b, 0) / ars.length;
    const ratio = Math.min(avgAR, slotAR) / Math.max(avgAR, slotAR);
    score += ratio * 8; // 0..8
  }
  // Penalty if a single photo forces single-full
  if (template.id === 'single-full' && photos.length > 1) score -= 1;
  return score;
}

// Pick best template for a chunk of photos given a starting seed.
function pickBestTemplate(photos, seedIdx) {
  let best = null;
  let bestScore = -Infinity;
  for (const tpl of LAYOUT_TEMPLATES_LIST) {
    const s = templateFitScore(tpl, photos);
    if (s < 0) continue;
    // Slight per-template seed offset to break ties deterministically
    const tiebreak = ((seedIdx % 7) + 7) % 7;
    const adj = s + (tiebreak * 0.01);
    if (adj > bestScore) {
      bestScore = adj;
      best = tpl;
    }
  }
  if (!best) return getLayoutTemplate('single-full');
  return best;
}

// ---- main entry -------------------------------------------------------------

// Build an AlbumLayout from selected memorial events. Events must already
// have `photos` arrays attached (the export IPC layer does that).
//
//   events: MemorialEventRowWithPhotos[]
//   options: { themeId?: string, pageShape?: 'portrait'|'landscape' }
//
// Returns:
//   { themeId, pageShape, pages, cover, stats: { events, photos, heicSkipped, pages } }
export function buildAlbumLayout(events, options = {}) {
  const theme = getTheme(options.themeId);
  const pageShape = options.pageShape || theme.pageShape || 'landscape';

  let totalPhotos = 0;
  let heicSkipped = 0;

  // For each event, group embeddable photos into 1-N pages
  const pages = [];
  for (let evIdx = 0; evIdx < events.length; evIdx += 1) {
    const ev = events[evIdx];
    const photosAll = Array.isArray(ev.photos) ? ev.photos : [];
    const photos = photosAll
      .filter((p) => {
        // A movie or a sound is not a HEIC — it is not a picture at all,
        // so it does not belong in the "skipped" count.
        if (!isImageRow(p)) return false;
        if (!isEmbeddable(p)) {
          heicSkipped += 1;
          return false;
        }
        return true;
      })
      // Stable order
      .slice()
      .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));

    if (photos.length === 0) {
      // Event with no embeddable photos → still produce a text-only placeholder
      // page? Per the "图文并茂" rule, no. Skip the event entirely.
      continue;
    }

    totalPhotos += photos.length;

    // Find the largest available maxPerPage across templates
    const maxPerPage = Math.max(
      ...LAYOUT_TEMPLATES_LIST.map((t) => t.constraints.maxPhotos)
    );
    const chunks = chunkPhotos(photos, maxPerPage);
    const seedBase = seedForEvent(ev, evIdx);

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx += 1) {
      const chunk = chunks[chunkIdx];
      const seed = seedBase + chunkIdx * 3;
      const template = pickBestTemplate(chunk, seed);

      // Build slots: start from template shape, fill photos into photo slots,
      // fill caption + title from event data
      const slots = [];
      const photoSlots = template.slots.filter((s) => s.type === 'photo');
      const textSlots = template.slots.filter((s) => s.type !== 'photo');

      for (let i = 0; i < photoSlots.length; i += 1) {
        const ps = photoSlots[i];
        const photo = chunk[i];
        if (!photo) {
          // No more photos; render an empty photo slot placeholder
          slots.push({
            type: 'photo',
            photoId: null,
            transform: { x: 50, y: 50, zoom: 1 },
            _slotTemplate: { x: ps.x, y: ps.y, w: ps.w, h: ps.h, padding: ps.padding || 0 },
            empty: true,
          });
          continue;
        }
        slots.push({
          type: 'photo',
          photoId: photo.id,
          transform: { x: 50, y: 50, zoom: 1 },
          _slotTemplate: { x: ps.x, y: ps.y, w: ps.w, h: ps.h, padding: ps.padding || 0 },
        });
      }

      // Fill text slots with event data. First non-photo slot is title, rest
      // are caption-style. (We use the first text slot to surface the event
      // title + date, then any additional text slot gets the long-form
      // caption. If there's only one text slot, blend them.)
      const fullCaption = buildEventCaption(ev);
      const evTitle = buildPageTitle(ev);
      const evDate = ymd(ev.occurred_at);

      if (textSlots.length === 1) {
        const ts = textSlots[0];
        slots.push({
          type: ts.type, // 'title' or 'caption'
          text: ts.type === 'title' ? `${evTitle} · ${evDate}` : fullCaption,
          textOffset: { x: 0, y: 0 },
          fontScale: 1,
          textAlign: ts.type === 'title' ? 'center' : 'left',
          _slotTemplate: { x: ts.x, y: ts.y, w: ts.w, h: ts.h, padding: ts.padding || 0 },
        });
      } else {
        for (let i = 0; i < textSlots.length; i += 1) {
          const ts = textSlots[i];
          let txt;
          if (ts.type === 'title') {
            txt = `${evTitle}`;
          } else if (i === 1 && textSlots[0].type !== 'title') {
            // First text slot wasn't a title; treat this as the title
            txt = `${evTitle} · ${evDate}`;
          } else {
            txt = fullCaption;
          }
          slots.push({
            type: ts.type,
            text: txt,
            textOffset: { x: 0, y: 0 },
            fontScale: 1,
            textAlign: ts.type === 'title' ? 'center' : 'left',
            _slotTemplate: { x: ts.x, y: ts.y, w: ts.w, h: ts.h, padding: ts.padding || 0 },
          });
        }
      }

      pages.push({
        templateId: template.id,
        eventId: ev.id,
        slots,
      });
    }
  }

  // Cover
  const dates = events.map((e) => ymd(e.occurred_at)).filter(Boolean).sort();
  const earliest = dates[0] || '';
  const latest = dates.length > 1 ? dates[dates.length - 1] : (dates[0] || '');
  const cover = {
    title: '回忆相册',
    subtitle: earliest && latest && earliest !== latest
      ? `${earliest} → ${latest}`
      : (earliest || ''),
    showStats: true,
  };

  return {
    themeId: theme.id,
    pageShape,
    pages,
    cover,
    stats: {
      events: events.length,
      photos: totalPhotos,
      heicSkipped,
      pages: pages.length,
    },
  };
}

// When the user changes a page's template, remap the page's slots to the
// new template while preserving as much content as possible. Photos keep
// their photoId+transform; text slots fall back to defaults from the page's
// event row (passed in via ctx).
//
//   page: PageModel (current page)
//   newTemplateId: string
//   ctx: { event?: MemorialEventRowWithPhotos }  (for fallback text)
//
// Returns a new PageModel.
export function remapPageTemplate(page, newTemplateId, ctx = {}) {
  const newTpl = getLayoutTemplate(newTemplateId);
  // Carry over photos in their existing order, then carry over text content
  const oldPhotos = (page.slots || []).filter((s) => s.type === 'photo' && s.photoId);
  const oldText = (page.slots || []).filter((s) => s.type !== 'photo' && s.text);
  const ev = ctx.event;

  const newSlots = [];
  const photoSlots = newTpl.slots.filter((s) => s.type === 'photo');
  const textSlots = newTpl.slots.filter((s) => s.type !== 'photo');

  // Photos
  for (let i = 0; i < photoSlots.length; i += 1) {
    const ps = photoSlots[i];
    const carried = oldPhotos[i];
    if (carried) {
      newSlots.push({
        type: 'photo',
        photoId: carried.photoId,
        transform: carried.transform || { x: 50, y: 50, zoom: 1 },
        _slotTemplate: { x: ps.x, y: ps.y, w: ps.w, h: ps.h, padding: ps.padding || 0 },
      });
    } else {
      newSlots.push({
        type: 'photo',
        photoId: null,
        transform: { x: 50, y: 50, zoom: 1 },
        _slotTemplate: { x: ps.x, y: ps.y, w: ps.w, h: ps.h, padding: ps.padding || 0 },
        empty: true,
      });
    }
  }

  // Text
  const fullCaption = ev ? buildEventCaption(ev) : '';
  const evTitle = ev ? buildPageTitle(ev) : '';
  const evDate = ev ? ymd(ev.occurred_at) : '';
  if (textSlots.length === 1) {
    const ts = textSlots[0];
    const carried = oldText[0];
    newSlots.push({
      type: ts.type,
      text: carried && carried.text ? carried.text : (
        ts.type === 'title' ? `${evTitle} · ${evDate}` : fullCaption
      ),
      textOffset: (carried && carried.textOffset) || { x: 0, y: 0 },
      fontScale: (carried && carried.fontScale) || 1,
      textAlign: (carried && carried.textAlign) || (ts.type === 'title' ? 'center' : 'left'),
      _slotTemplate: { x: ts.x, y: ts.y, w: ts.w, h: ts.h, padding: ts.padding || 0 },
    });
  } else {
    for (let i = 0; i < textSlots.length; i += 1) {
      const ts = textSlots[i];
      const carried = oldText[i];
      let txt;
      if (carried && carried.text) {
        txt = carried.text;
      } else if (ts.type === 'title') {
        txt = evTitle;
      } else {
        txt = fullCaption;
      }
      newSlots.push({
        type: ts.type,
        text: txt,
        textOffset: (carried && carried.textOffset) || { x: 0, y: 0 },
        fontScale: (carried && carried.fontScale) || 1,
        textAlign: (carried && carried.textAlign) || (ts.type === 'title' ? 'center' : 'left'),
        _slotTemplate: { x: ts.x, y: ts.y, w: ts.w, h: ts.h, padding: ts.padding || 0 },
      });
    }
  }

  return {
    templateId: newTemplateId,
    eventId: page.eventId,
    slots: newSlots,
    // Free-form text boxes are page-level decoration; carry them over
    // unchanged when the template changes. We don't touch their
    // coordinates because they're in pt, not normalized to the template.
    freeTexts: Array.isArray(page.freeTexts) ? page.freeTexts.slice() : [],
  };
}

// Default text for a freshly added text slot. Currently unused (no add-text
// in v1) but exported for future use.
export function defaultTextFor(textType, ev) {
  if (textType === 'title') {
    return ev ? buildPageTitle(ev) : '';
  }
  return ev ? buildEventCaption(ev) : '';
}

export { buildEventCaption, buildPageTitle, ymd as ymdDate };
