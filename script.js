import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://xheahheaorzqeguuxitq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Y-DnJaKwHXhsJWz7BFXCwg_DW_qfR3q";
const BUCKET = "private-files";
const MAX_FILE_BYTES = 50 * 1024 * 1024 - 1024; // ~50 MB (encryption adds 28 bytes; bucket limit is 50 MB)
const CHUNK_BYTES = 6 * 1024 * 1024; // Supabase resumable (TUS) uploads need 6 MB chunks
const UPLOAD_CONCURRENCY = 12; // practically "all at once"; lower it if the browser feels heavy
const MAX_PARALLEL_BYTES = 300 * 1024 * 1024; // bigger batches upload 3 at a time (files are encrypted in memory)
const THUMB_MAX_BYTES = 8 * 1024 * 1024; // image previews only for images up to 8 MB
const THUMB_PX = 96; // preview is shrunk to this size (small + fast)
const MARQUEE_MAX = 20; // at most this many long names scroll; the rest show "name…"
const configured =
  SUPABASE_URL.startsWith("https://") &&
  !SUPABASE_URL.includes("PASTE_") &&
  !SUPABASE_ANON_KEY.includes("PASTE_");
// Direct storage hostname = faster uploads. If it ever fails, use `${SUPABASE_URL}/storage/v1/upload/resumable`.
const TUS_ENDPOINT = configured
  ? `https://${new URL(SUPABASE_URL).hostname.split(".")[0]}.storage.supabase.co/storage/v1/upload/resumable`
  : "";
const supabase = configured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;
const $ = (id) => document.getElementById(id);
const loginCard = $("loginCard"),
  dashboard = $("dashboard"),
  loginStatus = $("loginStatus"),
  uploadStatus = $("uploadStatus");
let busy = false;
let currentUserId = null;
let currentFiles = []; // files shown in the current folder
let currentFolders = []; // sub-folders shown in the current folder
let path = []; // breadcrumb: [{ id, name }, ...]; empty = root
let sortAsc = false; // false = newest first
let loadSeq = 0; // guards against out-of-order list refreshes

// ---CRYPTO-START---
// End-to-end encryption: files and file names are encrypted in the browser
// (AES-GCM 256). The key is derived from ID + password and never leaves the browser.
let cryptoKey = null;
const enc = new TextEncoder(),
  dec = new TextDecoder();
async function deriveKey(id, password) {
  const base = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode("privatedrop-v1:" + id.trim().toLowerCase()),
      iterations: 600000,
      hash: "SHA-256",
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
async function encryptBytes(buf) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, buf),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}
async function decryptBytes(buf) {
  const b = new Uint8Array(buf);
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b.slice(0, 12) },
    cryptoKey,
    b.slice(12),
  );
}
const toB64 = (u8) => btoa(String.fromCharCode(...u8));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function encryptMeta(obj) {
  return toB64(await encryptBytes(enc.encode(JSON.stringify(obj))));
}
async function decryptMeta(str) {
  return JSON.parse(dec.decode(await decryptBytes(fromB64(str))));
}
// ---CRYPTO-END---

// Keep the (non-extractable) key in IndexedDB so a page reload does not log you out.
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("privatedrop", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("keys");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbOp(mode, fn) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction("keys", mode);
    const req = fn(tx.objectStore("keys"));
    tx.oncomplete = () => res(req.result);
    tx.onerror = () => rej(tx.error);
  });
}
const saveKey = (uid, k) =>
  idbOp("readwrite", (s) => s.put(k, uid)).catch(() => {});
const loadKey = (uid) => idbOp("readonly", (s) => s.get(uid)).catch(() => null);
const dropKey = (uid) =>
  idbOp("readwrite", (s) => s.delete(uid)).catch(() => {});

