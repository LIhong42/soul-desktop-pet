// main/pet_zip_import.js — install a "frame-directory" pet zip into the
// user-data PetRegistry tree.
//
// Accepted shape (mirrors `resources/pets/default/`):
//   <root>/<variant>/<name>_NNN_NNNN.png
//
// `<variant>` is the name of an action (folder) the pet can play. Any
// folder name is accepted — `default`, `reminder`, `walking.right`,
// `blinking`, `dancing`, `headpat`, etc. — and each folder becomes its
// own manifest variant keyed by that folder name. The renderer can
// reference any of these by name through PetRegistry.resolveFrames().
//
// `default` is the only required folder (so the pet always has a
// still-frame to draw when no other action is active). Every other
// folder is optional; missing ones just mean that action won't fire.
//
// The root directory may be the zip's top-level entry (when the zip
// wraps the frames in a single folder, like the project's example.zip),
// or absent entirely (when frames sit at the zip root).
//
// The on-disk layout we publish is identical to the built-in `default` /
// `luna` packs (variant-name directories holding frame PNGs), so the
// existing PetRegistry (`main/pet_registry.js`) can pick it up with no
// further changes.
//
// installPetZip(zipPath, userDataPath)
//   → { ok, deduped, pet: { id, name }, rootDir }
//   → throws on invalid input (bad zip / no usable variant / IO error)
//   async — runs the background cutout over every *opaque* PNG before
//          publishing; frames that are already transparent are passed
//          through untouched.
//
// Transparent vs opaque packs
// --------------------------
// Two kinds of pack are supported:
//
//   * Opaque packs (the default) ship flat-backdrop frames. They go
//     through the border-connected cutout so the backdrop disappears.
//   * Transparent packs ship frames that are already cut out (an alpha
//     channel with real transparency). Those are passed through as-is:
//     there is no backdrop to remove, and running the cutout on them
//     would estimate the "backdrop colour" from the transparent
//     perimeter and start eating the character's own dark pixels.
//
// See `main/png_alpha.js` for how the two are told apart.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const { transparentizePng } = require('./png_colorkey');
const { isTransparentPng } = require('./png_alpha');

// Hard caps. Generous enough for a large pack with many high-res frames,
// tight enough that a single zip can't fill the user-data disk.
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;  // 1 GiB total unpacked
const MAX_ENTRIES     = 4096;
const MAX_PNG_BYTES   = 128 * 1024 * 1024;   // 128 MiB per single PNG

// Frame-naming convention used by PetRegistry.parseFrames():
//   ^(.*?)_(\d{3,7})_(\d{3,5})\.png$
// 3–7 位序号（覆盖到 100 万帧）和 3–5 位毫秒数（覆盖到 99999 ms ≈ 100 s/帧）。
const FRAME_REGEX_SRC = '^(.*?)_(\\d{3,7})_(\\d{3,5})\\.png$';
const FRAME_RE = new RegExp(FRAME_REGEX_SRC, 'i');

// Validate a variant directory name. Any folder name is accepted as long
// as it's a sensible identifier (no path separators, no Windows reserved
// chars, no leading dots, not too long). Each accepted folder becomes
// its own manifest variant keyed by its exact name — so `blinking/`,
// `dancing/`, `headpat/`, `walking.right/`, etc. are all valid actions.
const VARIANT_DIR_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;

// Reject any entry whose normalized name leaves the staging root, points
// at an absolute path, or is a Windows drive-rooted path. Defense against
// maliciously crafted zips (zip slip). We keep this strict on purpose.
function isUnsafeEntry(name) {
  if (!name) return true;
  if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)) return true;
  if (/(^|\/)\.\.(\/|$)/.test(name)) return true;
  return false;
}

// Minimal PNG header reader. PNG IHDR lives at offset 16 (4 bytes width,
// 4 bytes height, big-endian). Part of the PNG file format spec
// (https://www.w3.org/TR/PNG/#11IHDR).
function pngSize(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length < 24) throw new Error('PNG 太小');
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  const w = bytes.readUInt32BE(16);
  const h = bytes.readUInt32BE(20);
  if (!(w > 0) || !(h > 0) || w > 16384 || h > 16384) {
    throw new Error('PNG 尺寸超出范围');
  }
  return { w, h };
}

