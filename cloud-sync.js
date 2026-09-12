/* বইয়ের পোকা Cloud — each reader stores their library in their own Google Drive. */
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const MANIFEST_NAME = "bookworms-library.json";
const FILE_PREFIX = "bookworms";
/* what the same files were called before the app was renamed; they are found
   under these names and renamed as they are next written, so a Drive library
   made by the old build carries straight over */
const OLD_MANIFEST_NAME = "pathok-v10-library.json";
const OLD_FILE_PREFIX = "pathok-v10";
const SCHEMA = "bookworms-drive-library";
const OLD_SCHEMA = "pathok-drive-library";
const DRIVE_REQUEST_TIMEOUT_MS = 45000;
const DRIVE_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

const state = {
  bridge: null,
  configured: false,
  gisReady: false,
  gisError: "",
  gisPromise: null,
  tokenClient: null,
  accessToken: "",
  tokenExpiresAt: 0,
  user: null,
  knownAccount: null,
  syncing: false,
  timer: null,
  lastSyncAt: 0,
  lastError: null,
  resyncRequested: false,
  accountMismatch: false
};

const PROFILE_KEYS = new Set(["settings", "stats", "shelves", "words", "view", "sort"]);
const el = id => document.getElementById(id);
const clean = value => JSON.parse(JSON.stringify(value, (_key, item) => item === undefined ? null : item));

function config() {
  return window.BOOKWORMS_CLOUD_CONFIG || {};
}

function isConfigured() {
  return Boolean(config().enabled && /\.apps\.googleusercontent\.com$/.test(config().googleClientId || ""));
}

function hasToken() {
  return Boolean(state.accessToken && Date.now() < state.tokenExpiresAt);
}

function setStatus(label, detail, kind = "idle") {
  if (el("cloudStatus")) el("cloudStatus").textContent = label;
  if (el("cloudDetail")) el("cloudDetail").textContent = detail || "";
  if (el("cloudPanel")) el("cloudPanel").dataset.state = kind;
}

function updateUI() {
  const account = el("cloudAccount");
  const connect = el("cloudSignIn");
  const sync = el("cloudSyncNow");
  const disconnect = el("cloudSignOut");
  if (!account || !connect || !sync || !disconnect) return;

  connect.textContent = state.knownAccount ? "Reconnect Google Drive" : "Connect Google Drive";
  disconnect.textContent = "Disconnect";

  if (!state.configured) {
    account.textContent = "Google Drive sync needs a client ID";
    connect.style.display = "none";
    sync.style.display = "none";
    disconnect.style.display = "none";
    setStatus("Local only", "Add your Google OAuth client ID in cloud-config.js to enable sync.", "setup");
    return;
  }

  if (state.accountMismatch) {
    account.textContent = "This device belongs to a different বইয়ের পোকা account";
    connect.style.display = "none";
    sync.style.display = "none";
    disconnect.style.display = "inline-flex";
    setStatus("Account protected", "Disconnect. Export or clear this local library before connecting another Google account.", "error");
    return;
  }

  if (!hasToken()) {
    const known = state.knownAccount?.displayName || state.knownAccount?.emailAddress;
    account.textContent = known ? `Last connected: ${known}` : "Store this library in your own Google Drive";
    connect.style.display = state.gisReady || state.gisError ? "inline-flex" : "none";
    sync.style.display = "none";
    disconnect.style.display = "none";
    if (state.lastError) setStatus(state.lastError.label, state.lastError.message, "error");
    else if (!navigator.onLine) setStatus("Offline", "Local reading works now; connect when you are online.", "idle");
    else if (state.gisError) setStatus("Google sign-in unavailable", state.gisError, "error");
    else if (!state.gisReady) setStatus("Preparing Drive…", "Loading Google's secure account chooser.", "busy");
    else setStatus("Not connected", "বইয়ের পোকা requests access only to its hidden app-data folder.", "idle");
    return;
  }

  account.textContent = state.user?.displayName || state.user?.emailAddress || "Google Drive connected";
  connect.style.display = "none";
  sync.style.display = "inline-flex";
  disconnect.style.display = "inline-flex";
  if (!state.syncing && state.lastError) {
    setStatus(state.lastError.label, state.lastError.message, "error");
  } else if (!state.syncing) {
    const detail = state.lastSyncAt
      ? `Updated ${new Date(state.lastSyncAt).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})}`
      : (state.user?.emailAddress || "Private Drive storage enabled");
    setStatus(state.lastSyncAt ? "Synced" : "Drive connected", detail, "ready");
  }
}