function showStatus(el, message, ok = false) {
  el.textContent = message;
  el.className = "status show" + (ok ? " ok" : "");
}
function clearStatus(el) {
  el.textContent = "";
  el.className = "status";
}
// Internal (fake) email domain. Users type only their ID; we add this domain.
// Old accounts use privatedrop.invalid, so login always tries both domains.
const EMAIL_DOMAIN = "privatedrop.invalid"; // domain used for NEW registrations
const LOGIN_DOMAINS = [...new Set([EMAIL_DOMAIN, "privatedrop.invalid"])];
function idToEmail(id, domain = EMAIL_DOMAIN) {
  return id.trim().toLowerCase() + "@" + domain;
}
// Invite link: https://your-site/?invite=SECRET_CODE
const inviteCode = new URLSearchParams(location.search).get("invite") || "";
let mode = "login";
function setMode(m) {
  mode = m;
  const reg = m === "register";
  $("authTitle").textContent = reg
    ? "Create your account"
    : "As-salamu-alaykum";
  $("authSub").textContent = reg
    ? "Register with your private invite link"
    : "Sign in to your private workspace";
  $("loginBtn").textContent = reg ? "Register" : "Sign in";
  $("confirmField").classList.toggle("hidden", !reg);
  $("regNote").classList.toggle("hidden", !reg);
  $("switchMode").textContent = reg
    ? "Already have an account? Sign in"
    : "Have an invite? Register";
  $("password").autocomplete = reg ? "new-password" : "current-password";
  clearStatus(loginStatus);
}
function safeName(name) {
  return (
    name
      .replace(/[\/\\]/g, "_")
      .replace(/[\u0000-\u001f]/g, "_")
      .slice(0, 180) || "file"
  );
}
function safeFolderName(name) {
  const n = safeName(name).trim();
  return /^\.+$/.test(n) ? "_" : n;
}
function prettySize(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function setBusy(v) {
  busy = v;
  $("loginBtn").disabled = v;
  $("fileInput").disabled = v;
  $("folderInput").disabled = v;
  $("folderBtn").disabled = v;
  $("downloadAllBtn").disabled = v || !currentFiles.length;
  $("deleteAllBtn").disabled =
    v || !(currentFiles.length || currentFolders.length);
}
const currentFolderId = () => path.at(-1)?.id ?? null;
const inFolder = (q, col, id) => (id ? q.eq(col, id) : q.is(col, null));

/* ---------- file types, short names, scrolling names ---------- */
const EXT_KIND = {};
for (const [kind, list] of Object.entries({
  image: "jpg jpeg png gif webp svg bmp avif ico heic tif tiff",
  video: "mp4 mkv mov avi webm wmv flv m4v 3gp mpeg mpg",
  audio: "mp3 wav ogg flac aac m4a opus",
  archive: "zip 7z rar tar gz tgz bz2 xz zst iso",
  text: "txt md log csv json xml yml yaml ini cfg js ts jsx tsx html css py c cpp h hpp java sh sql",
  document: "pdf doc docx xls xlsx ppt pptx odt ods odp rtf epub",
}))
  for (const e of list.split(" ")) EXT_KIND[e] = kind;
// text/document/other keep the original "▤" document glyph.
const ICON = {
  folder: "fa-folder",
  image: "fa-image",
  video: "fa-film",
  audio: "fa-music",
  archive: "fa-file-zipper",
};
function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}
function kindOf(name, mime = "") {
  const k = EXT_KIND[extOf(name)];
  if (k) return k;
  const t = mime.split("/")[0];
  return ["image", "video", "audio", "text"].includes(t) ? t : "other";
}
function setIcon(box, kind) {
  box.replaceChildren();
  if (ICON[kind]) {
    const i = document.createElement("i");
    i.className = "fa-solid " + ICON[kind];
    box.append(i);
  } else box.textContent = "▤";
}
function shortName(name, max = 12) {
  if (name.length <= max) return name;
  const ext = extOf(name),
    tail = ext ? "." + ext : "";
  return name.slice(0, Math.max(3, max - tail.length - 1)) + "…" + tail;
}
// Long names scroll right-to-left inside their own box (capped, so the page stays fast).
function applyMarquee() {
  const boxes = [...$("fileList").querySelectorAll(".filename")];
  boxes.forEach((b) => {
    b.classList.remove("marq");
    b.firstElementChild.textContent = b.dataset.full;
  });
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const over = boxes
    .filter((b) => b.scrollWidth > b.clientWidth + 1)
    .slice(0, MARQUEE_MAX)
    .map((b) => [b, b.scrollWidth]);
  for (const [b, w] of over) {
    const unit = b.dataset.full + "\u2003•\u2003";
    b.firstElementChild.textContent = unit + unit;
    b.style.setProperty("--dur", Math.max(6, (w + 40) / 40) + "s");
    b.classList.add("marq");
  }
}