// Take the first frame in a variant directory and return its dimensions.
// PetRegistry requires defaultSize, so the `default` variant directory
// must yield at least one parseable frame.
function frameSizeFromDir(absDir) {
  let entries;
  try { entries = fs.readdirSync(absDir); }
  catch { throw new Error(`无法读取目录 ${absDir}`); }
  for (const name of entries) {
    if (!FRAME_RE.test(name)) continue;
    let buf;
    try { buf = fs.readFileSync(path.join(absDir, name)); }
    catch { continue; }
    try { return pngSize(buf); }
    catch { continue; }
  }
  return null;
}

// Strip the leading root prefix from an entry name so the rest of the
// pipeline can see the variant directories at the top level. Strips
// platform-specific separators and trailing slashes; returns null when
// nothing is left.
function stripRoot(entryName, rootPrefix) {
  const normalized = entryName.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!rootPrefix) return normalized;
  if (normalized === rootPrefix) return '';
  if (normalized.startsWith(rootPrefix + '/')) {
    return normalized.slice(rootPrefix.length + 1);
  }
  return null;
}

// Pick the zip's logical root directory. Strategy:
//   1. Collect every directory entry whose name has at least one slash.
//   2. Reduce to the *first* path segment that appears most often among
//      them — this naturally surfaces `example/` from `example.zip` and
//      ignores noise from a stray top-level file.
//   3. If no directory entries exist (or no first-segment repeats),
//      return '' meaning "use the zip root as-is".
// Returns the prefix string ('' or 'example') — not the original entry.
function pickRootPrefix(entries) {
  const counts = new Map();
  for (const e of entries) {
    if (e.isDirectory) continue;
    const norm = e.entryName.replace(/\\/g, '/');
    if (isUnsafeEntry(norm)) continue;
    const first = norm.split('/')[0];
    if (!first || first === '.') continue;
    counts.set(first, (counts.get(first) || 0) + 1);
  }
  if (counts.size === 0) return '';
  // Find max-count prefix; ties broken by shortest name (so `example`
  // wins over `example-extended-assets` when both appear once).
  let best = '';
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount || (count === bestCount && best.length === 0)) {
      best = name;
      bestCount = count;
    }
  }
  return best || '';
}