function cloudError(error, label = "Sync paused") {
  console.error("Drive:", error);
  const message = !navigator.onLine
    ? "You are offline. Local reading is unaffected."
    : (error?.message || "Please try again.").replace(/^Google Drive:\s*/i, "");
  state.lastError = {label, message};
  setStatus(label, message, "error");
}

async function loadGoogleIdentity() {
  if (window.google?.accounts?.oauth2) {
    state.gisReady = true;
  } else if (!state.gisPromise) {
    state.gisPromise = new Promise((resolve, reject) => {
      let script = document.getElementById("bookworms-google-identity");
      const done = () => window.google?.accounts?.oauth2 ? resolve() : reject(new Error("Google Identity did not load"));
      if (!script) {
        script = document.createElement("script");
        script.id = "bookworms-google-identity";
        script.src = "https://accounts.google.com/gsi/client";
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
      script.addEventListener("load", done, {once: true});
      script.addEventListener("error", () => reject(new Error("Could not load Google Identity Services")), {once: true});
    });
  }
  try {
    if (!state.gisReady) await state.gisPromise;
    state.gisReady = true;
    state.gisError = "";
    if (!state.tokenClient) {
      state.tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: config().googleClientId,
        scope: DRIVE_SCOPE,
        callback: () => {}
      });
    }
  } catch (error) {
    state.gisError = error?.message || "Could not load Google Identity Services";
    state.gisPromise = null;
    throw error;
  } finally {
    updateUI();
  }
}

function clearToken() {
  state.accessToken = "";
  state.tokenExpiresAt = 0;
  state.user = null;
}

async function authorizedFetch(url, options = {}) {
  if (!hasToken()) {
    clearToken();
    updateUI();
    throw new Error("Your Google session expired. Tap Reconnect Google Drive.");
  }
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${state.accessToken}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DRIVE_REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {...options, headers, signal: controller.signal});
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Google Drive did not respond within 45 seconds. Check your connection, then tap Sync now.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === 401) {
    clearToken();
    updateUI();
    throw new Error("Your Google session expired. Tap Reconnect Google Drive.");
  }
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = body?.error?.message || "";
    } catch (_error) {}
    throw new Error(detail || `Google Drive request failed (${response.status})`);
  }
  return response;
}

async function driveAbout() {
  const fields = encodeURIComponent("user(displayName,emailAddress,permissionId,photoLink),storageQuota(limit,usage)");
  const response = await authorizedFetch(`${DRIVE_API}/about?fields=${fields}`);
  return response.json();
}

async function connect() {
  if (!state.gisReady || !state.tokenClient) {
    setStatus("Preparing Drive…", "Please tap Connect again when the button returns.", "busy");
    try { await loadGoogleIdentity(); }
    catch (error) { cloudError(error, "Google sign-in unavailable"); }
    return;
  }

  setStatus("Connecting…", "Choose the Google account that owns this library.", "busy");
  state.lastError = null;
  try {
    const token = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = fn => value => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      state.tokenClient.callback = finish(response => {
        if (response?.error) reject(new Error(response.error_description || response.error));
        else resolve(response);
      });
      state.tokenClient.error_callback = finish(error => reject(new Error(error?.message || error?.type || "Google sign-in was closed")));
      state.tokenClient.requestAccessToken({prompt: "select_account"});
    });
    if (!window.google.accounts.oauth2.hasGrantedAllScopes(token, DRIVE_SCOPE)) {
      throw new Error("Drive app-data permission was not granted");
    }
    state.accessToken = token.access_token;
    state.tokenExpiresAt = Date.now() + Math.max(60, Number(token.expires_in) || 3600) * 1000 - 60000;

    const about = await driveAbout();
    const user = about.user || {};
    if (!user.permissionId) throw new Error("Google Drive did not return an account identifier");
    state.user = user;
    state.accountMismatch = false;

    const meta = await state.bridge.getCloudMeta() || {};
    const snapshot = await state.bridge.snapshot();
    if (meta.ownerDriveId && meta.ownerDriveId !== user.permissionId && snapshot.books.length) {
      state.accountMismatch = true;
      updateUI();
      return;
    }
    const nextMeta = meta.ownerDriveId && meta.ownerDriveId !== user.permissionId
      ? {ownerDriveId: user.permissionId, pendingDeletes: {}}
      : {...meta, ownerDriveId: user.permissionId};
    nextMeta.driveAccount = clean({
      displayName: user.displayName || "",
      emailAddress: user.emailAddress || "",
      permissionId: user.permissionId
    });
    state.knownAccount = nextMeta.driveAccount;
    await state.bridge.setCloudMeta(nextMeta);
    updateUI();
    await syncNow({uploadBooks: true}).catch(() => {});
  } catch (error) {
    clearToken();
    cloudError(error, "Connection failed");
    updateUI();
  }
}