/* ---------- image previews (files are encrypted, so decrypt in the browser) ---------- */
const MIME_BY_EXT = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
  ico: "image/x-icon",
};
let thumbObs = null;
const thumbJobs = new Map();
const thumbCache = new Map(); // file id -> small preview URL; kept until log out so refresh/sort is instant
function resetThumbs() {
  thumbObs?.disconnect();
  thumbObs = null;
  thumbJobs.clear();
}
function clearThumbCache() {
  thumbCache.forEach((u) => URL.revokeObjectURL(u));
  thumbCache.clear();
}
// Shrink the decrypted image to a small JPEG so the big picture is not kept in memory.
async function makeThumb(plain, type) {
  const blob = new Blob([plain], { type });
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.max(THUMB_PX / bmp.width, THUMB_PX / bmp.height);
    const w = bmp.width * scale,
      h = bmp.height * scale;
    const c = document.createElement("canvas");
    c.width = c.height = THUMB_PX;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, THUMB_PX, THUMB_PX);
    ctx.drawImage(bmp, (THUMB_PX - w) / 2, (THUMB_PX - h) / 2, w, h);
    bmp.close?.();
    const out = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.82));
    if (out) return URL.createObjectURL(out);
  } catch (e) {
    /* e.g. SVG: fall back to the original image below */
  }
  return URL.createObjectURL(blob);
}
function showThumb(icon, url) {
  const img = document.createElement("img");
  img.alt = "";
  img.onerror = () => setIcon(icon, "image");
  img.src = url;
  icon.replaceChildren(img);
}
async function loadThumb(file, icon) {
  const cached = thumbCache.get(file.id);
  if (cached) return showThumb(icon, cached);
  const sp = document.createElement("i");
  sp.className = "fa-solid fa-spinner fa-spin";
  icon.replaceChildren(sp);
  try {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(file.storage_path);
    if (error || !data) throw error || new Error("download failed");
    const plain = await decryptBytes(await data.arrayBuffer());
    const type = file.type?.startsWith("image/")
      ? file.type
      : MIME_BY_EXT[extOf(file.name)] || "image/png";
    const url = await makeThumb(plain, type);
    thumbCache.set(file.id, url);
    if (thumbCache.size > 300) {
      const [k, u] = thumbCache.entries().next().value;
      URL.revokeObjectURL(u);
      thumbCache.delete(k);
    }
    if (icon.isConnected) showThumb(icon, url);
  } catch (e) {
    if (icon.isConnected) setIcon(icon, "image");
  }
}
// Only images that are scrolled into view are downloaded/decrypted.
function watchThumb(icon, file) {
  thumbObs ??= new IntersectionObserver(
    (entries, obs) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        obs.unobserve(e.target);
        const job = thumbJobs.get(e.target);
        thumbJobs.delete(e.target);
        if (job) loadThumb(job, e.target);
      }
    },
    { root: $("fileList"), rootMargin: "100px" },
  );
  thumbJobs.set(icon, file);
  thumbObs.observe(icon);
}

function renderSignedIn(user) {
  currentUserId = user?.id || null;
  loginCard.classList.add("hidden");
  dashboard.classList.remove("hidden");
  $("userId").value = user?.email?.split("@")[0] || "";
}
function renderSignedOut() {
  currentUserId = null;
  currentFiles = [];
  currentFolders = [];
  path = [];
  resetThumbs();
  clearThumbCache();
  dashboard.classList.add("hidden");
  loginCard.classList.remove("hidden");
  $("fileList").innerHTML = '<div class="empty">Sign in to load files.</div>';
  $("fileCount").textContent = "0 files";
  $("downloadAllBtn").disabled = true;
  $("deleteAllBtn").disabled = true;
}

