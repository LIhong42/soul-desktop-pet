// src/js/export_filter.js — pure helpers for the /export page.
//
// Two responsibilities:
//   1. Build the date-range preset list (`buildPresetList(now, yearCount)`).
//      The presets are window-relative ("今年", "去年", "今年上半年", …)
//      so we always render them based on the current local date.
//   2. Reduce a contact + range filter into a `previewFilter` payload
//      (`applyFilter({contactIds, presetValue, customRange})`).
//
// Kept side-effect free: no DOM, no api, no I/O. Easy to unit-test by
// re-importing from the renderer.

const ALL = '__all__';      // value: no time range restriction
const CUSTOM = '__custom__'; // value: user picked two dates manually

// Window boundaries (local time). Each returns a 'YYYY-MM-DD' string that
// can be compared against the `occurred_at` column (which is also a
// YYYY-MM-DD-prefixed TEXT in the SQL layer). Using date-only strings
// means we sidestep timezone / DST edge cases for ranges that span a
// month boundary.
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function startOfYear(d) { return new Date(d.getFullYear(), 0, 1); }
function endOfYear(d)   { return new Date(d.getFullYear(), 11, 31); }
function addDays(d, n)  { const c = new Date(d); c.setDate(c.getDate() + n); return c; }
function addMonths(d, n){ const c = new Date(d); c.setMonth(c.getMonth() + n); return c; }

// Build the preset list. We always include 4 fixed buckets (this/last
// year + last month + this month) plus, for the past `yearCount` years
// (default 5), quarterly + monthly entries grouped via <optgroup>.
//   preset.value === ALL means "no time restriction"
//   preset.value === CUSTOM means "use customRange"
//   otherwise the value is "YYYY-MM-DD__YYYY-MM-DD" (start__end, both
//   inclusive) so the renderer can pass it straight to the backend.
function buildPresetList(now = new Date(), yearCount = 5) {
  const presets = [];
  presets.push({ value: ALL, label: '不限制' });
  presets.push({ value: CUSTOM, label: '自定义起止日期…' });

  // this year
  presets.push({
    value: `${ymd(startOfYear(now))}__${ymd(endOfYear(now))}`,
    label: `${now.getFullYear()} 年（今年）`,
  });
  // last year
  const last = new Date(now.getFullYear() - 1, 0, 1);
  presets.push({
    value: `${ymd(startOfYear(last))}__${ymd(endOfYear(last))}`,
    label: `${last.getFullYear()} 年（去年）`,
  });

  // this half-year (Jan-Jun / Jul-Dec)
  const curMonth = now.getMonth();
  const half = curMonth < 6
    ? { s: new Date(now.getFullYear(), 0, 1),   e: new Date(now.getFullYear(), 5, 30) }
    : { s: new Date(now.getFullYear(), 6, 1),   e: new Date(now.getFullYear(), 11, 31) };
  presets.push({
    value: `${ymd(half.s)}__${ymd(half.e)}`,
    label: `${now.getFullYear()} 年${curMonth < 6 ? '上半年' : '下半年'}`,
  });

  // this quarter
  const q = Math.floor(curMonth / 3); // 0..3
  const qStart = new Date(now.getFullYear(), q * 3, 1);
  const qEnd = new Date(now.getFullYear(), q * 3 + 3, 0);
  presets.push({
    value: `${ymd(qStart)}__${ymd(qEnd)}`,
    label: `${now.getFullYear()} Q${q + 1}`,
  });

  // last month
  const lmStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lmEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  presets.push({
    value: `${ymd(lmStart)}__${ymd(lmEnd)}`,
    label: `${lmStart.getFullYear()}-${String(lmStart.getMonth() + 1).padStart(2, '0')}`,
  });

  // this month
  const tmStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const tmEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  presets.push({
    value: `${ymd(tmStart)}__${ymd(tmEnd)}`,
    label: `${tmStart.getFullYear()}-${String(tmStart.getMonth() + 1).padStart(2, '0')}`,
  });

  // per-year quarterly + monthly optgroups, walking backwards
  const yearlyGroups = [];
  for (let y = 0; y < yearCount; y += 1) {
    const yr = now.getFullYear() - y;
    const group = { year: yr, quarters: [], months: [] };
    // quarters
    for (let qi = 0; qi < 4; qi += 1) {
      const s = new Date(yr, qi * 3, 1);
      const e = new Date(yr, qi * 3 + 3, 0);
      group.quarters.push({
        value: `${ymd(s)}__${ymd(e)}`,
        label: `Q${qi + 1}`,
      });
    }
    // months (skip the current year's months after now to avoid empty
    // ranges in the future tense)
    for (let mi = 0; mi < 12; mi += 1) {
      const s = new Date(yr, mi, 1);
      const e = new Date(yr, mi + 1, 0);
      // For the current year, only show months up to and including the
      // current month.
      if (yr === now.getFullYear() && mi > now.getMonth()) continue;
      group.months.push({
        value: `${ymd(s)}__${ymd(e)}`,
        label: `${yr}-${String(mi + 1).padStart(2, '0')}`,
      });
    }
    yearlyGroups.push(group);
  }

  return { presets, yearlyGroups };
}

// Reduce UI state into the IPC payload.
//
//   filter = { contactIds, presetValue, customRange }
//   - contactIds: string[]  (may be empty meaning "no contacts")
//   - presetValue: string   (one of the values from buildPresetList)
//   - customRange: { start, end }   (YYYY-MM-DD strings, may be empty)
//
// Returns { contactIds, range: { start, end } | null }.
function applyFilter({ contactIds = [], presetValue = ALL, customRange = { start: '', end: '' } } = {}) {
  const ids = Array.isArray(contactIds) ? contactIds.filter(Boolean) : [];
  const out = { contactIds: ids.length ? ids : null, range: null };
  if (presetValue === ALL || !presetValue) {
    out.range = null;
  } else if (presetValue === CUSTOM) {
    const s = (customRange && customRange.start) || '';
    const e = (customRange && customRange.end) || '';
    out.range = (s || e) ? { start: s || null, end: e || null } : null;
  } else {
    const [s, e] = String(presetValue).split('__');
    out.range = { start: s || null, end: e || null };
  }
  return out;
}

// Convenience: format a contact for the chip. The contact list returns
// { id, name, ... }; we just want a short, stable label.
function fmtForChip(c) {
  if (!c) return '';
  return (c.name || c.display_name || c.id || '').toString();
}

export { ALL, CUSTOM, buildPresetList, applyFilter, fmtForChip };