async function disconnect() {
  const token = state.accessToken;
  clearToken();
  state.accountMismatch = false;
  state.lastError = null;
  updateUI();
  if (token && window.google?.accounts?.oauth2) {
    try { window.google.accounts.oauth2.revoke(token, () => {}); }
    catch (_error) {}
  }
}

function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)].map(n => n.toString(16).padStart(2, "0")).join("");
}

async function cloudIdFor(book) {
  if (book.cloudId) return book.cloudId;
  const identity = `${book.key || ""}\n${book.title || ""}\n${book.author || ""}`.normalize("NFKC").toLowerCase();
  if (window.crypto?.subtle) {
    const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
    return bytesToHex(digest).slice(0, 40);
  }
  let hash = 2166136261;
  for (let i = 0; i < identity.length; i++) hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619);
  return `book-${(hash >>> 0).toString(16)}`;
}

function toCloudBook(book, cloudId) {
  return clean({
    cloudId,
    kind: book.kind || "epub",
    key: book.key || "",
    title: book.title || "Untitled",
    author: book.author || "",
    series: book.series || "",
    seriesIndex: book.seriesIndex || "",
    tags: book.tags || "",
    fileName: book.fileName || `${book.title || "book"}.epub`,
    addedAt: Number(book.addedAt) || Date.now(),
    lastOpened: Number(book.lastOpened) || 0,
    modifiedAt: Number(book.modifiedAt) || Number(book.lastOpened) || Number(book.addedAt) || Date.now(),
    pct: Number(book.pct) || 0,
    pos: book.pos || {ch: 0, frac: 0},
    size: Number(book.size) || 0,
    bookmarks: book.bookmarks || [],
    hl: book.hl || [],
    readMs: Number(book.readMs) || 0,
    finished: Boolean(book.finished),
    favorite: Boolean(book.favorite),
    shelves: book.shelves || [],
    ovOn: Boolean(book.ovOn),
    ov: book.ov || null,
    coverModifiedAt: Number(book.coverModifiedAt) || 0,
    maxCh: Number.isFinite(book.maxCh) ? book.maxCh : null
  });
}

function profilePayload(snapshot, modifiedAt) {
  return clean({
    settings: snapshot.settings,
    stats: snapshot.stats,
    shelves: snapshot.shelves,
    words: snapshot.words,
    sortMode: snapshot.sortMode,
    viewMode: snapshot.viewMode,
    modifiedAt
  });
}

const bookFileName = cloudId => `${FILE_PREFIX}-book-${cloudId}.bin`;
const coverFileName = cloudId => `${FILE_PREFIX}-cover-${cloudId}.txt`;

async function listAppFiles() {
  const files = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      spaces: "appDataFolder",
      q: "trashed = false",
      pageSize: "1000",
      fields: "nextPageToken,files(id,name,size,modifiedTime,mimeType,appProperties)"
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await authorizedFetch(`${DRIVE_API}/files?${params}`);
    const page = await response.json();
    files.push(...(page.files || []));
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  return files;
}

function indexFiles(files) {
  const byName = new Map();
  const byId = new Map();
  files.forEach(file => {
    byId.set(file.id, file);
    const prior = byName.get(file.name);
    if (!prior || String(file.modifiedTime || "") > String(prior.modifiedTime || "")) byName.set(file.name, file);
  });
  /* let a lookup by the current name find a file still carrying the old one */
  files.forEach(file => {
    const name = String(file.name || "");
    let now = "";
    if (name === OLD_MANIFEST_NAME) now = MANIFEST_NAME;
    else if (name.startsWith(OLD_FILE_PREFIX + "-")) now = FILE_PREFIX + name.slice(OLD_FILE_PREFIX.length);
    if (now && !byName.has(now)) byName.set(now, file);
  });
  return {byName, byId};
}

async function downloadDriveFile(id) {
  if (!id) throw new Error("The Drive file is missing");
  return authorizedFetch(`${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media`);
}