/* ---------- breadcrumb + list ---------- */
function renderBreadcrumb() {
  const bar = $("breadcrumb");
  bar.replaceChildren();
  const parts = [{ name: "Home", icon: "fa-house" }, ...path];
  parts.forEach((p, i) => {
    const last = i === parts.length - 1;
    if (i) {
      const sep = document.createElement("i");
      sep.className = "fa-solid fa-chevron-right sep";
      bar.append(sep);
    }
    const el = document.createElement(last ? "span" : "button");
    el.className = "crumb" + (last ? " current" : "");
    if (p.icon) {
      const ic = document.createElement("i");
      ic.className = "fa-solid " + p.icon;
      el.append(ic, " ");
    }
    el.append(p.name);
    if (!last)
      el.addEventListener("click", () => {
        path = path.slice(0, i);
        refreshFiles();
      });
    bar.append(el);
  });
}
function makeRow(kind, name, meta, label) {
  const row = document.createElement("div");
  row.className = "file";
  const icon = document.createElement("div");
  icon.className = "fileicon";
  setIcon(icon, kind);
  const info = document.createElement("div");
  info.className = "fileinfo";
  const n = document.createElement("div");
  n.className = "filename";
  n.dataset.full = name;
  n.title = name;
  const nm = document.createElement("span");
  nm.className = "nm";
  nm.textContent = name;
  n.append(nm);
  const s = document.createElement("div");
  s.className = "filesize";
  s.textContent = meta;
  info.append(n, s);
  const fmt = document.createElement("span");
  fmt.className = "fmt";
  fmt.textContent = label;
  fmt.title = label;
  row.append(icon, info, fmt);
  return { row, icon };
}
function iconButton(iconClass, title, onClick) {
  const b = document.createElement("button");
  b.className = "download";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = `<i class="fa-solid ${iconClass}"></i>`;
  b.addEventListener("click", onClick);
  return b;
}
// Folder names are stored encrypted. Older (plain) names are shown as they are.
async function folderLabel(stored) {
  try {
    const m = await decryptMeta(stored);
    return typeof m.name === "string" && m.name ? m.name : stored;
  } catch (e) {
    return stored;
  }
}
async function refreshFiles() {
  if (!supabase) return;
  const seq = ++loadSeq;
  renderBreadcrumb();
  const parent = currentFolderId();
  const order = { ascending: sortAsc };
  const [fo, fi] = await Promise.all([
    inFolder(
      supabase
        .from("folders")
        .select("id,name,created_at,updated_at")
        .order("created_at", order),
      "parent_id",
      parent,
    ),
    inFolder(
      supabase
        .from("files")
        .select("id,original_name,size_bytes,created_at,storage_path")
        .order("created_at", order),
      "folder_id",
      parent,
    ),
  ]);
  if (seq !== loadSeq) return;
  const error = fo.error || fi.error;
  if (error) {
    currentFiles = [];
    currentFolders = [];
    $("downloadAllBtn").disabled = true;
    $("deleteAllBtn").disabled = true;
    $("fileList").innerHTML = "";
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "Could not load files: " + error.message;
    $("fileList").append(e);
    return;
  }
  const [folders, files] = await Promise.all([
    Promise.all(
      fo.data.map(async (f) => ({ ...f, label: await folderLabel(f.name) })),
    ),
    Promise.all(
      fi.data.map(async (f) => {
        try {
          const m = await decryptMeta(f.original_name);
          return { ...f, name: m.name, size: m.size, type: m.type || "" };
        } catch (e) {
          return {
            ...f,
            name: "(old / unreadable file)",
            size: Number(f.size_bytes) || 0,
            type: "",
          };
        }
      }),
    ),
  ]);
  if (seq !== loadSeq) return;
  currentFolders = folders;
  currentFiles = files;
  resetThumbs();
  $("downloadAllBtn").disabled = busy || !files.length;
  $("deleteAllBtn").disabled = busy || !(files.length || folders.length);
  const count = folders.length + files.length;
  $("fileCount").textContent = `${count} ${count === 1 ? "item" : "items"}`;
  $("fileList").replaceChildren();
  if (!count) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = parent
      ? "This folder is empty. Drop files or a folder here."
      : "No files yet. Upload one.";
    $("fileList").append(e);
    return;
  }
  for (const f of folders) {
    const { row } = makeRow(
      "folder",
      f.label,
      "Folder · " + new Date(f.updated_at || f.created_at).toLocaleString(),
      "FOLDER",
    );
    const open = () => {
      path = [...path, { id: f.id, name: f.label }];
      refreshFiles();
    };
    row.classList.add("folder");
    row.addEventListener("click", (e) => {
      if (!e.target.closest("button")) open();
    });
    row.append(
      iconButton("fa-folder-open", "Open folder", open),
      iconButton("fa-trash", "Delete folder", () => deleteFolder(f)),
    );
    $("fileList").append(row);
  }
  for (const file of files) {
    const ext = extOf(file.name);
    const kind = kindOf(file.name, file.type);
    const { row, icon } = makeRow(
      kind,
      file.name,
      prettySize(file.size || 0) +
        " · " +
        new Date(file.created_at).toLocaleString(),
      ext ? ext.toUpperCase() : "FILE",
    );
    if (kind === "image" && file.size > 0 && file.size <= THUMB_MAX_BYTES) {
      const cached = thumbCache.get(file.id);
      if (cached) showThumb(icon, cached);
      else watchThumb(icon, file);
    }
    const btn = iconButton("fa-download", "Download", () =>
      downloadFile(file, btn),
    );
    const del = iconButton("fa-trash", "Delete file", async () => {
      if (!confirm("Delete this file?")) return;
      const { error: se } = await supabase.storage
        .from(BUCKET)
        .remove([file.storage_path]);
      if (se) {
        showStatus(uploadStatus, "Delete failed: " + se.message);
        return;
      }
      const { error: de } = await supabase
        .from("files")
        .delete()
        .eq("id", file.id);
      if (de) showStatus(uploadStatus, "Delete failed: " + de.message);
      await refreshFiles();
    });
    row.append(btn, del);
    $("fileList").append(row);
  }
  applyMarquee();
}