// Read every PNG (and compute its byte size) from the zip, grouped by the
// resolved variant directory. Skips unsafe / non-PNG entries; enforces
// caps. Returns { variants: { <variantName>: [{name, bytes}], … },
// totalBytes, rootPrefix }.
//
// Any folder name (matching VARIANT_DIR_RE) is accepted as a variant —
// no fixed whitelist. So a zip with `blinking/`, `dancing/`, `headpat/`,
// etc. each becomes its own variant entry, in addition to the required
// `default/`.
function readPackFromZip(zipPath) {
  const stat = fs.lstatSync(zipPath);
  if (stat.isSymbolicLink()) throw new Error('不允许符号链接');
  const zip = new AdmZip(zipPath);
  const rawEntries = zip.getEntries();
  if (rawEntries.length > MAX_ENTRIES) {
    throw new Error(`桌宠包包含超过 ${MAX_ENTRIES} 个条目`);
  }

  const rootPrefix = pickRootPrefix(rawEntries);
  // Map<variantName, Array<{name, bytes}>>. Keyed by directory name.
  const variants = new Map();
  let totalBytes = 0;

  for (const e of rawEntries) {
    if (e.isDirectory) continue;
    const norm = e.entryName.replace(/\\/g, '/');
    if (isUnsafeEntry(norm)) throw new Error(`非法路径条目：${e.entryName}`);
    const stripped = stripRoot(norm, rootPrefix);
    if (stripped === null) continue;          // outside root; ignore
    if (!stripped) continue;                  // the root entry itself
    const segs = stripped.split('/');
    if (segs.length < 2) continue;            // not inside a variant dir
    const dirName = segs[0];
    const fileName = segs.slice(1).join('/');
    if (segs.length !== 2) continue;          // don't allow extra nesting
    // Accept any folder name matching VARIANT_DIR_RE. Folders that fail
    // the check (empty, too long, has path separators, has Windows
    // reserved chars) are silently skipped — better to ignore a stray
    // bad folder than to reject an otherwise valid pack.
    if (!VARIANT_DIR_RE.test(dirName)) continue;
    if (!/\.png$/i.test(fileName)) continue;  // only PNGs

    const size = (e.header && e.header.size) || 0;
    if (size > MAX_PNG_BYTES) {
      throw new Error(`单帧 PNG 超过 ${Math.round(MAX_PNG_BYTES / 1024 / 1024)} MiB：${fileName}`);
    }
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`桌宠包总体积超过 ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MiB`);
    }

    const bytes = Buffer.from(e.getData());
    if (bytes.length > MAX_PNG_BYTES) {
      throw new Error(`解压后单帧超过 ${Math.round(MAX_PNG_BYTES / 1024 / 1024)} MiB：${fileName}`);
    }

    let bucket = variants.get(dirName);
    if (!bucket) {
      bucket = [];
      variants.set(dirName, bucket);
    }
    bucket.push({ name: fileName, bytes });
  }

  // `default` is the only hard requirement — the pet has nothing to
  // stand still on without it. Every other folder is optional; missing
  // folders just mean those actions won't fire.
  const defaultBucket = variants.get('default');
  if (!defaultBucket || defaultBucket.length === 0) {
    throw new Error('桌宠包缺少 default/ 子目录（必填）');
  }

  // Read frame size from the first parseable frame in default/. PetRegistry
  // uses defaultSize for window sizing, so we need at least one good frame.
  // We pull the bytes we already have in memory rather than going back to
  // disk.
  let frameSize = null;
  for (const f of defaultBucket) {
    if (!FRAME_RE.test(f.name)) continue;
    try { frameSize = pngSize(f.bytes); break; } catch {}
  }
  if (!frameSize) {
    throw new Error('default/ 子目录下找不到合法 PNG 帧（命名应为 <name>_NNN_NNNN.png）');
  }

  return { variants, frameSize, rootPrefix };
}

// Stable id from the full zip bytes. Same content → same id → idempotent
// re-import lands back on the existing directory instead of duplicating.
function digestFromZip(zipPath) {
  const bytes = fs.readFileSync(zipPath);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  return { id: `imported-${hash.slice(0, 16)}`, name: path.basename(zipPath, path.extname(zipPath)) };
}

// Move bytes out of an in-memory `[{name, bytes}]` list to disk under
// `dir`. Filenames are kept verbatim — the renderer's frame regex already
// depends on the exact `<name>_NNN_NNNN.png` shape.
function writeVariant(dir, files) {
  if (files.length === 0) return;
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    fs.writeFileSync(path.join(dir, f.name), f.bytes);
  }
}