async function uploadSession(sessionUrl, blob, onProgress) {
  if (!hasToken()) throw new Error("Your Google session expired. Tap Reconnect Google Drive.");
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", sessionUrl);
    xhr.timeout = DRIVE_UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader("Authorization", `Bearer ${state.accessToken}`);
    xhr.setRequestHeader("Content-Type", blob.type || "application/octet-stream");
    xhr.upload.onprogress = event => {
      if (event.lengthComputable && onProgress) onProgress(Math.round(event.loaded / event.total * 100));
    };
    xhr.onerror = () => reject(new Error("The Drive upload was interrupted"));
    xhr.ontimeout = () => reject(new Error("The Drive upload timed out. Check your connection, then tap Sync now."));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText || "{}")); }
        catch (_error) { resolve({}); }
        return;
      }
      let message = `Drive upload failed (${xhr.status})`;
      try { message = JSON.parse(xhr.responseText)?.error?.message || message; }
      catch (_error) {}
      reject(new Error(message));
    };
    xhr.send(blob);
  });
}

async function uploadDriveFile({existingId, name, data, contentType, appProperties, onProgress}) {
  const blob = data instanceof Blob ? data : new Blob([data], {type: contentType});
  const method = existingId ? "PATCH" : "POST";
  const path = existingId ? `/files/${encodeURIComponent(existingId)}` : "/files";
  const metadata = clean({
    name,
    mimeType: contentType,
    appProperties: appProperties || {},
    ...(existingId ? {} : {parents: ["appDataFolder"]})
  });
  const response = await authorizedFetch(`${DRIVE_UPLOAD_API}${path}?uploadType=resumable&fields=id,name,size,modifiedTime,mimeType,appProperties`, {
    method,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": contentType,
      "X-Upload-Content-Length": String(blob.size)
    },
    body: JSON.stringify(metadata)
  });
  const sessionUrl = response.headers.get("Location");
  if (!sessionUrl) throw new Error("Google Drive did not start the upload session");
  return uploadSession(sessionUrl, blob, onProgress);
}

async function deleteDriveFile(id) {
  if (!id) return;
  try { await authorizedFetch(`${DRIVE_API}/files/${encodeURIComponent(id)}`, {method: "DELETE"}); }
  catch (error) {
    if (!/\(404\)|not found/i.test(error?.message || "")) throw error;
  }
}

function newManifest() {
  return {schema: SCHEMA, version: 10, updatedAt: 0, profile: null, books: {}, deletedBooks: {}};
}

async function readManifest(index) {
  const file = index.byName.get(MANIFEST_NAME);
  if (!file) return {file: null, manifest: newManifest()};
  try {
    const response = await downloadDriveFile(file.id);
    const manifest = await response.json();
    if ((manifest?.schema !== SCHEMA && manifest?.schema !== OLD_SCHEMA) || !manifest.books) throw new Error("Unsupported manifest");
    return {file, manifest: {...newManifest(), ...manifest, schema: SCHEMA, books: manifest.books || {}, deletedBooks: manifest.deletedBooks || {}}};
  } catch (error) {
    throw new Error(`Your Drive index could not be read: ${error.message}`);
  }
}

async function uploadManifest(file, manifest) {
  const data = JSON.stringify({...manifest, updatedAt: Date.now()});
  return uploadDriveFile({
    existingId: file?.id,
    name: MANIFEST_NAME,
    data,
    contentType: "application/json",
    appProperties: {bookwormsType: "manifest", bookwormsVersion: "10"}
  });
}

async function processPendingDeletes(meta, manifest, index) {
  const raw = meta.pendingDeletes || {};
  const pending = Array.isArray(raw) ? raw.map(id => [id, Date.now()]) : Object.entries(raw);
  const remaining = {};
  for (const [cloudId, queuedAtValue] of pending) {
    const queuedAt = Number(queuedAtValue) || Date.now();
    const remote = manifest.books[cloudId] || {};
    const ids = new Set([
      remote.driveFileId,
      remote.driveCoverId,
      index.byName.get(bookFileName(cloudId))?.id,
      index.byName.get(coverFileName(cloudId))?.id
    ].filter(Boolean));
    try {
      for (const id of ids) await deleteDriveFile(id);
      delete manifest.books[cloudId];
      manifest.deletedBooks[cloudId] = Math.max(Number(manifest.deletedBooks[cloudId]) || 0, queuedAt);
    } catch (error) {
      remaining[cloudId] = queuedAt;
      console.warn("Drive deletion is still queued:", error);
    }
  }
  const updated = {...meta, pendingDeletes: remaining};
  await state.bridge.setCloudMeta(updated);
  return updated;
}