/* ---------- upload ---------- */
async function ensureFolder(parentId, rawName) {
  const name = safeFolderName(rawName);
  const { data: list, error } = await inFolder(
    supabase.from("folders").select("id,name"),
    "parent_id",
    parentId,
  );
  if (error) throw error;
  for (const f of list)
    if ((await folderLabel(f.name)).toLowerCase() === name.toLowerCase())
      return f.id;
  const { data, error: e2 } = await supabase
    .from("folders")
    .insert({
      name: await encryptMeta({ name }), // folder names are encrypted too
      parent_id: parentId,
      created_by: currentUserId,
    })
    .select("id")
    .single();
  if (e2) throw e2;
  return data.id;
}
function addProgress(name) {
  const el = document.createElement("div");
  el.className = "up";
  el.innerHTML =
    '<div class="ring"><svg viewBox="0 0 36 36"><circle class="bg" cx="18" cy="18" r="16"/><circle class="fg" cx="18" cy="18" r="16" pathLength="100"/></svg><span>0%</span></div><div class="upname"></div>';
  el.querySelector(".upname").textContent = shortName(name, 9);
  el.title = name;
  const fg = el.querySelector(".fg"),
    pct = el.querySelector(".ring span");
  $("uploadQueue").append(el);
  return {
    set(p) {
      const v = Math.max(0, Math.min(100, Math.round(p)));
      fg.style.strokeDashoffset = 100 - v;
      pct.textContent = v + "%";
    },
    remove: () => el.remove(),
  };
}
// Browser build of tus-js-client, loaded as a normal <script> (the esm.sh build is for Node).
let tusLib;
function loadTus() {
  tusLib ??= new Promise((resolve, reject) => {
    if (window.tus) return resolve(window.tus);
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/tus-js-client@4/dist/tus.min.js";
    s.onload = () =>
      window.tus ? resolve(window.tus) : reject(new Error("tus not available"));
    s.onerror = () => reject(new Error("tus failed to load"));
    document.head.append(s);
  });
  return tusLib;
}
// Fallback: one raw binary POST straight to Storage, with real upload progress.
async function xhrUpload(blob, objectName, onProgress) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const p = objectName.split("/").map(encodeURIComponent).join("/");
    xhr.open("POST", `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${p}`);
    xhr.setRequestHeader("Authorization", "Bearer " + session.access_token);
    xhr.setRequestHeader("apikey", SUPABASE_ANON_KEY);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) =>
      e.lengthComputable && onProgress((e.loaded / e.total) * 100);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = "Upload failed (" + xhr.status + ")";
      try {
        msg = JSON.parse(xhr.responseText).message || msg;
      } catch (e) {}
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(blob);
  });
}
// Raw binary chunks straight to Supabase Storage (TUS resumable); falls back to xhrUpload.
async function sendFile(blob, objectName, onProgress) {
  let tus;
  try {
    tus = await loadTus();
  } catch (e) {
    return xhrUpload(blob, objectName, onProgress);
  }
  try {
    await new Promise((resolve, reject) => {
      new tus.Upload(blob, {
        endpoint: TUS_ENDPOINT,
        retryDelays: [0, 2000, 5000, 10000],
        headers: { apikey: SUPABASE_ANON_KEY },
        onBeforeRequest: async (req) => {
          const {
            data: { session },
          } = await supabase.auth.getSession();
          req.setHeader("authorization", "Bearer " + session.access_token);
        },
        uploadDataDuringCreation: true,
        storeFingerprintForResuming: false,
        metadata: {
          bucketName: BUCKET,
          objectName,
          contentType: "application/octet-stream",
          cacheControl: "3600",
        },
        chunkSize: CHUNK_BYTES,
        onError: reject,
        onProgress: (sent, total) =>
          onProgress(total ? (sent / total) * 100 : 100),
        onSuccess: () => resolve(),
      }).start();
    });
  } catch (e) {
    onProgress(0);
    await xhrUpload(blob, objectName, onProgress);
  }
}
async function uploadOne(file, folderId) {
  const ui = addProgress(file.name);
  try {
    // Encrypt in the browser; only encrypted bytes and an encrypted name leave the device.
    const encrypted = await encryptBytes(await file.arrayBuffer());
    const meta = await encryptMeta({
      name: safeName(file.name),
      size: file.size,
      type: file.type || "",
    });
    // Every user's files live inside their own folder: <user-id>/...
    const objectName = currentUserId + "/" + crypto.randomUUID(); // no real name in storage
    await sendFile(new Blob([encrypted]), objectName, ui.set);
    const { error: dbError } = await supabase.from("files").insert({
      original_name: meta,
      size_bytes: encrypted.length,
      storage_path: objectName,
      folder_id: folderId,
      uploaded_by: currentUserId,
    });
    if (dbError) {
      await supabase.storage.from(BUCKET).remove([objectName]);
      throw dbError;
    }
  } finally {
    ui.remove();
  }
}
// items: [{ file?: File, dirs: string[] }]  (dirs = folder path relative to the current folder)
async function uploadItems(items) {
  if (!supabase || busy || !items.length) return;
  clearStatus(uploadStatus);
  const uid = currentUserId || (await supabase.auth.getUser()).data.user?.id;
  if (!uid) {
    showStatus(uploadStatus, "Please sign in again.");
    return;
  }
  if (!cryptoKey) {
    showStatus(uploadStatus, "Please sign in again (encryption key missing).");
    return;
  }
  currentUserId = uid;
  setBusy(true);
  const base = currentFolderId(),
    folderCache = new Map(),
    errors = [],
    queue = [...items],
    total = items.filter((i) => i.file).length,
    sum = $("uploadSummary");
  let ok = 0;
  const sync = () =>
    (sum.textContent = total > 1 ? `Uploaded ${ok} of ${total}…` : "");
  const folderFor = async (dirs) => {
    let parent = base;
    for (let i = 0; i < dirs.length; i++) {
      const key = dirs
        .slice(0, i + 1)
        .join("/")
        .toLowerCase();
      if (!folderCache.has(key))
        folderCache.set(key, ensureFolder(parent, dirs[i]));
      parent = await folderCache.get(key);
    }
    return parent;
  };
  const worker = async () => {
    for (let it; (it = queue.shift()); ) {
      try {
        const folderId = await folderFor(it.dirs);
        if (!it.file) continue;
        if (it.file.size > MAX_FILE_BYTES)
          throw new Error("over the 50 MB limit.");
        await uploadOne(it.file, folderId);
        ok++;
        sync();
      } catch (err) {
        errors.push(
          `${it.file?.name || it.dirs.join("/")}: ${err.message || "Unknown error"}`,
        );
      }
    }
  };
  sync();
  const batchBytes = items.reduce((n, i) => n + (i.file?.size || 0), 0);
  const limit = batchBytes > MAX_PARALLEL_BYTES ? 3 : UPLOAD_CONCURRENCY;
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, worker),
  );
  sum.textContent = "";
  if (errors.length)
    showStatus(
      uploadStatus,
      `${ok}/${total} uploaded. ` +
        errors.slice(0, 3).join(" | ") +
        (errors.length > 3 ? ` (+${errors.length - 3} more)` : ""),
    );
  else
    showStatus(
      uploadStatus,
      !total
        ? "Folder created."
        : total === 1
          ? `Uploaded ${items.find((i) => i.file).file.name}`
          : `Uploaded ${ok} files`,
      true,
    );
  setBusy(false);
  $("fileInput").value = "";
  $("folderInput").value = "";
  await refreshFiles();
}
// Walk dropped files/folders (nested). Must be called synchronously inside the drop event.
async function collectDropped(dt) {
  const entries = [...dt.items]
    .filter((i) => i.kind === "file")
    .map((i) => i.webkitGetAsEntry?.())
    .filter(Boolean);
  if (!entries.length) return [...dt.files].map((file) => ({ file, dirs: [] }));
  const out = [];
  const walk = async (entry, dirs) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, dirs });
    } else if (entry.isDirectory) {
      const d = [...dirs, entry.name],
        reader = entry.createReader();
      let any = false,
        batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const c of batch) {
          any = true;
          await walk(c, d);
        }
      } while (batch.length);
      if (!any) out.push({ dirs: d }); // keep empty folders
    }
  };
  for (const e of entries) await walk(e, []);
  return out;
}

