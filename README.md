# 🐾 SoulDesktopPet

> A desktop pet that lives on your computer — combining **emotional companionship, memory keeping, and practical utility** in one.
> It looks cute while quietly remembering the people and things you would otherwise forget.

[English](README.md) | [简体中文](README.zh-CN.md)

---

## 🌟 What Is It?

**SoulDesktopPet** is a local-first desktop app that merges companionship with a personal memory keeper:

- 💝 **Emotional value** — a pet that lives on your desktop, acts cute, walks around, and comes over to be petted;
- 🧠 **Memory value** — remembers contact preferences, taboos, and gift ideas; reminds you of birthdays and festivals; keeps memory events with photo albums;
- 🛠 **Practical value** — schedules work events on a schedule, and exports memory albums to PDF / MP4 with one click.

**🔒 All data stays on your own computer (`%APPDATA%/SoulDesktopPet/`) — no cloud, no upload, no network calls.**

---

## ✨ Core Features

### 👥 Contact Management
- Create / edit / delete contacts, with custom avatars, nicknames, and relationships;
- Bind three tag categories per contact — **likes · taboos · gifts** — managed from a global tag library;
- Record important dates in the Gregorian or the **Chinese lunar calendar**, either one-off or recurring yearly;
- Each important date can set **how many days ahead to start reminding** (a week by default). The pet then reminds you once a day while the window is open, and tells you how many days are left.

### 📅 Recurring Reminders
- Birthdays, anniversaries, and festivals trigger on a cycle;
- Repeat options: **one-off / daily / weekly / every N days / monthly / yearly**. "Every N days" is counted from the start date you pick and advances on a fixed stride, so re-saving an event never shifts the schedule;
- The list shows **both the title and the description**. An untagged reminder's title is generated for you (e.g. "爷爷的提醒"), and whatever you typed in the description field follows it — "爷爷的提醒 — 打电话" — so you never see a bare label with the actual content hidden;
- **Lunar (traditional Chinese) calendar dates are supported**, with a built-in festival library: Valentine's Day, Teacher's Day, Qixi, Christmas, Father's Day… including floating festivals that are computed automatically;
- The pet shows an unread reminder badge in the corner and wakes you up when the time comes.

### 📷 Memory Events & Album Export
- "Memory events" record moments on a timeline, keeping every important highlight;
- **A diary, not a form** — "新建" opens a dedicated diary page where the title, the body and the photos all live on one sheet of paper. Write first, save second. The title is typed straight into the coloured header bar, and the date lives in the side panel, so the sheet itself holds nothing but the title and the text;
- **Text and images interleave** — the body isn't one big text box but a sequence of text and image blocks. Put the caret where you want a picture and click "插入图片"; the picture lands right there and the text splits above and below it. Keep writing under the image. The saved document keeps the page order exactly. The button sits on the text block you're working in — the first block always shows it, the rest show it on hover;
- **Multi-photo galleries** — pick several pictures at once and they land in one gallery. A layout switcher under the group offers **one / two / three / grid**, so the whole group re-arranges in one click;
- **Per-photo sizing** — drag the handle in a picture's bottom-right corner to resize it freely. Every picture keeps its own size, independent of the others;
- **Any order** — **drag a picture onto another one** to swap their places. The order is stored with the page;
- **Photo drags survive sleep and hibernation** — the album editor's gestures run through the same shared guard as the pet window (`src/js/gesture_guard.js`). A pointer gesture is a latch: it is set on `pointerdown` and cleared on `pointerup`, and if the `pointerup` never arrives the latch stays set. The `pointerup` goes missing when the machine sleeps (the OS re-creates the pointer device, so the browser never delivers an `pointerup` for the old pointer id) or when the button is released outside the window. The guard treats "an event from a **different** pointer id" as **proof that the gesture is dead** and tears it down. That matters here more than elsewhere: a stale photo drag would otherwise **commit a real photo swap** on the user's next unrelated click — a picture silently jumping into a slot it was never dropped on. `scripts/test-gesture-guard.js` and `scripts/test-album-gesture.js` guard both the guard itself and the album editor's behaviour;
- **Select and view are separate** — a click **selects** a picture, a **double click** opens it full screen. The full-screen view covers the whole page, so it doesn't pop up on every click and the pictures stay draggable;
- **Six paper styles** — Light / Dark / Shiro / Shadow / Helena / Poonam, each painted in three layers (a coloured header bar, the body surface and a decorative strip at the bottom) with three accent dots, matching the reference artwork. The three are separate layers rather than strips of one background: the body layer takes its height from the text and the photos it holds, so the decoration stays below it and is never covered, however much you write. They're pure CSS colors, so no image assets are involved. Every style carries its own text colors, and a regression test checks that the body text, the hints and the title all stay readable (WCAG AA, 4.5:1) against their background;
- One event can hold multiple photos — perfect for ritual moments like *"our first trip together"*;
- Each row on the list shows its paper colour, so you can see at a glance which sheet an entry was written on;
- One-click export to a **PDF album** or an **MP4 video album**, with multiple templates and a live WYSIWYG preview;
- **Annual album**: automatically gathers all memories from a given year for a year-in-review.