async function uploadBook(book, cloudId, remote, index) {
  const result = {...(remote || {})};
  if (book.cloudOnly) return result;
  const namedFile = index.byName.get(bookFileName(cloudId));
  const currentFile = namedFile || index.byId.get(result.driveFileId);
  const expectedSize = Number(book.size || result.fileSize || 0);
  const needsFile = !currentFile || !expectedSize || Number(currentFile.size || 0) !== expectedSize;
  if (needsFile) {
    const bytes = await state.bridge.getBookBytes(book.id);
    if (!bytes) return result;
    setStatus("Backing up books…", `${book.title} · 0%`, "busy");
    const contentType = book.kind === "epub" ? "application/epub+zip" : "application/octet-stream";
    const uploaded = await uploadDriveFile({
      existingId: currentFile?.id,
      name: bookFileName(cloudId),
      data: new Blob([bytes], {type: contentType}),
      contentType,
      appProperties: {bookwormsType: "book", bookwormsCloudId: cloudId},
      onProgress: pct => setStatus("Backing up books…", `${book.title} · ${pct}%`, "busy")
    });
    result.driveFileId = uploaded.id || currentFile?.id || "";
    result.fileSize = bytes.length;
    result.fileUploaded = true;
  } else {
    result.driveFileId = currentFile.id;
    result.fileSize = Number(currentFile.size || expectedSize);
    result.fileUploaded = true;
  }

  const cover = await state.bridge.getCover(book.id);
  const namedCover = index.byName.get(coverFileName(cloudId));
  const currentCover = namedCover || index.byId.get(result.driveCoverId);
  const needsCover = Boolean(cover) && (!currentCover || Number(book.coverModifiedAt || 0) > Number(result.coverModifiedAt || 0));
  if (needsCover) {
    const uploaded = await uploadDriveFile({
      existingId: currentCover?.id,
      name: coverFileName(cloudId),
      data: cover,
      contentType: "text/plain;charset=utf-8",
      appProperties: {bookwormsType: "cover", bookwormsCloudId: cloudId}
    });
    result.driveCoverId = uploaded.id || currentCover?.id || "";
    result.coverModifiedAt = Number(book.coverModifiedAt || book.addedAt || Date.now());
  } else if (currentCover) {
    result.driveCoverId = currentCover.id;
  }
  return result;
}

async function persistForSync() {
  const previous = Boolean(window.__bookwormsApplyingCloud);
  window.__bookwormsApplyingCloud = true;
  try {
    await state.bridge.persist();
  } finally {
    window.__bookwormsApplyingCloud = previous;
  }
}