/* ---------- download ---------- */
async function fetchAndSave(file) {
  const { data: enc_blob, error } = await supabase.storage
    .from(BUCKET)
    .download(file.storage_path);
  if (error || !enc_blob) throw error || new Error("Download failed");
  let plain;
  try {
    plain = await decryptBytes(await enc_blob.arrayBuffer());
  } catch (e) {
    throw new Error(
      "Cannot decrypt this file (old file or different password).",
    );
  }
  const blob = new Blob([plain], {
    type: file.type || "application/octet-stream",
  });
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function downloadFile(file, button) {
  if (busy) return;
  button.disabled = true;
  button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
  try {
    await fetchAndSave(file);
    showStatus(uploadStatus, "Download complete.", true);
  } catch (err) {
    showStatus(uploadStatus, err.message || "Download failed.");
  } finally {
    button.disabled = false;
    button.innerHTML = '<i class="fa-solid fa-download"></i>';
  }
}
async function downloadAll() {
  if (busy || !currentFiles.length) return;
  const list = [...currentFiles];
  setBusy(true);
  let failed = 0;
  for (let i = 0; i < list.length; i++) {
    showStatus(uploadStatus, `Downloading ${i + 1} / ${list.length}…`, true);
    try {
      await fetchAndSave(list[i]);
    } catch (err) {
      failed++;
    }
    await sleep(500); // small gap so the browser accepts multiple downloads
  }
  setBusy(false);
  showStatus(
    uploadStatus,
    failed
      ? `Done. ${failed} file(s) failed.`
      : `All ${list.length} files downloaded.`,
    !failed,
  );
}

/* ---------- delete ---------- */
const chunk = (arr, n) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) =>
    arr.slice(i * n, i * n + n),
  );
