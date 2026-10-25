import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://xheahheaorzqeguuxitq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Y-DnJaKwHXhsJWz7BFXCwg_DW_qfR3q";
const BUCKET = "private-files";
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per file; adjust only if your plan supports it.
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

function showStatus(el, message, ok = false) {
  el.textContent = message;
  el.className = "status show" + (ok ? " ok" : "");
}
function clearStatus(el) {
  el.textContent = "";
  el.className = "status";
}
function idToEmail(id) {
  return id.trim().toLowerCase() + "@privatedrop.invalid";
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
function setBusy(v) {
  busy = v;
  $("loginBtn").disabled = v;
  $("fileInput").disabled = v;
}
function renderSignedIn(user) {
  loginCard.classList.add("hidden");
  dashboard.classList.remove("hidden");
  $("userId").value = user?.email?.split("@")[0] || "";
}
function renderSignedOut() {
  dashboard.classList.add("hidden");
  loginCard.classList.remove("hidden");
  $("fileList").innerHTML = '<div class="empty">Sign in to load files.</div>';
  $("fileCount").textContent = "0 files";
}
async function refreshFiles() {
  if (!supabase) return;
  const { data, error } = await supabase
    .from("files")
    .select("id,original_name,size_bytes,created_at,storage_path")
    .order("created_at", { ascending: false });
  if (error) {
    $("fileList").innerHTML = "";
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "Could not load files: " + error.message;
    $("fileList").append(e);
    return;
  }
  $("fileCount").textContent =
    `${data.length} ${data.length === 1 ? "file" : "files"}`;
  $("fileList").replaceChildren();
  if (!data.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No files waiting. Upload one from another device.";
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
    name.textContent = file.original_name;
    const size = document.createElement("div");
    size.className = "filesize";
    size.textContent =
      prettySize(Number(file.size_bytes) || 0) +
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
      if (confirm("Delete this file?")) {
        await supabase.storage.from(BUCKET).remove([file.storage_path]);
        await supabase.from("files").delete().eq("id", file.id);
        await refreshFiles();
      }
    };
    row.append(icon, info, btn, del);
    $("fileList").append(row);
  }
}
async function uploadFiles(files) {
  if (!supabase || busy || !files.length) return;
  clearStatus(uploadStatus);
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      showStatus(uploadStatus, `${file.name}: over the 50 MB limit.`);
      continue;
    }
    setBusy(true);
    try {
      const objectName = crypto.randomUUID() + "-" + safeName(file.name);
      const { data: stored, error: storageError } = await supabase.storage
        .from(BUCKET)
        .upload(objectName, file, {
          upsert: false,
          contentType: file.type || "application/octet-stream",
        });
      if (storageError) throw storageError;
      const { error: dbError } = await supabase
        .from("files")
        .insert({
          original_name: file.name,
          size_bytes: file.size,
          storage_path: stored.path,
          uploaded_by: (await supabase.auth.getUser()).data.user.id,
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
async function downloadFile(file, button) {
  if (busy) return;
  button.disabled = true;
  button.textContent = "Preparing…";
  try {
    // First claim the file atomically. Other users cannot claim it at the same time.
    const { data: claim, error: claimError } = await supabase.rpc(
      "claim_file_for_download",
      { target_file_id: file.id },
    );
    if (claimError) throw claimError;
    if (!claim)
      throw new Error(
        "This file is already being downloaded or is no longer available. Refresh the list.",
      );
    const { data: blob, error: downloadError } = await supabase.storage
      .from(BUCKET)
      .download(file.storage_path);
    if (downloadError || !blob) {
      await supabase.rpc("release_file_claim", { target_file_id: file.id });
      throw downloadError || new Error("Download failed");
    }
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = file.original_name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    // Download only; no automatic deletion.
    await supabase.rpc("release_file_claim", {
      target_file_id: file.id,
    });
    showStatus(uploadStatus, "Download complete.", true);
    await refreshFiles();
  } catch (err) {
    showStatus(uploadStatus, err.message || "Download failed.");
    await refreshFiles();
  } finally {
    button.disabled = false;
    button.innerHTML = '<i class="fa-solid fa-download"></i>';
  }
}
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearStatus(loginStatus);
  if (!configured) {
    showStatus(
      loginStatus,
      "Setup needed: add your Supabase URL and anon key in index.html, then run the SQL setup in supabase/setup.sql.",
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
  setBusy(true);
  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: idToEmail(id),
      password,
    });
    if (error) throw error;
    $("password").value = "";
    renderSignedIn(data.user);
    await refreshFiles();
  } catch (err) {
    showStatus(loginStatus, "Login failed. Check your ID and password.");
  } finally {
    setBusy(false);
  }
});
$("logoutBtn").addEventListener("click", async () => {
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
    "One-time setup required: configure Supabase in index.html and apply supabase/setup.sql.",
  );
} else {
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((event, session) => {
    if (session) {
      renderSignedIn(session.user);
      setTimeout(() => refreshFiles(), 0);
    } else renderSignedOut();
  });
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session) {
    renderSignedIn(session.user);
    await refreshFiles();
  }
  window.addEventListener("beforeunload", () => subscription.unsubscribe());
}