async function syncNow({uploadBooks = true} = {}) {
  if (!hasToken() || state.accountMismatch || !state.bridge || state.syncing) return;
  if (!navigator.onLine) {
    setStatus("Waiting for internet", "Your changes are saved locally and will sync later.", "idle");
    return;
  }

  state.syncing = true;
  state.lastError = null;
  updateUI();
  setStatus("Syncing…", "Saving your latest reading progress…", "busy");
  try {
    await persistForSync();
    let local = await state.bridge.snapshot();
    let meta = await state.bridge.getCloudMeta() || {};
    setStatus("Syncing…", "Reading your private Google Drive index…", "busy");
    const index = indexFiles(await listAppFiles());
    const manifestResult = await readManifest(index);
    const manifest = manifestResult.manifest;
    meta = await processPendingDeletes(meta, manifest, index);
    setStatus("Syncing…", `Comparing ${local.books.length} book${local.books.length === 1 ? "" : "s"}…`, "busy");

    const remoteProfileAt = Number(manifest.profile?.modifiedAt) || 0;
    let localProfileAt = Number(meta.profileModifiedAt) || Number(meta.lastProfileSyncAt) || 0;
    if (manifest.profile && remoteProfileAt > localProfileAt) {
      await state.bridge.applyProfile(manifest.profile);
      local = await state.bridge.snapshot();
      localProfileAt = remoteProfileAt;
    } else {
      localProfileAt = localProfileAt || Date.now();
      manifest.profile = profilePayload(local, localProfileAt);
    }

    const seen = new Set();
    for (let bookIndex = 0; bookIndex < local.books.length; bookIndex++) {
      const book = local.books[bookIndex];
      setStatus("Syncing…", `Checking book ${bookIndex + 1} of ${local.books.length}: ${book.title}`, "busy");
      const cloudId = await cloudIdFor(book);
      if (!book.cloudId) await state.bridge.assignCloudId(book.id, cloudId);
      const localAt = Number(book.modifiedAt) || Number(book.lastOpened) || Number(book.addedAt) || 0;
      const deletedAt = Number(manifest.deletedBooks[cloudId]) || 0;
      if (deletedAt && deletedAt >= localAt) {
        await state.bridge.removeCloudBook(cloudId);
        delete manifest.books[cloudId];
        continue;
      }
      if (deletedAt && localAt > deletedAt) delete manifest.deletedBooks[cloudId];
      seen.add(cloudId);
      const remote = manifest.books[cloudId];
      const remoteAt = Number(remote?.modifiedAt) || 0;
      let current = book;
      let record;

      if (remote && remoteAt > localAt) {
        current = await state.bridge.applyRemoteBook(remote) || book;
        record = {...remote};
      } else {
        record = {...(remote || {}), ...toCloudBook(book, cloudId)};
      }
      if (uploadBooks && !current.cloudOnly) {
        record = {...record, ...await uploadBook(current, cloudId, record, index)};
      }
      manifest.books[cloudId] = clean(record);
    }

    const pending = new Set(Array.isArray(meta.pendingDeletes) ? meta.pendingDeletes : Object.keys(meta.pendingDeletes || {}));
    for (const [cloudId, remote] of Object.entries(manifest.books)) {
      const deletedAt = Number(manifest.deletedBooks[cloudId]) || 0;
      if (deletedAt >= (Number(remote.modifiedAt) || 0)) {
        delete manifest.books[cloudId];
        continue;
      }
      if (!seen.has(cloudId) && !pending.has(cloudId)) await state.bridge.addCloudBook(remote);
    }

    setStatus("Syncing…", "Saving the updated Drive index…", "busy");
    await uploadManifest(manifestResult.file, manifest);
    const now = Date.now();
    await state.bridge.setCloudMeta({
      ...meta,
      ownerDriveId: state.user.permissionId,
      driveAccount: clean({
        displayName: state.user.displayName || "",
        emailAddress: state.user.emailAddress || "",
        permissionId: state.user.permissionId
      }),
      profileModifiedAt: Math.max(localProfileAt, remoteProfileAt),
      lastProfileSyncAt: now,
      lastSuccessfulSyncAt: now
    });
    state.lastSyncAt = now;
  } catch (error) {
    cloudError(error);
    throw error;
  } finally {
    state.syncing = false;
    updateUI();
    if (state.resyncRequested && hasToken()) {
      state.resyncRequested = false;
      clearTimeout(state.timer);
      state.timer = setTimeout(() => syncNow({uploadBooks: true}).catch(() => {}), 1000);
    }
  }
}

async function resolveRemoteBook(book) {
  const cloudId = book.cloudId || await cloudIdFor(book);
  if (book.driveFileId) return {...book, cloudId};
  const index = indexFiles(await listAppFiles());
  const {manifest} = await readManifest(index);
  const remote = manifest.books[cloudId] || {};
  return {
    ...book,
    ...remote,
    cloudId,
    driveFileId: remote.driveFileId || index.byName.get(bookFileName(cloudId))?.id || "",
    driveCoverId: remote.driveCoverId || index.byName.get(coverFileName(cloudId))?.id || ""
  };
}

async function ensureBookAvailable(book) {
  if (!book?.cloudOnly) return true;
  if (!hasToken() || state.accountMismatch) {
    setStatus("Reconnect required", "Connect Google Drive to download this book.", "error");
    return false;
  }
  try {
    const remote = await resolveRemoteBook(book);
    if (!remote.driveFileId) throw new Error("This book file is not present in Google Drive");
    setStatus("Downloading book…", book.title, "busy");
    const response = await downloadDriveFile(remote.driveFileId);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let cover = null;
    if (remote.driveCoverId) {
      try { cover = await (await downloadDriveFile(remote.driveCoverId)).text(); }
      catch (_error) {}
    }
    Object.assign(book, {driveFileId: remote.driveFileId, driveCoverId: remote.driveCoverId || ""});
    await state.bridge.installCloudFile(book.id, bytes, cover);
    setStatus("Book downloaded", "Available offline on this device.", "ready");
    return true;
  } catch (error) {
    cloudError(error, "Download failed");
    return false;
  }
}

async function removeBook(book) {
  if (!book || !state.bridge) return;
  const cloudId = book.cloudId || await cloudIdFor(book);
  const meta = await state.bridge.getCloudMeta() || {};
  const raw = meta.pendingDeletes || {};
  const pendingDeletes = Array.isArray(raw)
    ? Object.fromEntries(raw.map(id => [id, Date.now()]))
    : {...raw};
  pendingDeletes[cloudId] = Date.now();
  await state.bridge.setCloudMeta({...meta, pendingDeletes});
}

