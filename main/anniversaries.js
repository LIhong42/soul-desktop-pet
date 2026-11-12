// main/anniversaries.js — the 今日页's 纪念日 carousel, as a plain module.
//
// The carousel shows every anniversary the user has recorded. There are
// TWO places those live, and the user reaches for either one:
//
//   1. `important_dates` — a birthday / anniversary attached to a
//      contact, added from the contact's detail page. It has a month, a
//      day, an optional origin year and a `kind` (birthday / anniversary
//      / deceased_date / custom).
//
//   2. `events` — a row in the 提醒 list, tagged 生日 or 纪念日. It
//      is a yearly reminder, so its date lives in `remind_date`
//      (solar) or in `lunar_month`/`lunar_day` (农历).
//
// Reading only the first left the carousel empty for anyone who had
// only used 提醒 — which is the common case, since that is the page
// in the nav bar. Both are merged here.
//
// The module is deliberately free of Electron so it can be required
// directly by plain-node tooling.
//
// SCOPE: the list holds the **anniversaries** only — 结婚纪念日,
// 认识纪念日, 忌日, 领证纪念日 and the like. Birthdays are NOT here; a
// birthday is its own kind of thing and the strip is not the place for
// it (see ANNIVERSARY_TAG_KINDS below).

const { nextImportantDateOccurrence, parseDate } = require('./time_util');
const { nextLunarOccurrence } = require('./lunar');

// The event tag kinds that count as an anniversary. `festival` is not
// one — 节日 is a date that recurs but is not anybody's anniversary, and
// `none` is an untagged reminder.
//
// `birthday` is deliberately NOT here. The carousel is the 纪念日 strip:
// it rotates through the anniversaries — 结婚纪念日, 认识纪念日, 忌日,
// 领证纪念日 — and a birthday is not one of them. Birthdays have their
// own place (the 当前提醒 section surfaces them on the day, and the
// contact's detail page lists them), so putting them in the strip would
// crowd out the anniversaries the strip exists for.
const ANNIVERSARY_TAG_KINDS = ['anniversary'];

// Every anniversary the user has recorded, soonest first.
//
// Each entry:
//   id             — the row's id, used to open its detail page
//   source         — 'important_date' | 'event', which decides the page
//   contact_id     — the linked contact, or null for a standalone date
//   contact_name   — the linked contact's name, or null
//   label          — the name of the date ("妈妈生日", "生日")
//   kind           — 'birthday' | 'anniversary' | 'deceased_date' | 'custom'
//   calendar       — 'solar' | 'lunar'
//   month / day    — the recurring date
//   year           — the origin year, or null when there is none
//   remind_enabled — whether the reminder is switched on
//   years_since    — how many years it has been, or null when unknown
//   days_since     — how many whole days since the origin date, or null
//                    when the row has no origin year
//   days_until_next — whole days to the next occurrence (0 = today)
//   next_date      — the next occurrence, as a Date
function listAnniversaries(db, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const out = [];

  // ---- 1. The contact's own dates ---------------------------------------
  //
  // `birthday` is excluded, for the same reason it is excluded on the
  // events side: the strip rotates the anniversaries, not the birthdays.
  // `deceased_date` (忌日) and `custom` stay — a 忌日 is a 忌日, and a
  // custom date is whatever the user chose it to be.
  const dateRows = db.all(
    `SELECT d.*, c.name AS contact_name
       FROM important_dates d
       LEFT JOIN contacts c ON c.id = d.contact_id
      WHERE d.kind IS NULL OR d.kind <> 'birthday'
      ORDER BY d.month, d.day`
  );
  for (const row of dateRows) {
    const occ = nextImportantDateOccurrence(row, today);
    out.push({
      id: row.id,
      source: 'important_date',
      contact_id: row.contact_id,
      contact_name: row.contact_name || null,
      label: row.label,
      kind: row.kind,
      calendar: 'solar',
      month: row.month,
      day: row.day,
      year: row.year || null,
      remind_enabled: !!row.remind_enabled,
      // Null when the row has no origin year — the card then shows only
      // the countdown, without a "至今" clause.
      years_since: row.year ? occ.yearsSince : null,
      // The exact number of days since the origin date. Null for the same
      // reason as `years_since`: no origin year, no "至今 N 天".
      days_since: row.year ? occ.daysSince : null,
      days_until_next: occ.daysUntilNext,
      next_date: occ.nextDate,
    });
  }

  // ---- 2. The 提醒 rows tagged as an anniversary -----------------------
  //
  // Only `yearly` rows qualify: a one-off appointment or a weekly chore
  // is not an anniversary.
  const placeholders = ANNIVERSARY_TAG_KINDS.map(() => '?').join(', ');
  const eventRows = db.all(
    `SELECT e.*, c.name AS contact_name
       FROM events e
       LEFT JOIN contacts c ON c.id = e.contact_id
      WHERE e.category = 'general'
        AND e.tag_kind IN (${placeholders})
        AND e.remind_kind = 'yearly'
        AND (
          (e.remind_date IS NOT NULL AND e.lunar_month IS NULL AND e.lunar_day IS NULL)
          OR (e.lunar_month IS NOT NULL AND e.lunar_day IS NOT NULL)
        )`,
    ANNIVERSARY_TAG_KINDS
  );

  for (const ev of eventRows) {
    const base = {
      id: ev.id,
      source: 'event',
      contact_id: ev.contact_id || null,
      contact_name: ev.contact_name || null,
      // The event's title is the label the user typed ("妈妈生日"). The
      // description is the event's own content and is left for the
      // detail page — the card has one line and no room for it.
      label: ev.title,
      kind: ev.tag_kind,
      remind_enabled: !!ev.remind && ev.active !== 0,
    };

    if (ev.lunar_month && ev.lunar_day) {
      // A 农历 anniversary. Its solar date shifts from year to year, so
      // it needs the lunar calendar to resolve. There is no origin year
      // for it — the form only ever captured a month and a day — so the
      // card shows the countdown without a "至今" clause.
      const occ = nextLunarOccurrence(ev.lunar_month, ev.lunar_day, null, today);
      if (!occ) continue;
      out.push({
        ...base,
        calendar: 'lunar',
        month: ev.lunar_month,
        day: ev.lunar_day,
        year: null,
        years_since: occ.yearsSince,
        // No origin year → no origin date → no "至今 N 天" either.
        days_since: null,
        days_until_next: occ.daysUntilNext,
        next_date: occ.nextDate,
      });
      continue;
    }

    // A solar anniversary. `remind_date`'s YEAR is the origin year —
    // the same thing `important_dates.year` holds.
    const parsed = parseDate(ev.remind_date);
    if (!parsed) continue;
    const occ = nextImportantDateOccurrence(
      {
        month: parsed.getMonth() + 1,
        day: parsed.getDate(),
        year: parsed.getFullYear(),
      },
      today
    );
    out.push({
      ...base,
      calendar: 'solar',
      month: parsed.getMonth() + 1,
      day: parsed.getDate(),
      year: parsed.getFullYear(),
      years_since: occ.yearsSince,
      // `remind_date`'s YEAR is the origin year, so the origin date is
      // known here and the "至今 N 天" clause can be shown.
      days_since: occ.daysSince,
      days_until_next: occ.daysUntilNext,
      next_date: occ.nextDate,
    });
  }

  // Soonest first — the carousel leads with whatever is next.
  out.sort((a, b) => (a.days_until_next - b.days_until_next));
  return out;
}

module.exports = { listAnniversaries, ANNIVERSARY_TAG_KINDS };