### 💼 Work Event Reminders
- One-off or **cron-scheduled recurring** work reminders;
- Shown on a separate channel from personal events — never in the way, never missed.

### 📝 Quick Record (right-click → 记录)
- **Right-click the pet → 📝 记录** opens a small dedicated window listing the six record kinds: **likes · taboos · gifts · reminder dates · memory events · work events**;
- Pick a kind and the matching form appears right there — fill it in and **保存** writes the record immediately;
- **The forms are field-for-field the same as the main window's** — the same labels, options, defaults and validation rules. Reminders get 启用提醒 / 重复 / **每 N 天间隔** / **阳历·农历切换** / 农历月·日 / 提醒时间; memory events get 穿着 / 活动 / **照片上传（带缩略图预览）**. A record captured from the pet is indistinguishable from one captured in the main window;
- **Not kept in sync by hand** — both windows build their forms from one shared module (`src/js/form_fields.js`), so a new field only has to be added once, and a regression test compares the two renderings field by field;
- **Lunar (traditional Chinese) calendar dates are supported** here too — pick 农历 and the date becomes a lunar month/day anchor, exactly as in the main window;
- **No main window, no PIN.** The whole point is to capture something in a few seconds without unlocking anything. The window is **write-only**: it shows no lists and no browsing surface, so it can't be used to peek at the data the PIN protects;
- Likes / taboos / gifts require a **linked contact** (the first contact is pre-selected — one click on 保存 is enough), matching the main window's own form;
- Records are written through the **same IPC handlers** the main window uses, so validation, search indexing and intimacy tracking stay in one place;
- After saving, the window **stays open** on the same form so several things can be logged in a row.

### 🐾 The Pet Itself
- Translucent, borderless, always-on-top window that walks, idles, and falls asleep on its own;
- **Single click / double click / right click** interactions: pet the head, pat the head, feed, play, sleep, hug;
- Right click opens the **Cozy interaction menu** — all 6 actions are customizable per character animation.
- **The whole window is the drag handle**: the character is smaller than the transparent window, so a press *anywhere* in the window starts a drag — you never have to hit the artwork itself. The only exception is the reminder bubble, which carries its own controls and is therefore excluded from the drag;
- **The drag accepts both pointer events and legacy mouse events** — after a sleep, Chromium can stop delivering pointer events while the mouse events keep coming, and the pet has to stay draggable either way (see the sleep-recovery notes below).

### 💞 Intimacy System (three-layer architecture)
- **Bond (permanent bond)**: settled weekly across 10 dimensions, upgrading quarterly — your long-term relationship with the pet;
- **Cozy (short-term warmth)**: decays over time, a little more with each play session, and drives the pet's current mood;
- **Mood (emotion)**: derived from Cozy plus the day's activity, and drives the pet's expression filters.

> Advanced interactions such as double-click head patting unlock at intimacy tier ≥ 5.