function queueSync(detail = {}) {
  if (!hasToken() || window.__bookwormsApplyingCloud) return;
  if (state.syncing) {
    state.resyncRequested = true;
    return;
  }
  clearTimeout(state.timer);
  state.timer = setTimeout(() => syncNow({uploadBooks: detail.key === "lib"}).catch(() => {}), detail.urgent ? 250 : 15000);
}

function bindUI() {
  el("cloudSignIn")?.addEventListener("click", connect);
  el("cloudSignOut")?.addEventListener("click", disconnect);
  el("cloudSyncNow")?.addEventListener("click", () => syncNow({uploadBooks: true}).catch(() => {}));
  window.addEventListener("online", () => {
    if (state.configured && !state.gisReady) loadGoogleIdentity().catch(error => cloudError(error, "Google sign-in unavailable"));
    else queueSync({urgent: true});
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") queueSync({urgent: true});
  });
  document.addEventListener("bookworms:change", async event => {
    if (window.__bookwormsApplyingCloud) return;
    const detail = event.detail || {};
    if (PROFILE_KEYS.has(detail.key) && state.bridge) {
      const meta = await state.bridge.getCloudMeta() || {};
      await state.bridge.setCloudMeta({...meta, profileModifiedAt: Date.now()});
    }
    queueSync(detail);
  });
}

async function mount(bridge) {
  state.bridge = bridge;
  state.configured = isConfigured();
  const meta = await bridge.getCloudMeta() || {};
  state.knownAccount = meta.driveAccount || null;
  state.lastSyncAt = Number(meta.lastSuccessfulSyncAt) || 0;
  bindUI();
  updateUI();
  if (state.configured && navigator.onLine) {
    loadGoogleIdentity().catch(error => {
      cloudError(error, "Google sign-in unavailable");
      updateUI();
    });
  }
}

/* Deletes everything this app holds in the Drive app-data folder, in one pass.
   Deliberately does NOT run a sync afterwards: a sync would upload the still-present
   local library straight back, and would leave manifest entries pointing at files
   that no longer exist. The caller signs out and clears local cloud links. */
async function wipeAll() {
  if (!state.bridge) throw new Error("Sync is not connected");
  if (!hasToken()) throw new Error("Connect Google Drive first, then erase.");
  if (state.syncing) throw new Error("A sync is running — wait for it to finish, then erase.");
  state.syncing = true;                 /* blocks queueSync while we delete */
  setStatus("Erasing…", "Removing every file this app stores in your Drive…", "busy");
  try {
  const files = await listAppFiles();
  let removed = 0;
  const failed = [];
  for (const file of files) {
    try { await deleteDriveFile(file.id); removed++; }
    catch (error) { failed.push(file.name || file.id); }
  }
  const meta = (await state.bridge.getCloudMeta()) || {};
  await state.bridge.setCloudMeta({
    ownerDriveId: meta.ownerDriveId || null,
    pendingDeletes: {},
    manifestId: null,
    lastSyncAt: 0
  });
  state.lastSyncAt = 0;
  if (failed.length) throw new Error(failed.length + " file(s) could not be deleted — try again once online");
  return removed;
  } finally {
    state.syncing = false;
    state.resyncRequested = false;      /* never re-upload what we just erased */
  }
}

/* ============ importing books the reader already keeps in Drive ============
   This is a different permission from the hidden app-data folder the library
   syncs into: Google's picker hands back only the files the reader taps, and
   the app can read nothing else in the Drive. */
const PICK_SCOPE = "https://www.googleapis.com/auth/drive.file";
const BOOK_MIME = [
  "application/epub+zip", "application/x-fictionbook+xml", "application/zip",
  "application/x-cbz", "text/plain", "text/html"
].join(",");
const pickState = {token: "", expiresAt: 0, client: null, apiPromise: null};

function loadPickerApi() {
  if (window.google?.picker) return Promise.resolve();
  if (!pickState.apiPromise) {
    pickState.apiPromise = new Promise((resolve, reject) => {
      let script = document.getElementById("bookworms-gapi");
      const start = () => {
        if (!window.gapi?.load) { reject(new Error("Google's picker did not load")); return; }
        window.gapi.load("picker", {
          callback: () => window.google?.picker ? resolve() : reject(new Error("Google's picker did not load")),
          onerror: () => reject(new Error("Google's picker did not load"))
        });
      };
      if (!script) {
        script = document.createElement("script");
        script.id = "bookworms-gapi";
        script.src = "https://apis.google.com/js/api.js";
        script.async = true;
        document.head.appendChild(script);
      }
      script.addEventListener("load", start, {once: true});
      script.addEventListener("error", () => reject(new Error("Could not reach Google")), {once: true});
      if (window.gapi?.load) start();
    }).catch(error => { pickState.apiPromise = null; throw error; });
  }
  return pickState.apiPromise;
}