// Storage objects are removed first; the database cascade then removes the rows.
async function removeFolderTree(folderId) {
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .rpc("folder_storage_paths", { root_id: folderId })
      .range(from, from + 999);
    if (error) throw error;
    for (const part of chunk(
      data.map((r) => r.storage_path),
      100,
    )) {
      const { error: e } = await supabase.storage.from(BUCKET).remove(part);
      if (e) throw e;
    }
    if (data.length < 1000) break;
  }
  const { error } = await supabase.from("folders").delete().eq("id", folderId);
  if (error) throw error;
}
async function deleteFolder(folder) {
  if (!confirm(`Delete folder "${folder.label}" and everything inside it?`))
    return;
  try {
    await removeFolderTree(folder.id);
  } catch (err) {
    showStatus(
      uploadStatus,
      "Delete failed: " + (err.message || "Unknown error"),
    );
  }
  await refreshFiles();
}
// Deletes everything in the folder you are viewing (files + sub-folders).
async function deleteAll() {
  if (busy || !(currentFiles.length || currentFolders.length)) return;
  const nF = currentFiles.length,
    nD = currentFolders.length;
  if (
    !confirm(
      `Delete ALL ${nF} files` +
        (nD ? ` and ${nD} folders (with everything inside)` : "") +
        ` here? This cannot be undone.`,
    )
  )
    return;
  const list = [...currentFiles],
    dirs = [...currentFolders];
  setBusy(true);
  try {
    for (const d of dirs) await removeFolderTree(d.id);
    for (const part of chunk(list, 100)) {
      const { error: se } = await supabase.storage
        .from(BUCKET)
        .remove(part.map((f) => f.storage_path));
      if (se) throw se;
      const { error: de } = await supabase
        .from("files")
        .delete()
        .in(
          "id",
          part.map((f) => f.id),
        );
      if (de) throw de;
    }
    showStatus(uploadStatus, "All items deleted.", true);
  } catch (err) {
    showStatus(
      uploadStatus,
      "Delete failed: " + (err.message || "Unknown error"),
    );
  } finally {
    setBusy(false);
    await refreshFiles();
  }
}