### 🎨 Customization & Pluggable Characters
- Every pet can be configured independently: click action / idle loop action / 6 cozy actions in the right-click menu;
- Upload a frame-animation PNG package and **a new pet is generated automatically and ready to use**;
- **Only imported pets get a delete button** in the pet list; built-in pets (the ones under `resources/pets/`) offer no delete action. Whether a pet is deletable is decided by **where it actually lives on disk**, not by the shape of its id — so promoting an imported pet to a built-in no longer leaves behind a delete button that does nothing.
- **Deleting a pet takes its data with it**: the bond score, the cozy meter, the weekly tallies, the interaction history, and the pet's own action bindings and bubble texts are all removed too — no orphaned rows are left behind in the database pointing at a pet that no longer exists. The app also sweeps up any such leftovers from earlier versions on every startup.
- Built-in frame splitter: cut a video into a PNG sequence and zip it — DIY your own desktop pet;
- **Background removal** ("Tools → Image Background Removal") turns a picture's backdrop transparent. It decides what counts as background by *connectivity* plus *edge strength*, not by colour alone: every pixel is priced by how far its colour is from the backdrop **and** how strong an edge it sits on, and the background is whatever can be walked to from the image border without crossing a pixel that is too expensive. The anti-aliased fringe around the character sits on a strong edge, so the flood stops there instead of chewing into the character — which is why the black hair, clothing and outlines survive even when the backdrop is black. The same cutout runs automatically on every frame of an imported pet package, and produces byte-identical output to the tool's default setting.
- **Two kinds of imported frames are accepted**: *opaque* PNGs (the default — flat backdrop, cut out automatically on upload) and *transparent* PNGs (already cut out — the cutout is **skipped**, so the edges are left exactly as you exported them). The type is detected per frame, so a single package may mix both.
- **Live import progress**: uploading a package shows a progress bar with a "processed N / total images" counter and a percentage, ticking up after every finished frame — no blind waiting while the frames are cut out one by one.
- **Batch image resize** ("Tools → Batch Image Resize") shrinks every image in a folder by a chosen factor and writes the results into a folder you pick — **your originals are never modified**. The factor can be 1/2, 1/3, 1/4, 1/8 or a custom value (decimals allowed). The source folder's **sub-directory structure is mirrored** into the output, so frame sets organised per action stay organised after shrinking. Scaling uses the lanczos algorithm, which keeps quality high; **the alpha channel survives intact**, so cut-out character art shrinks without gaining white fringes or jagged edges. Images with transparency are always written as PNG; plain JPEGs and the like keep their own format. The output folder may not be the source folder, nor live inside it — so a mis-click can never destroy the originals.
- **Outline stripping & hole repair**: many Live2D-style sprites are exported with a bright "sticker" stroke around the character. The cut removes that stroke too — and it locates it by *geometry*, not by brightness alone: the stroke is the narrow bright band hugging the cut edge, while the character's own white hair, shirt and skin are enclosed hundreds of pixels deep. So the black hat, cape, vest and boots survive, the enclosed white areas survive, and the halo is gone. A character that is simply *bright* at its edge is left alone — the bright band has to peak and fall again to count as a stroke. Any hole the cut opens inside the character is then closed again, so an imported package can never come out with a black hole in it.
- **Black-edge removal**: artwork that draws the character with its own black contour comes out of the cut wearing that contour — a dark rim following the silhouette, over a desktop it reads as a black halo. The cut therefore grows the transparent region **5 pixels outward** past the boundary it found, so the rim is swallowed with the backdrop. The growth is gated on the backdrop *colour* and on *connectivity* — it re-runs the same flood with the edge-strength term switched off, so it can only reach pixels that still look like backdrop — and it is bounded by the 5-pixel radius, so it can never eat more than a hairline of the character. Measured on the shipped pet frames, **0%** of the character's interior is touched, while roughly 7,000 outline pixels per frame are cleaned away.
- **Small black dot removal**: a handful of leftover background specks can survive the cut — a few pixels of backdrop trapped behind a thin strand of the character's line art. Those are found by looking for kept pixels that are still **backdrop-coloured** and grouping them into blobs; any blob small enough to be noise (and flat enough to be leftover material rather than drawn detail) is made transparent. Larger detached fragments — a sword, a stray hair — are left alone.

### 🔄 Software Auto-Update
- Updates come from **GitHub Releases** and can be checked manually under "Settings → Software Update";
- Checks run **automatically once a day**, silently, without interrupting your pet;
- Downloaded installers are verified with **SHA-256** before execution — a file that fails verification is never installed;
- User data (contacts / reminders / memories / photos) lives in `%APPDATA%\SoulDesktopPet\`, separate from the install directory, so **upgrading never deletes it**.

### 🔐 Privacy & Security
- The main window requires a 4-digit PIN to unlock (default `1234`), changeable under "Settings → Access Password";
- **Fully local database**: uses sql.js (pure-JS SQLite), zero native dependencies, and never calls any cloud API;
- One-click export / import of zip backups for painless whole-machine migration.

> Auto-update is only available in the **packaged Windows build**; in development mode the app points you to GitHub Releases to download manually. The repository address is the `REPO` constant at the top of `main/app_update.js`.

---

## 🚀 Installation & Running

### Prerequisites
- Node.js 18+
- Windows 10 / 11 (macOS works too, but the default packaging target is Windows)

### Install dependencies
```bash
npm install
```
A `postinstall` hook automatically pulls in the helper modules needed at runtime.

### Development mode
```bash
npm run dev
```
> Launches Electron; the main window opens automatically with DevTools attached, and the pet window stays on top.

### Production run
```bash
npm start
```

### Build the installer (Windows)
```bash
npm run build
```
> Output lands in `dist/` as an NSIS installer, which automatically creates desktop and Start menu shortcuts (named: SoulDesktopPet).

---

## 📂 Where Data Lives

All data is stored in the OS user directory:

```
%APPDATA%\SoulDesktopPet\
  ├─ soul-desktop-pet.db       ← SQLite database (sql.js)
  ├─ avatars\<contact_id>      ← custom avatars for contacts
  ├─ photos\<event_id>\        ← memory event photos
  └─ pets\                     ← built-in + user-imported pet packages