async function pickToken() {
  if (pickState.token && Date.now() < pickState.expiresAt) return pickState.token;
  await loadGoogleIdentity();
  if (!pickState.client) {
    pickState.client = window.google.accounts.oauth2.initTokenClient({
      client_id: config().googleClientId,
      scope: PICK_SCOPE,
      callback: () => {}
    });
  }
  const token = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = fn => value => { if (!settled) { settled = true; fn(value); } };
    pickState.client.callback = finish(response => {
      if (response?.error) reject(new Error(response.error_description || response.error));
      else resolve(response);
    });
    pickState.client.error_callback = finish(error => reject(new Error(error?.message || error?.type || "Google sign-in was closed")));
    pickState.client.requestAccessToken({prompt: ""});
  });
  if (!window.google.accounts.oauth2.hasGrantedAllScopes(token, PICK_SCOPE)) {
    throw new Error("Permission to open your Drive files was not granted");
  }
  pickState.token = token.access_token;
  pickState.expiresAt = Date.now() + Math.max(60, Number(token.expires_in) || 3600) * 1000 - 60000;
  return pickState.token;
}

/* the project number is the part of the client ID before the dash */
function appId() {
  return String(config().googleAppId || config().googleClientId || "").split("-")[0];
}

async function downloadPicked(doc, token, onProgress) {
  const response = await fetch(
    `${DRIVE_API}/files/${encodeURIComponent(doc.id)}?alt=media&supportsAllDrives=true`,
    {headers: {Authorization: `Bearer ${token}`}}
  );
  if (!response.ok) throw new Error(`${doc.name || "File"} could not be downloaded (${response.status})`);
  const blob = await response.blob();
  onProgress?.();
  return new File([blob], doc.name || "book.epub", {type: blob.type || "application/octet-stream"});
}

async function pickFromDrive() {
  const cfg = config();
  if (!cfg.enabled || !cfg.googleClientId) throw new Error("Google Drive is not set up in this build");
  if (!cfg.googleApiKey) throw new Error("Add googleApiKey to cloud-config.js to import from Drive");
  if (!navigator.onLine) throw new Error("You are offline — Drive import needs a connection");
  const app = window.BookwormsApp;
  const toast = message => app?.toast?.(message);

  toast("Opening your Drive…");
  const [token] = await Promise.all([pickToken(), loadPickerApi()]);

  const docs = await new Promise((resolve, reject) => {
    try {
      const view = new window.google.picker.DocsView(window.google.picker.ViewId.DOCS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(false)
        .setMimeTypes(BOOK_MIME);
      const picker = new window.google.picker.PickerBuilder()
        .setOAuthToken(token)
        .setDeveloperKey(cfg.googleApiKey)
        .setAppId(appId())
        .setTitle("Choose books")
        .enableFeature(window.google.picker.Feature.MULTISELECT_ENABLED)
        .addView(view)
        .addView(new window.google.picker.DocsView(window.google.picker.ViewId.DOCS)
          .setIncludeFolders(true).setOwnedByMe(true).setMimeTypes(BOOK_MIME).setLabel("My Drive"))
        .setCallback(data => {
          const action = data[window.google.picker.Response.ACTION];
          if (action === window.google.picker.Action.PICKED) resolve(data[window.google.picker.Response.DOCUMENTS] || []);
          else if (action === window.google.picker.Action.CANCEL) resolve([]);
        })
        .build();
      picker.setVisible(true);
    } catch (error) { reject(error); }
  });

  if (!docs.length) return 0;
  const files = [];
  const failed = [];
  let done = 0;
  for (const doc of docs) {
    toast(`Downloading ${done + 1}/${docs.length} — ${doc.name || "book"}`);
    try { files.push(await downloadPicked(doc, token, () => { done++; })); }
    catch (error) { failed.push(doc.name || doc.id); }
  }
  if (failed.length) toast(`${failed.length} file(s) could not be downloaded`);
  if (files.length) await app?.importFiles?.(files);
  return files.length;
}

window.BookwormsCloud = Object.freeze({mount, syncNow, ensureBookAvailable, removeBook, wipeAll, disconnect, pickFromDrive});

if (window.BookwormsApp?.ready) mount(window.BookwormsApp);
else document.addEventListener("bookworms:ready", event => mount(event.detail || window.BookwormsApp), {once: true});
