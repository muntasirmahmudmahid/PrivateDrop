import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://xheahheaorzqeguuxitq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Y-DnJaKwHXhsJWz7BFXCwg_DW_qfR3q";
const BUCKET = "private-files";
const MAX_FILE_BYTES = 50 * 1024 * 1024 - 1024; // ~50 MB (encryption adds 28 bytes; bucket limit is 50 MB)
const configured =
  SUPABASE_URL.startsWith("https://") &&
  !SUPABASE_URL.includes("PASTE_") &&
  !SUPABASE_ANON_KEY.includes("PASTE_");
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
let currentFiles = [];

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
const saveKey = (uid, k) => idbOp("readwrite", (s) => s.put(k, uid)).catch(() => {});
const loadKey = (uid) => idbOp("readonly", (s) => s.get(uid)).catch(() => null);
const dropKey = (uid) => idbOp("readwrite", (s) => s.delete(uid)).catch(() => {});

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
  $("authTitle").textContent = reg ? "Create your account" : "As-salamu-alaykum";
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
  $("downloadAllBtn").disabled = v || !currentFiles.length;
  $("deleteAllBtn").disabled = v || !currentFiles.length;
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
  dashboard.classList.add("hidden");
  loginCard.classList.remove("hidden");
  $("fileList").innerHTML = '<div class="empty">Sign in to load files.</div>';
  $("fileCount").textContent = "0 files";
  $("downloadAllBtn").disabled = true;
  $("deleteAllBtn").disabled = true;
}
async function refreshFiles() {
  if (!supabase) return;
  const { data: raw, error } = await supabase
    .from("files")
    .select("id,original_name,size_bytes,created_at,storage_path")
    .order("created_at", { ascending: false });
  if (error) {
    currentFiles = [];
    $("downloadAllBtn").disabled = true;
    $("deleteAllBtn").disabled = true;
    $("fileList").innerHTML = "";
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "Could not load files: " + error.message;
    $("fileList").append(e);
    return;
  }
  const data = await Promise.all(
    raw.map(async (f) => {
      try {
        const m = await decryptMeta(f.original_name);
        return { ...f, name: m.name, size: m.size, type: m.type || "" };
      } catch (e) {
        return { ...f, name: "(old / unreadable file)", size: Number(f.size_bytes) || 0, type: "" };
      }
    }),
  );
  currentFiles = data;
  $("downloadAllBtn").disabled = busy || !data.length;
  $("deleteAllBtn").disabled = busy || !data.length;
  $("fileCount").textContent =
    `${data.length} ${data.length === 1 ? "file" : "files"}`;
  $("fileList").replaceChildren();
  if (!data.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No files yet. Upload one.";
    $("fileList").append(e);
    return;
  }
  for (const file of data) {
    const row = document.createElement("div");
    row.className = "file";
    const icon = document.createElement("div");
    icon.className = "fileicon";
    icon.textContent = "▤";
    const info = document.createElement("div");
    info.className = "fileinfo";
    const name = document.createElement("div");
    name.className = "filename";
    name.textContent = file.name;
    const size = document.createElement("div");
    size.className = "filesize";
    size.textContent =
      prettySize(file.size || 0) +
      " · " +
      new Date(file.created_at).toLocaleString();
    info.append(name, size);
    const btn = document.createElement("button");
    btn.className = "download";
    btn.innerHTML = '<i class="fa-solid fa-download"></i>';
    btn.addEventListener("click", () => downloadFile(file, btn));
    const del = document.createElement("button");
    del.className = "download";
    del.innerHTML = '<i class="fa-solid fa-trash"></i>';
    del.onclick = async () => {
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
    };
    row.append(icon, info, btn, del);
    $("fileList").append(row);
  }
}
async function uploadFiles(files) {
  if (!supabase || busy || !files.length) return;
  clearStatus(uploadStatus);
  const uid =
    currentUserId || (await supabase.auth.getUser()).data.user?.id;
  if (!uid) {
    showStatus(uploadStatus, "Please sign in again.");
    return;
  }
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      showStatus(uploadStatus, `${file.name}: over the 50 MB limit.`);
      continue;
    }
    setBusy(true);
    try {
      // Every user's files live inside their own folder: <user-id>/...
      const encrypted = await encryptBytes(await file.arrayBuffer());
      const meta = await encryptMeta({
        name: safeName(file.name),
        size: file.size,
        type: file.type || "",
      });
      const objectName = uid + "/" + crypto.randomUUID(); // no real name in storage
      const { data: stored, error: storageError } = await supabase.storage
        .from(BUCKET)
        .upload(objectName, new Blob([encrypted]), {
          upsert: false,
          contentType: "application/octet-stream",
        });
      if (storageError) throw storageError;
      const { error: dbError } = await supabase.from("files").insert({
        original_name: meta,
        size_bytes: encrypted.length,
        storage_path: stored.path,
        uploaded_by: uid,
      });
      if (dbError) {
        await supabase.storage.from(BUCKET).remove([stored.path]);
        throw dbError;
      }
      showStatus(uploadStatus, `Uploaded ${file.name}`, true);
    } catch (err) {
      showStatus(
        uploadStatus,
        `Upload failed: ${err.message || "Unknown error"}`,
      );
    } finally {
      setBusy(false);
    }
  }
  $("fileInput").value = "";
  await refreshFiles();
}
async function fetchAndSave(file) {
  const { data: enc_blob, error } = await supabase.storage
    .from(BUCKET)
    .download(file.storage_path);
  if (error || !enc_blob) throw error || new Error("Download failed");
  let plain;
  try {
    plain = await decryptBytes(await enc_blob.arrayBuffer());
  } catch (e) {
    throw new Error("Cannot decrypt this file (old file or different password).");
  }
  const blob = new Blob([plain], { type: file.type || "application/octet-stream" });
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
  button.textContent = "Preparing…";
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
async function deleteAll() {
  if (busy || !currentFiles.length) return;
  if (!confirm(`Delete ALL ${currentFiles.length} files? This cannot be undone.`))
    return;
  const list = [...currentFiles];
  setBusy(true);
  try {
    const { error: se } = await supabase.storage
      .from(BUCKET)
      .remove(list.map((f) => f.storage_path));
    if (se) throw se;
    const { error: de } = await supabase
      .from("files")
      .delete()
      .in(
        "id",
        list.map((f) => f.id),
      );
    if (de) throw de;
    showStatus(uploadStatus, "All files deleted.", true);
  } catch (err) {
    showStatus(uploadStatus, "Delete failed: " + (err.message || "Unknown error"));
  } finally {
    setBusy(false);
    await refreshFiles();
  }
}
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
        msg = "Supabase rejected the internal email domain. See README > Troubleshooting.";
      else if (/already|exists/i.test(m) || /exists/.test(err.code || ""))
        msg = "This ID is already taken. Choose another.";
      else if (m === "NO_SESSION")
        msg = "Account created, but auto sign-in is off. Turn off 'Confirm email' in Supabase, then sign in.";
      else
        msg = "Registration failed: invite link invalid, user limit reached, or ID taken.";
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
  uploadFiles([...e.target.files]),
);
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
dz.addEventListener("drop", (e) => uploadFiles([...e.dataTransfer.files]));
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
