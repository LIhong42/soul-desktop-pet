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
- Record important dates in the Gregorian or the **Chinese lunar calendar**, either one-off or recurring yearly.

### 📅 Recurring Reminders
- Birthdays, anniversaries, and festivals trigger on a cycle;
- **Lunar (traditional Chinese) calendar dates are supported**, with a built-in festival library: Valentine's Day, Teacher's Day, Qixi, Christmas, Father's Day… including floating festivals that are computed automatically;
- The pet shows an unread reminder badge in the corner and wakes you up when the time comes.

### 📷 Memory Events & Album Export
- "Memory events" record moments on a timeline, keeping every important highlight;
- One event can hold multiple photos — perfect for ritual moments like *"our first trip together"*;
- One-click export to a **PDF album** or an **MP4 video album**, with multiple templates and a live WYSIWYG preview;
- **Annual album**: automatically gathers all memories from a given year for a year-in-review.

### 💼 Work Event Reminders
- One-off or **cron-scheduled recurring** work reminders;
- Shown on a separate channel from personal events — never in the way, never missed.

### 🐾 The Pet Itself
- Translucent, borderless, always-on-top window that walks, idles, and falls asleep on its own;
- **Single click / double click / right click** interactions: pet the head, pat the head, feed, play, sleep, hug;
- Right click opens the **Cozy interaction menu** — all 6 actions are customizable per character animation.

### 💞 Intimacy System (three-layer architecture)
- **Bond (permanent bond)**: settled weekly across 10 dimensions, upgrading quarterly — your long-term relationship with the pet;
- **Cozy (short-term warmth)**: decays over time, a little more with each play session, and drives the pet's current mood;
- **Mood (emotion)**: derived from Cozy plus the day's activity, and drives the pet's expression filters.

> Advanced interactions such as double-click head patting unlock at intimacy tier ≥ 5.

### 🎨 Customization & Pluggable Characters
- Every pet can be configured independently: click action / idle loop action / 6 cozy actions in the right-click menu;
- Upload a frame-animation PNG package and **a new pet is generated automatically and ready to use**;
- Built-in frame splitter: cut a video into a PNG sequence and zip it — DIY your own desktop pet.

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
│  ├─ bond_engine.js      intimacy (tier 1+2) algorithm
│  ├─ cozy_engine.js      cozy (tier 3) algorithm
│  ├─ pet_controller.js   pet auto-behavior state machine
│  ├─ pet_registry.js     pet asset registry
│  ├─ pet_zip_import.js   user zip pet import
│  ├─ album_pdf.js        PDF album export
│  ├─ album_video.js      MP4 video album export
│  ├─ app_update.js       auto-update (GitHub Releases + SHA-256 verification)
│  └─ festivals.js        festival library
├─ pet/                 ← pet window preload
├─ src/                 ← renderer process (main window)
│  ├─ index.html
│  ├─ pet.html           ← pet window HTML
│  └─ js/
│     ├─ main.js, api.js, router.js, auth.js, pet.js
│     └─ pages/            router pages (today / contacts / events / export …)
├─ scripts/             ← utility scripts (including several smoke tests)
├─ docs/                ← documentation
│  └─ 角色制作与更换指南.md   ← character creation / replacement tutorial (Chinese)
├─ icons/               ← application icons
├─ resources/           ← pet frame assets (several built-in pets included)
└─ package.json
```

### Module highlights

- **Main process** (`main/`): all database / filesystem / scheduling logic lives here; the renderer can only reach it through the whitelisted IPC exposed by `preload.js`;
- The **pet window** runs in its own process with a transparent, borderless, always-on-top window that never steals focus;
- The **three-layer intimacy model** is described under [Core Features](#-core-features) above.

---

## 📖 Getting Started

### 1. Unlock the main window
- On launch you get the desktop pet plus a PIN unlock screen (default PIN `8888`);
- Change the 4-digit PIN under **Settings → Access Password**.

### 2. Add a contact
- Go to **Contacts → New Contact**, fill in a name and relationship, pick or upload an avatar;
- In the contact detail page you can keep adding likes, taboos, gifts, and important dates.

### 3. Create a memory event and upload photos
- **Memory Events → New** → fill in a title, date, and linked contacts;
- In the detail page, upload photos in bulk, then export a PDF / MP4 album with one click.

### 4. Wait for pet reminders
- The pet shows an unread reminder count in the corner and pops up automatically when the time comes;
- Click the pet to bring up the main window / reminder dialog, or check everything for the day under **Today**.

### 5. Interact with the pet
- **Single click**: triggers the "single-click action" configured for that pet (default: a gentle pet);
- **Double click**: triggers the "double-click action" (default: head pat, unlocked at intimacy tier ≥ 5);
- **Right click**: opens the cozy interaction menu — pet / pat head / feed / play / sleep / hug;
- Under **Settings → Character Actions** you can freely switch the character animation bound to each trigger.

### 6. Switch pets / import a new pet
- **Settings → Desktop Pet Appearance** → pick one from the dropdown, or upload a frame-animation archive;
- 📘 Want to build your own? 👉 See the **[Character Creation & Replacement Guide](docs/角色制作与更换指南.md)**.

### 7. Back up and migrate
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