/* ---------- events ---------- */
$("downloadAllBtn").addEventListener("click", downloadAll);
$("deleteAllBtn").addEventListener("click", deleteAll);
$("switchMode").addEventListener("click", (e) => {
  e.preventDefault();
  setMode(mode === "register" ? "login" : "register");
});
if (inviteCode) {
  $("switchRow").classList.remove("hidden");
  setMode("register");
}
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearStatus(loginStatus);
  if (!configured) {
    showStatus(
      loginStatus,
      "Setup needed: add your Supabase URL and anon key in script.js, then run supabase/setup.sql.",
    );
    return;
  }
  const id = $("userId").value.trim(),
    password = $("password").value;
  if (!/^[a-zA-Z0-9._-]{3,64}$/.test(id)) {
    showStatus(
      loginStatus,
      "ID must be 3–64 characters: letters, numbers, dot, underscore or hyphen.",
    );
    return;
  }
  const registering = mode === "register";
  if (registering) {
    if (password.length < 8) {
      showStatus(loginStatus, "Password must be at least 8 characters.");
      return;
    }
    if (password !== $("password2").value) {
      showStatus(loginStatus, "Passwords do not match.");
      return;
    }
  }
  setBusy(true);
  try {
    cryptoKey = await deriveKey(id, password);
    let user;
    if (registering) {
      const { data, error } = await supabase.auth.signUp({
        email: idToEmail(id),
        password,
        options: { data: { invite_code: inviteCode } },
      });
      if (error) throw error;
      if (!data.session) throw new Error("NO_SESSION");
      user = data.user;
    } else {
      let data = null,
        lastErr = null;
      for (const d of LOGIN_DOMAINS) {
        const r = await supabase.auth.signInWithPassword({
          email: idToEmail(id, d),
          password,
        });
        if (!r.error) {
          data = r.data;
          break;
        }
        lastErr = r.error;
      }
      if (!data) throw lastErr;
      user = data.user;
    }
    await saveKey(user.id, cryptoKey);
    $("password").value = "";
    $("password2").value = "";
    if (registering) history.replaceState(null, "", location.pathname);
    renderSignedIn(user);
    await refreshFiles();
  } catch (err) {
    cryptoKey = null;
    let msg = "Login failed. Check your ID and password.";
    if (registering) {
      const m = String(err.message || "");
      if (err.code === "email_address_invalid")
        msg =
          "Supabase rejected the internal email domain. See README > Troubleshooting.";
      else if (/already|exists/i.test(m) || /exists/.test(err.code || ""))
        msg = "This ID is already taken. Choose another.";
      else if (m === "NO_SESSION")
        msg =
          "Account created, but auto sign-in is off. Turn off 'Confirm email' in Supabase, then sign in.";
      else
        msg =
          "Registration failed: invite link invalid, user limit reached, or ID taken.";
    }
    showStatus(loginStatus, msg);
  } finally {
    setBusy(false);
  }
});
$("logoutBtn").addEventListener("click", async () => {
  const uid = currentUserId;
  cryptoKey = null;
  if (uid) await dropKey(uid);
  await supabase.auth.signOut();
  renderSignedOut();
  clearStatus(uploadStatus);
});
$("fileInput").addEventListener("change", (e) =>
  uploadItems([...e.target.files].map((file) => ({ file, dirs: [] }))),
);
$("folderInput").addEventListener("change", (e) =>
  uploadItems(
    [...e.target.files].map((file) => ({
      file,
      dirs: (file.webkitRelativePath || "").split("/").slice(0, -1),
    })),
  ),
);
$("folderBtn").addEventListener("click", () => $("folderInput").click());
function syncSort() {
  $("sortBtn").innerHTML =
    `<i class="fa-solid ${sortAsc ? "fa-arrow-up-wide-short" : "fa-arrow-down-wide-short"}"></i> ${sortAsc ? "Oldest" : "Newest"}`;
}
$("sortBtn").addEventListener("click", () => {
  sortAsc = !sortAsc;
  syncSort();
  refreshFiles();
});
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(applyMarquee, 200);
});
document.fonts?.ready.then(applyMarquee);
const dz = $("dropZone");
["dragenter", "dragover"].forEach((t) =>
  dz.addEventListener(t, (e) => {
    e.preventDefault();
    dz.classList.add("drag");
  }),
);
["dragleave", "drop"].forEach((t) =>
  dz.addEventListener(t, (e) => {
    e.preventDefault();
    dz.classList.remove("drag");
  }),
);
dz.addEventListener("drop", (e) => {
  if (busy) return;
  collectDropped(e.dataTransfer).then(uploadItems);
});
if (!configured) {
  showStatus(
    loginStatus,
    "One-time setup required: configure Supabase in script.js and apply supabase/setup.sql.",
  );
} else {
  async function onSession(session) {
    if (!session) {
      renderSignedOut();
      return;
    }
    if (!cryptoKey) cryptoKey = await loadKey(session.user.id);
    if (!cryptoKey) {
      renderSignedOut();
      showStatus(loginStatus, "Please sign in again (encryption key missing).");
      setTimeout(() => supabase.auth.signOut(), 0);
      return;
    }
    renderSignedIn(session.user);
    await refreshFiles();
  }
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((event, session) => {
    setTimeout(() => onSession(session), 0);
  });
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session) await onSession(session);
  window.addEventListener("beforeunload", () => subscription.unsubscribe());
}
