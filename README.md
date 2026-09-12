# বইয়ের পোকা — Bookworms V11

An offline reader for EPUB, TXT, FB2, CBZ and HTML, with an optional private library in your own Google Drive.

An offline reader for EPUB, TXT, FB2, CBZ and HTML. Everything works with the network off; Drive sync is optional and only carries what you connect it to.

## Files

Nine files, all at the root of the repository:

```
index.html                 the app
cloud-config.js            your Google OAuth client ID
cloud-sync.js              the Drive sync module (ES module)
sw.js                      offline shell
manifest.webmanifest       install metadata
icon-180.png  icon-192.png  icon-512.png  icon-maskable-512.png
```

`cloud-config.js` and `cloud-sync.js` are V10's, unchanged. If you edit either later, only those files need re-uploading.

## Hosting

1. New repository, upload all nine files to the root.
2. Settings → Pages → Deploy from a branch → `main`, folder `/ (root)`.
3. Open the URL on the phone → **Add to Home screen**.

**Your existing OAuth client already works.** Authorised origins are per-origin, not per-path, so anything under `https://YOURNAME.github.io` is covered by the client ID V10 already uses. No Google Cloud changes needed.

## Google Drive sync

**More → Settings**, at the top. Connect once and the app keeps your library in the hidden app-data folder of your own Drive — a folder only this app can see, using the non-sensitive `drive.appdata` scope. Nothing goes to anyone else's server.

Synced: books, covers, reading positions, bookmarks and highlights, shelves, word list, stats and settings.

Books already in Drive but not yet on this device appear on the shelf with a ☁ badge. Tapping one downloads it, then opens it.

**Removing books.** Deleting a book on the shelf also removes it from Drive on the next sync, and records the deletion so your other devices drop it too — without that, the next sync would simply download it back.

**Erase from Drive** appears in the sync panel while you're connected. It lists the app's Drive folder and deletes every file in it — books, covers, the manifest — then disconnects. It deliberately does not run a sync, because a sync would upload your local library straight back.

Afterwards, books that existed only in Drive are dropped from the shelf (they have no file on this device, so they would only open to an error), and the remaining books forget their Drive links so a later reconnect starts clean. The books stored on this device are kept. To clear those too, use Select → Select all → Remove.

The Drive format matches V10's, so a device still running V10 and one running V11 can share the same library.

## The shelf

One row of labelled buttons beside the wordmark: **Add**, **Sort**, **Select**, **More**. Search sits on its own line with the search-inside-books button.

- **Sort** — recently read, title, author or file size; grid or list; sections on or off.
- **Select** — tap covers to pick, Select all, then Remove.
- **More** — Settings, reading stats, bookmarks and highlights, word list.

Sorting by title or author breaks the shelf into sticky sections, one per letter or author. Bengali, Arabic and Latin each keep their own alphabet.

## Themes

**App theme** (Settings, top): Dark, Light, Royal, Blossom — the shelf and menus.

**Page theme** (Colours & accent): Light, Paper, Sepia, Mint, Grey, Forest, Royal, Night, Ink, plus a custom page colour.

The two are independent. Every combination passes a contrast check before it is applied, so text stays readable whatever you pick — including a custom page colour.

## Where your data lives

In this browser's storage for this address, plus your own Drive if you connect it. Clearing site data erases the local copy; if sync is connected, reconnecting restores it. **Back up everything** in Settings also writes a JSON file you can keep.

## Updating

Upload a new `index.html` and reload once. The service worker fetches the page from the network when there's a connection and keeps the cached copy only as the offline fallback.