```

Backup zips are rooted at `soul-desktop-pet.db` and are restored atomically on import.

---

## 🗂 Project Structure

```
.
├─ main/                ← Electron main process (database, scheduling, IPC, pet engine)
│  ├─ main.js             entry point
│  ├─ db.js               sql.js wrapper + SQLite schema
│  ├─ scheduler.js        reminder queue + 1Hz intimacy pipeline
│  ├─ ipc.js              all IPC handlers
│  ├─ diary_content.js    the diary document validator (text blocks + galleries)
│  ├─ bond_engine.js      intimacy (tier 1+2) algorithm
│  ├─ cozy_engine.js      cozy (tier 3) algorithm
│  ├─ pet_controller.js   pet auto-behavior state machine
│  ├─ pet_registry.js     pet asset registry
│  ├─ pet_zip_import.js   user zip pet import
│  ├─ png_border_cutout.js  the shared cutout pipeline (mask, defringe, boundary expansion, hole repair, speck removal)
│  ├─ png_bottleneck_flood.js  cost field + edge-aware background flood
│  ├─ png_colorkey.js     PNG transparency wrapper (uses the cutout above)
│  ├─ png_alpha.js        detects frames that are already transparent
│  ├─ image_bg_remove.js  background-removal tool pipeline
│  ├─ image_batch_resize.js  batch image-resize tool pipeline (ffmpeg scale, alpha-preserving)
│  ├─ album_pdf.js        PDF album export
│  ├─ album_video.js      MP4 video album export
│  ├─ app_update.js       auto-update (GitHub Releases + SHA-256 verification)
│  ├─ quick_record.js     the 快速记录 window (right-click → 📝 记录)
│  ├─ pet_resume.js       suspend/resume recovery for the pet drag (a fallback — the renderer heals itself first)
│  ├─ pet_input_probe.js  watches the pet window's input path after a wake (is it alive but deaf?)
│  ├─ app_relaunch.js     kills the process and starts a new one (the last-resort wake recovery)
│  ├─ pet_state.js        the pet reminder-state payload (one shape for the broadcast and `pet:get_state`)
│  └─ festivals.js        festival library
├─ pet/                 ← pet window preload
├─ src/                 ← renderer process (main window)
│  ├─ index.html
│  ├─ pet.html           ← pet window HTML
│  ├─ quick_record.html  ← 快速记录 window HTML
│  └─ js/
│     ├─ main.js, api.js, router.js, auth.js, pet.js
│     ├─ form_fields.js   ← shared form builders / wiring / validation (main window + 快速记录)
│     ├─ gesture_guard.js  ← shared pointer-gesture guard (survives sleep / lost pointerup)
│     ├─ diary_themes.js  ← the six diary paper styles (single source of truth)
│     ├─ quick_record.js  ← 快速记录 window renderer
│     └─ pages/            router pages (today / contacts / events / export …)
│                        └─ diary_edit.js  ← the diary editor (/diary/new, /diary/:id)
├─ scripts/             ← utility scripts (incl. `verify-cutout.js`, the cutout regression check)
│  ├─ verify-diary-db.js       ← DB regression check for the diary fields (background / content)
│  └─ test-diary-editor.js     ← UI regression check for the diary editor
├─ docs/                ← documentation
│  └─ 角色制作与更换指南.md   ← character creation / replacement tutorial (Chinese)
├─ icons/               ← application icons (icon.ico + per-size PNGs)
├─ resources/           ← pet frame assets (several built-in pets included)
└─ package.json
```

### Module highlights

- **Main process** (`main/`): all database / filesystem / scheduling logic lives here; the renderer can only reach it through the whitelisted IPC exposed by `preload.js`;
- The **pet window** runs in its own process with a transparent, borderless, always-on-top window that never steals focus;
- **Dragging is driven from the main process**: the pet window is only ~220 px across and never takes focus, so the renderer's `mousemove` only fires while the pointer is *inside* that rectangle — the moment it leaves, the drag appears to freeze, and the lost `mouseup` leaves the drag state stuck forever (the pet becomes undraggable for the rest of the session). The gesture is therefore still detected in the renderer (press, 4 px threshold, release), but the **window position is followed by the main process via `screen.getCursorScreenPoint()`**, so the drag keeps working across the whole desktop. While a drag is in progress the main process also holds the autonomous-walk state machine still, so it doesn't fight the user for the window position;
- **The drag protocol is order-independent**: `pet:drag_start` cannot be sent synchronously — the renderer has to ask the main process where the window is before it can measure the grab offset, and that answer comes back asynchronously. A quick flick (press, move, release) is therefore over before the reply lands, and after a resume the main process can be slow to answer at all. When that happened the `pet:drag_end` **overtook** its own start: the main process processed the end first, then started following the cursor with nothing left to stop it. The pet was glued to the pointer (it could not be dragged anywhere) and the walk mutex stayed held, so the pet never walked on its own again — while the right-click menu kept working, because it does not go through the drag protocol at all. Two things make the protocol safe now:
  - The renderer **always sends the start and defers the end** onto the start's promise, so the two can never arrive swapped. The start is still sent for a flick that has already ended — skipping it would make the flick do nothing at all;
  - Both messages carry a **monotonic gesture id**, so the main process can recognise a message that belongs to a gesture it has already finished: a start whose id it has seen is refused, and an end for an older gesture does not stop the drag that is running now. The ids have to stay unique across a renderer reload, so the main process hands out its current high-water mark (`pet:gesture_base`) and the renderer offsets its own count by it — otherwise a reloaded renderer would have every drag refused as a replay and the pet would be undraggable until the app was restarted. `scripts/test-pet-drag-order.js` drives the real renderer and the real main-process handlers together, with an artificially slow main process, and asserts that the pet is *not* left glued to the cursor;
- **The grab offset is measured from the press, and in the window's own coordinates (`clientX`/`clientY`)**: the main process places the window with `window = cursor - offset`, so whatever the offset folds in is movement the pet *refuses* to make. The offset used to be taken from the pointermove that crossed the 4 px threshold, which quietly folded in everything the pointer had travelled since the press. The threshold is tiny, so the loss was a few pixels and went unnoticed — until a resume, when the renderer is slow to hand over pointer events and the **first move it delivers already carries everything the mouse did while the renderer was stalled**. The offset then swallowed the whole movement, the pet stayed exactly where it was, and the drag was dead while the right-click menu kept working. The offset is now taken from the press, in the window's own coordinates (`downClientX`/`downClientY`): that number *is* "where inside the window the pointer is", which is exactly what the main process needs, and it has no second term that can drift. The old form (`e.screenX - window.screenX`) mixed in "where the window is on the desktop" — an independent number the two can disagree about after the OS has moved the window during the sleep, so the pet ended up grabbed by a part of itself it was not on. It also saves an IPC round-trip (the renderer no longer has to ask the main process where the window is), so the takeover is no longer delayed and can no longer be lost when the main process was frozen. An offset that lands outside the window is rejected and the pet is grabbed by its centre instead. `scripts/test-pet-drag.js` (the offset is the grab point) and `scripts/test-pet-drag-live.js` (the pet follows the cursor by exactly the distance the pointer travelled) guard this;
- **The drag threshold is measured in the window's own coordinates too** (`clientX`/`clientY`): the threshold only has to answer "did the pointer move far enough?", and the client coordinates answer that with no reference to anything outside the window. The screen coordinates would answer it just as well — as long as they still track the pointer, which is exactly what cannot be assumed after the machine has been asleep: a renderer that was frozen across the sleep may deliver a first move whose screen coordinates are stale, and then the distance never reaches the threshold and the pet simply cannot be dragged;
- **Dragging survives sleep and hibernation** — this is a **self-healing** chain that does not rely on the OS delivering a notification:
  - *Why it broke*: a system suspend tears down and re-creates the pointer device, so on wake the mouse reports a **new `pointerId`**. The gesture still named the old (now dead) id, and the old "ignore pointer events that aren't mine" guard then **permanently rejected** every event from the new mouse. The pet was not stuck mid-drag — it was wedged in a state where no pointer event could ever start a new gesture, which is why it dragged fine at startup and could never be dragged again after a sleep;
  - *Renderer self-heal* (the primary fix): when `src/js/pet.js` receives a pointer event that **does not belong to the gesture it is holding**, it now handles two cases differently. **The gesture has not crossed the threshold yet** (the pet has not moved) → this is the system rebuilding the pointer device, so the gesture is **rebound** to the new device (the old capture is released, the new one taken, the new id remembered) and the drag starts as usual; the pet has not moved, so following a different pointer cannot make it jump. **The drag is already under way** (the pet is being moved by the user) → the gesture is torn down (the pointer capture is released, the pointer id cleared), because a second device must not take the drag over — the next press starts a clean one. The old code tore down in both cases, so the "press (old id) → move (new id)" pair always killed each other and the pet was wedged into a state where it could not be dragged at all. A `lostpointercapture` listener was added too — when the platform revokes the capture (a suspend rebuilds the device), the gesture is wound up instead of leaving a dangling pointer id;
  - *Mouse-event fallback* (the **actual culprit**, found in the real machine's log): after the wake, Chromium can stop delivering **pointer events** altogether while the **legacy mouse events** keep coming. The two are not the same pipeline: a pointer event is built from the raw input by `PointerEventFactory`, which needs a **registered pointer device**, while the legacy mouse events are built straight from the raw mouse input and need no device. A suspend tears the pointer device down and the OS brings it back as a new one, and the device registry can end up not knowing about it — so the raw input produces mouse events but no pointer events. **The symptom is exactly what the user reported**: the pet cannot be dragged (the drag was built on pointer events), but the right-click menu still opens (`contextmenu` is a mouse event) and a click on the pet still plays its action (`click` is a mouse event too). So the drag now accepts **both** families: whichever one delivers the press drives the gesture (`dragFamily`), the other one is ignored. In a healthy browser the pointer family always wins — `pointerdown` is dispatched before the compatibility mouse events, and the sprite's `pointerdown` handler calls `preventDefault()`, which suppresses the compatibility `mousedown` entirely — so the fallback costs nothing when the pointer events work. Note that **a new window cannot fix this**: the pointer device registry lives in the **browser process** and is shared by every window, so a replacement window inherits the broken registry — which is exactly what the real machine's log showed ("the window was restarted and the pet still could not be dragged"). `scripts/test-pet-drag.js` (a complete drag driven by mouse events alone) and `scripts/test-pet-drag-e2e.js` (the same in a real Chromium renderer) guard the fallback. A mouse gesture has **no pointer capture**, so a release that happens outside the window is never delivered — the gesture is then closed on `mouseleave` (and on a `mouseout` whose `relatedTarget` is null), otherwise it would stay open forever, swallow the next press and the pet could never be dragged again. Assertions 29 and 30 in `scripts/test-pet-drag.js` guard that;
  - *The family can change hands in the middle of a gesture*: the failure does not always happen between two gestures — it can happen **inside** one. The press arrives as a pointer event, the moves never do (the device was torn down between the two), and the gesture would sit there with a press and no movement: a click, and no drag. So while the pet has not moved yet, a move from the *other* family hands the gesture over (`family_switch` in the log): the mouse family takes over a pointer press whose moves never arrive, and the pointer family takes over a mouse press whose moves never arrive. The handover is only allowed **before** the threshold is crossed — once the pet is actually moving, a second device must not be allowed to grab it. The **compatibility mouse echo** that every pointer press produces is explicitly *not* a handover: it is recognised by identical screen coordinates (±2 px) and a timestamp under 100 ms, so a healthy browser never switches families. And the pet's own walk is **paused for two seconds on the press**, so it cannot walk out from under the pointer while the user is holding it. `scripts/test-pet-drag.js` asserts all three (assertions 35–38);
  - *Main-process fallback*: `main/pet_resume.js` listens for the system's `resume` / `unlock-screen` events and **unconditionally tears the drag down**: it stops the cursor poller, releases the walk mutex, re-asserts the window's visibility and mouse state, pulls the pet back into the visible work area, and tells the renderer to forget its gesture;
  - *Clock-jump watchdog* (the real safety net): Windows 11's Modern Standby **freezes the whole process** while the machine is asleep, so the wake notification is often never delivered at all (electron/electron#47739) — listening for power events alone is not enough. Timers do not replay the ticks missed during a sleep, but the **wall clock jumps forward** by the length of the sleep. Both the main process and the renderer therefore run a heartbeat that compares the gap between two ticks; a gap far larger than the heartbeat period proves the process was frozen, and the recovery runs. This path depends on **no OS event whatsoever**;
  - The threshold must be **larger** than the heartbeat period (a healthy gap is already ≈ the period), otherwise the watchdog would fire on every tick. `scripts/test-pet-resume.js` has a dedicated regression assertion for that relationship;
  - *The pet is restarted on every wake* (the user's explicit request): if the two layers above do not manage it, the pet ends up in a state where it simply cannot be dragged — so the pet is **restarted outright**, putting it back into the clean, freely draggable state it was in before the machine slept. What that means is **destroying the pet window and creating a new one** (`recreatePetWindow` in `main/main.js`), not merely reloading the page. **Why a new window and not a reload:** the diagnostic log from the real machine (2026-10-31) showed that after a reload the renderer still received IPC — it answered `pet:resume`, so it looked perfectly alive — but it never received a single pointer event again. A new window means a new native window, a new renderer and a new input registration. **Preserved:** the window's position and size, the main window, the database and the pet's identity. **Rebuilt:** the pet's page — which is the whole point. **It does not cure the pointer-event failure** — the pointer device registry lives in the browser process, so a replacement window inherits the broken one (the real machine's log proved that), which is why the **mouse-event fallback** above is what actually makes "still draggable after the wake" true; this layer is kept because the user asked for it explicitly, and it also clears any other unknown wedge. Both wake paths — the `resume` / `unlock-screen` events and the clock-jump watchdog — feed the same recovery function, so the restart happens even when the OS delivers no power event at all. It is de-duplicated to **one restart per wake** (10 s), because one sleep is usually reported more than once and the pet blinking twice for one sleep reads as a glitch. The de-duplication uses a **monotonic clock** (`performance.now()`) rather than the wall clock: the wall clock can jump backwards (a clock change, an NTP correction), and a negative gap would suppress the restart and leave the pet broken for the next ten minutes;
- **The last resort is to kill the process and start a new one** (the user's explicit fallback request): a window restart cannot repair the input path, because the pointer-device registry lives in the **browser process** — so the only cure is a new browser process. `main/app_relaunch.js` does exactly that: `app.relaunch({ args: process.argv.slice(1) })` followed by `app.exit(0)`. `exit` rather than `quit`, because `quit` can be vetoed by a `before-quit` handler and would leave a half-finished restart behind; `exit` cannot be vetoed, so the old process always dies and the new one always starts with the same launch arguments;
  - **A refused single-instance lock is retried, not fatal.** The relaunched process asks for the same lock the old process held. If the old one has not released it yet, the new one is told "another instance is already running" — and `main/main.js` used to quit on that answer, which would have left the user with **no app at all**, a worse outcome than the bug this mechanism exists to fix. The lock is now asked for again for up to six seconds, and a refusal that persists is retried rather than treated as "the app is already running, quit". `scripts/test-app-relaunch.js` proves the whole sequence against a **real** Electron: the lock is exclusive, a refused lock can be asked for again, and a real `app.relaunch()` + `app.exit(0)` really does bring the app back;
  - **The probe is what keeps a healthy wake from costing the user their main window** (`main/pet_input_probe.js`): it watches the pet window's input path and declares it dead only when three things hold at once: the **OS cursor moved** (the main process can read the cursor whether or not the renderer can), the cursor **is inside the pet window's bounds**, and the **renderer has reported nothing** (it reports `pet:input_alive` the first time it sees any input event after a wake). A renderer that is merely idle is never mistaken for a deaf one, and a cursor that moves elsewhere on the desktop proves nothing. It is the gate for the `auto` mode;
  - **The renderer is the only witness that can tell "alive" from "alive but deaf"** — it keeps answering IPC across the wake (so it looks perfectly healthy) while no mouse event ever reaches it. That is why the probe asks it;
  - **The mode is a setting** (`pet_restart_app_on_wake`, in 设置 → 睡眠唤醒后的恢复): **每次唤醒都重启应用** (the default — restart on every wake, no questions asked), **自动检测** (restart only when the probe proves the input path is dead) and **从不重启** (never). **The default is the blunt one on purpose**: the in-process recovery below does not cure every case — on the real machine (2026-10-31) the pet was still undraggable after a wake *with* a live input path (the pointer events arrived, the right-click menu opened, and the pet simply did not move) — and a fresh process is the only state that is known to work, because it is exactly the state `npm start` produces. One sleep is reported more than once (the `resume` event, the `unlock-screen` event and the clock-jump watchdog all fire for it), so the restart is de-duplicated to **one per wake** (10 s, on the monotonic clock). `scripts/test-pet-input-probe.js` guards the probe and the three modes;
  - **The in-process recovery still runs first, and it cannot swallow the restart**: the drag is torn down, the window is re-shown, the renderer is told to forget its gesture, the pet is clamped back into the visible work area, the pet's position is written to the database **and flushed to disk** (the database is normally written on a five-second timer, and the process is about to die — a `setPosition` whose `moved` event fires too late would be lost, and the pet would come back where it was before the clamp), and only then is the process replaced. The restart sits in a `finally`, so a step that throws cannot eat it;
- **The takeover has a timeout fallback**: handing the drag to the main process is an IPC round-trip, and the answer may never come when the main process was frozen across the sleep. The renderer does not wait forever — after 400 ms it drives the window position itself, measuring the movement in the window's own coordinates and from the press point (the window is not following the pointer in that mode, so the pointer's movement inside the window *is* its movement on the screen; measuring from the press point keeps the delta from feeding back into itself). So the pet still drags when the main process does not answer;
- **There is a diagnostic log for "the pet cannot be dragged"**: the bug only reproduces on real hardware (it needs an actual sleep), and two earlier fixes looked right on paper and were both wrong. The app therefore writes the drag process to `<userData>/pet-diagnostics.log` (append-only JSON Lines, written by both processes): every press (with its pointer id, screen coordinates, window coordinates and the element that was hit), every move (the first move and the one that crossed the threshold carry the full coordinates), the drag's start / takeover / end and the reason it ended, the main process's takeover record, the wake events, the renderer's **boot** (`boot`), the pet window's **creation and load** (`pet_window_loaded` / `pet_window_load_failed`), the pet's **restart** (`pet_window_recreated`) and every **mouse press / right-click menu** (`mouse` / `context_menu`). The log tells "the move events never arrived" apart from "the move arrived but never crossed the threshold" at a glance — and those two need completely different fixes; it also tells "the pet's page was never rebuilt" apart from "the page was rebuilt but the pointer events still do not arrive", and **"the pointer events are gone but the mouse events are not"** (mouse records but not a single `pointerdown` is exactly that). Every gesture also carries a **census** — `family` (which family drove it), `pointerMoves` and `mouseMoves` (how many moves each family delivered) and every handover (`family_switch`) — because "the pointer pipeline died mid-gesture" and "the user never moved the mouse" look exactly the same from the outside, and the log is the only thing that can tell them apart;
- The **three-layer intimacy model** is described under [Core Features](#-core-features) above;
- The **quick-record window** is a separate 400×640 window rather than a popup inside the pet window: the pet window is only ~220 px wide and could not physically hold a form with a contact picker and date fields. It asks the main process *which* kind to open with a **pull** (`quick-record:get_kind`) rather than a push on `did-finish-load` — the renderer is an ES module, so its listener is registered after that event fires and a pushed message would be dropped;
- **Both windows' event and memorial forms come from one module** (`src/js/form_fields.js`): the markup, the show/hide rules (启用提醒, 间隔天数, 阳历/农历) and the validation all live there, so the quick-record form is the main-window form rather than a copy of it. Adding a field means editing one file. `scripts/test-form-parity.js` compares the two windows' rendered forms field by field, so a field added to one and forgotten in the other fails the build.
- **Closing a pet reminder**: the nag has four ways out, and they all behave identically — clicking the pet, clicking its speech bubble, the right-click menu's **🔕 关闭提醒**, and the top bar's **桌宠提醒** pill (which opens the dialog, where 完成 does the same thing). They all end in one main-process action, `completeReminderForToday`: it writes a `reminder_acks` row, marks the queue item completed for today, and flips the pet back to NORMAL — so the badge counts down to zero, the sprite stops shaking, and the pill reads 桌宠正常 again. The reminder itself is **not deleted**: it stays on **Today** marked 已完成, so it can be revisited. For that to work the pet window has to know *which* reminder it is nagging about, so both `pet:state-changed` and `pet:get_state` carry `head.source` / `head.source_id`; the payload's shape is built in one place (`main/pet_state.js`) so the broadcast and the initial read cannot drift. `scripts/test-reminder-dismiss.js` and `scripts/test-reminder-pill.js` guard the pet-side and the top-bar paths.

---

## 📖 Getting Started

### 1. Unlock the main window
- On launch you get the desktop pet plus a PIN unlock screen (default PIN `8888`);
- Change the 4-digit PIN under **Settings → Access Password**.

### 2. Add a contact
- Go to **Contacts → New Contact**, fill in a name and relationship, pick or upload an avatar;
- In the contact detail page you can keep adding likes, taboos, gifts, and important dates.

### 3. Write a diary entry
- **Memory Events → New** → a diary page opens; write the title. The side panel on the right holds the paper style, the date and the linked contacts;
- Type the body directly. To add a picture, put the caret where it should go and click "插入图片" — the picture lands there and the text splits above and below it; keep writing under the image;
- You can pick several pictures at once; they form one gallery. Use **one / two / three / grid** under the group to change the arrangement, and drag the handle in a picture's bottom-right corner to resize it. To change the order, **drag the picture onto another one** — they swap places;
- Click **保存** → the mixed text-and-image document is stored in page order, ready for a one-click PDF / MP4 album export.

### 4. Wait for pet reminders
- The pet shows an unread reminder count in the corner and pops up automatically when the time comes;
- **Close a reminder whenever you like** — the nag never traps you: click the pet or its speech bubble, use **right-click → 🔕 关闭提醒**, or click the **桌宠提醒** pill in the top bar (it opens the same dialog with 完成 / 稍后 30 分钟 / 明天再提醒). Closing it only silences it for today; the entry stays on **Today** marked 已完成;
- Check everything for the day under **Today**.

### 5. Interact with the pet
- **Single click**: triggers the "single-click action" configured for that pet (default: a gentle pet);
- **Double click**: triggers the "double-click action" (default: head pat, unlocked at intimacy tier ≥ 5);
- **Right click**: opens the cozy interaction menu — pet / pat head / feed / play / sleep / dance, plus **📝 记录** for a quick record;
- Under **Settings → Character Actions** you can freely switch the character animation bound to each trigger.

### 6. Record something without unlocking anything
- **Right-click the pet → 📝 记录** → pick a kind (likes / taboos / gifts / reminder dates / memory events / work events) → fill in the form → **保存**;
- The window never asks for the PIN, and never shows your existing records — it only writes;
- Liked this? Add a contact first (step 2), since likes / taboos / gifts must be attached to one.

### 7. Switch pets / import a new pet
- **Settings → Desktop Pet Appearance** → pick one from the dropdown, or upload a frame-animation archive;
- 📘 Want to build your own? 👉 See the **[Character Creation & Replacement Guide](docs/角色制作与更换指南.md)**.

### 8. Back up and migrate
- **Settings → Data Migration → Export Backup** produces a zip with the database, all photos, and settings;
- **Import Backup** on another machine restores everything.

---

## 📚 Documentation

- 📘 **[Character Creation & Replacement Guide](docs/角色制作与更换指南.md)** (Chinese) — build a brand-new pet from scratch: split frames → sort PNGs → pack into a zip → import in one click.

> More documentation is on its way……

---


## 🧰 Tech Stack

| Layer | Choice |
|---|---|
| Desktop shell | Electron 32 |
| Database | sql.js (pure-JS SQLite, zero native dependencies) |
| Rendering | Vanilla HTML + ES Modules + hash router (no framework) |
| Packaging | electron-builder + NSIS |
| Video frame splitting | ffmpeg-static + fluent-ffmpeg |
| PDF generation | pdfkit |
| Lunar calendar | lunar-javascript |

> No cloud dependencies; no tracking; the network is used only when the OS updates Electron itself.

## 📸 Community Chat

Want to chat with the author and other users about pet tricks, report bugs, and share your own characters?

👉 Join the QQ group (scan the QR code below):

![QQ community group](assets/qq交流群.jpg)

---

## 🙏 Acknowledgements

This project was designed and implemented with inspiration from several excellent open-source projects:

- [desktop-pet](https://github.com/TonyNa-code/desktop-pet)
- [Monica](https://github.com/monicahq/monica)
- [Immich Memories](https://github.com/sam-dumont/immich-memories)
- [PhotoBook Studio](https://github.com/romaruss/ImmichPhotoBook)
- and other open-source works that provided inspiration……

---

## 📄 License

Apache License 2.0 — see [LICENSE](LICENSE) / [NOTICE](NOTICE).