// Public entry point.
//
//   userDataPath — the user-data parent dir (`<appData>/SoulDesktopPet`),
//                  matching the convention in `main/ipc.js:getPetsUserDataPath()`.
//                  The function itself appends `/pets/`.
//
// Returns: { ok:true, deduped:boolean, pet:{id,name}, rootDir }
async function installPetZip(zipPath, userDataPath) {
  if (!zipPath) throw new Error('zip 路径为空');
  if (!fs.existsSync(zipPath)) throw new Error('找不到桌宠压缩包');

  const { variants, frameSize, rootPrefix } = readPackFromZip(zipPath);
  const { id, name: zipBaseName } = digestFromZip(zipPath);

  const petsRoot = path.join(userDataPath, 'pets');
  fs.mkdirSync(petsRoot, { recursive: true });
  const targetDir = path.join(petsRoot, id);

  // Idempotent re-import: a directory with this id already exists with a
  // manifest.json — treat as a dedup hit and return the existing pet.
  if (fs.existsSync(targetDir) && fs.existsSync(path.join(targetDir, 'manifest.json'))) {
    let existingName = zipBaseName;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(targetDir, 'manifest.json'), 'utf8'));
      if (m && typeof m.name === 'string' && m.name.trim()) existingName = m.name;
    } catch {}
    return { ok: true, deduped: true, pet: { id, name: existingName }, rootDir: targetDir };
  }

  // Resolve a display name up front: prefer the auto-detected root folder
  // name (so `example.zip` → "example"); otherwise fall back to the zip's
  // basename. Declared outside `try` because the success return below
  // needs to read it.
  const petName = (rootPrefix && /^[a-zA-Z0-9_.\- ]{1,80}$/.test(rootPrefix))
    ? rootPrefix
    : zipBaseName;

  // Push every *opaque* PNG through the border-connected cutout so the pet
  // doesn't carry a solid black background to the desktop. Frames that
  // are already transparent are skipped — there is no backdrop to remove,
  // and the cutout would only risk eating the character's dark pixels.
  //
  // Runs *before* staging is created so a failure here leaves zero
  // on-disk artifacts — the catch block below only has work to do once
  // staging exists.
  // pngSize() (read-only, called earlier on the same Buffer objects)
  // inspects the IHDR width/height, which the re-encoded PNG keeps
  // identical, so it remains valid for the manifest's defaultSize.
  //
  // A frame that fails to cut out is passed through unchanged rather than
  // aborting the whole import: a pack may legitimately contain a frame
  // that is already transparent, and refusing the entire pet over one
  // odd frame is worse than leaving that frame as it was.
  //
  // The counts are reported back to the UI so the user can see what
  // happened to their pack (see the `cutout` field of the return value).
  let cutoutCount = 0;
  let skippedTransparent = 0;
  for (const bucket of variants.values()) {
    for (const f of bucket) {
      // Is this frame already a cut-out sprite? If so, leave it alone.
      let alreadyTransparent = false;
      try {
        const probe = await isTransparentPng(f.bytes);
        alreadyTransparent = !!probe.transparent;
      } catch (err) {
        // Detection failed — fall through to the cutout, which reports
        // its own error if the frame is unusable.
        console.error(`[pet_zip_import] transparency probe failed for ${f.name}:`, err.message);
      }

      if (alreadyTransparent) {
        skippedTransparent += 1;
        continue;
      }

      try {
        f.bytes = await transparentizePng(f.bytes);
        cutoutCount += 1;
      } catch (err) {
        console.error(`[pet_zip_import] cutout failed for ${f.name}, keeping original:`, err.message);
      }
    }
  }

  // Staging dir under a hidden prefix; renamed atomically on success so a
  // mid-write crash can't leave a half-installed pack visible to the
  // registry rescan.
  const staging = fs.mkdtempSync(path.join(petsRoot, '.import-'));
  try {
    // Walk the variant map (insertion order, so `default` appears first
    // when it exists). Each folder name becomes its own manifest
    // variant keyed by that exact name — no fixed whitelist.
    const variantDefs = {};
    for (const [name, files] of variants) {
      if (files.length === 0) continue;
      writeVariant(path.join(staging, name), files);
      variantDefs[name] = { roots: [name], loop: true };
    }

    const manifest = {
      id,
      name: petName,
      description: '',
      defaultSize: { w: frameSize.w, h: frameSize.h },
      frameRegex: FRAME_REGEX_SRC,
      variants: variantDefs,
      source: 'imported',
      origin: 'zip',
      importedAt: new Date().toISOString(),
    };

    fs.writeFileSync(
      path.join(staging, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );

    // Atomic publish.
    fs.renameSync(staging, targetDir);
  } catch (err) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    throw err;
  }

  return {
    ok: true,
    deduped: false,
    pet: { id, name: petName },
    rootDir: targetDir,
    // How many frames went through the cutout and how many were already
    // transparent. Surfaced so the UI can tell the user what happened.
    cutout: { processed: cutoutCount, skipped: skippedTransparent },
  };
}

// Convenience: drop an imported pet directory. Caller must verify the id
// starts with `imported-` before calling.
function removeImported(petId, userDataPath) {
  const dir = path.join(userDataPath, 'pets', petId);
  if (!fs.existsSync(dir)) throw new Error('桌宠不存在');
  fs.rmSync(dir, { recursive: true, force: true });
  return { removed: true, rootDir: dir };
}

module.exports = {
  installPetZip,
  removeImported,
  // exported for future callers
  _internal: { pickRootPrefix, pngSize, frameSizeFromDir, VARIANT_DIR_RE },
};
