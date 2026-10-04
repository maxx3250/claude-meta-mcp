/**
 * Upload page + asset serving.
 *
 *   GET  /upload        small HTML page: drag & drop images / videos
 *   PUT  /upload        raw body upload (Content-Type = file type, X-File-Name)
 *   GET  /upload/list   recent uploads as JSON (used by the page)
 *   GET  /assets/<id>.<ext>   public, immutable, read-only
 *
 * Authentication is deliberately NOT done here: the connector only knows a
 * Bearer secret for /mcp, while the human at the upload page already has a
 * login at the reverse proxy / OAuth shim. So the proxy must protect /upload
 * (nginx `auth_basic`, see docs/DEPLOYMENT.md) and the connector refuses
 * upload requests that do not arrive over the loopback interface — i.e. did
 * not pass through that local proxy.
 */

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { AssetStore, isAllowedMime, sanitizeFileName } from "./lib/assets.js";

export interface UploadPageOptions {
  maxMb: number;
  lang: "en" | "de";
  publicUrl: string;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function loopbackOnly(req: Request, res: Response, next: NextFunction): void {
  const addr = req.socket.remoteAddress ?? "";
  if (!LOOPBACK.has(addr)) {
    res.status(403).json({
      error: "forbidden",
      message:
        "Upload endpoints are only served through the local reverse proxy, which must authenticate the user " +
        "(see docs/DEPLOYMENT.md). Direct access is refused.",
    });
    return;
  }
  next();
}

const STRINGS = {
  en: {
    title: "Upload images & videos",
    intro: "Drop files here or click to choose. Each file gets a private link you can hand to Claude or ChatGPT.",
    choose: "Choose files",
    hint: "Then say, for example:",
    example: (url: string) => `Upload the image ${url} to the ad library`,
    exampleIg: (url: string) => `Post the image ${url} on Instagram with the caption …`,
    recent: "Recent uploads",
    copy: "Copy link",
    copied: "Copied",
    none: "Nothing uploaded yet.",
    tooLarge: (mb: number) => `File is larger than ${mb} MB`,
    failed: "Upload failed",
    uploading: "Uploading…",
    onlyMedia: "Only images and videos are accepted.",
    tip: "Tip: once uploaded, you can also just say “use the image I just uploaded” — the assistant can list recent uploads itself.",
  },
  de: {
    title: "Bilder & Videos hochladen",
    intro: "Dateien hierher ziehen oder auswählen. Jede Datei bekommt einen privaten Link, den du Claude oder ChatGPT geben kannst.",
    choose: "Dateien auswählen",
    hint: "Dann zum Beispiel sagen:",
    example: (url: string) => `Lade das Bild ${url} in die Werbebibliothek`,
    exampleIg: (url: string) => `Veröffentliche das Bild ${url} auf Instagram mit dem Text …`,
    recent: "Zuletzt hochgeladen",
    copy: "Link kopieren",
    copied: "Kopiert",
    none: "Noch nichts hochgeladen.",
    tooLarge: (mb: number) => `Datei ist größer als ${mb} MB`,
    failed: "Upload fehlgeschlagen",
    uploading: "Lädt hoch…",
    onlyMedia: "Es werden nur Bilder und Videos angenommen.",
    tip: "Tipp: Nach dem Hochladen reicht auch „nimm das Bild, das ich gerade hochgeladen habe“ — der Assistent kann die letzten Uploads selbst auflisten.",
  },
} as const;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export function renderUploadPage(opts: UploadPageOptions): string {
  const t = STRINGS[opts.lang] ?? STRINGS.en;
  // Strings that the page script needs, serialized once.
  const js = JSON.stringify({
    maxMb: opts.maxMb,
    copy: t.copy,
    copied: t.copied,
    none: t.none,
    tooLarge: t.tooLarge(opts.maxMb),
    failed: t.failed,
    uploading: t.uploading,
    onlyMedia: t.onlyMedia,
    hint: t.hint,
    example: t.example("URL"),
    exampleIg: t.exampleIg("URL"),
  });
  return `<!doctype html>
<html lang="${opts.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(t.title)} · claude-meta-mcp</title>
<style>
  :root { color-scheme: light dark; --fg:#1a1a1a; --bg:#fafafa; --muted:#666; --line:#d8d8d8; --accent:#1b5e9e; --ok:#2e7d32; --err:#b3261e; --card:#fff; }
  @media (prefers-color-scheme: dark) { :root { --fg:#ececec; --bg:#121212; --muted:#a0a0a0; --line:#333; --accent:#7fb3ea; --ok:#7bd389; --err:#ff8a80; --card:#1c1c1c; } }
  * { box-sizing: border-box; }
  body { margin:0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color:var(--fg); background:var(--bg); }
  main { max-width: 720px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  p.intro { color: var(--muted); margin: 0 0 1.25rem; }
  .drop { display: block; border: 2px dashed var(--line); border-radius: 12px; padding: 36px 20px; text-align:center; background: var(--card); cursor: pointer; transition: border-color .15s, background .15s; }
  .drop.over { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, var(--card)); }
  .drop input { display:none; }
  .drop button { font: inherit; padding: 10px 18px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; }
  ul.list { list-style: none; padding: 0; margin: 1.5rem 0 0; display: grid; gap: 10px; }
  li.item { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; display: grid; grid-template-columns: 56px 1fr; gap: 12px; align-items: center; }
  li.item img, li.item .thumb { width: 56px; height: 56px; object-fit: cover; border-radius: 6px; background: var(--line); display:flex; align-items:center; justify-content:center; font-size: .75rem; color: var(--muted); }
  .name { font-weight: 600; word-break: break-all; }
  .meta { color: var(--muted); font-size: .85rem; }
  .url { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; word-break: break-all; }
  .row { display:flex; gap: 8px; flex-wrap: wrap; align-items:center; margin-top: 6px; }
  .row button { font: inherit; font-size: .85rem; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; }
  .status { font-size: .85rem; }
  .status.ok { color: var(--ok); } .status.err { color: var(--err); }
  h2 { font-size: 1.05rem; margin: 2rem 0 .5rem; }
  .tip { color: var(--muted); font-size: .9rem; margin-top: 1.5rem; }
  .say { background: color-mix(in srgb, var(--accent) 10%, var(--card)); border-radius: 8px; padding: 8px 10px; margin-top: 8px; font-size: .9rem; }
  .say code { font-family: inherit; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(t.title)}</h1>
  <p class="intro">${escapeHtml(t.intro)}</p>
  <label class="drop" id="drop">
    <input type="file" id="file" multiple accept="image/*,video/*">
    <button type="button" id="choose">${escapeHtml(t.choose)}</button>
  </label>
  <ul class="list" id="results"></ul>
  <h2>${escapeHtml(t.recent)}</h2>
  <ul class="list" id="recent"></ul>
  <p class="tip">${escapeHtml(t.tip)}</p>
</main>
<script>
(function () {
  var S = ${js};
  var drop = document.getElementById('drop'), input = document.getElementById('file');
  var results = document.getElementById('results'), recent = document.getElementById('recent');
  document.getElementById('choose').addEventListener('click', function (e) { e.preventDefault(); input.click(); });
  ['dragenter','dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave','drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
  drop.addEventListener('drop', function (e) { handle(e.dataTransfer.files); });
  input.addEventListener('change', function () { handle(input.files); input.value = ''; });

  function fmt(bytes) { return bytes > 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB'; }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  function render(asset, status, into, prepend) {
    var li = el('li', 'item');
    var thumb = /^image\\//.test(asset.mime_type || '') && asset.url ? el('img') : el('div', 'thumb', (asset.mime_type || '').split('/')[0] || 'file');
    if (thumb.tagName === 'IMG') { thumb.src = asset.url; thumb.alt = ''; thumb.loading = 'lazy'; }
    var body = el('div');
    body.appendChild(el('div', 'name', asset.file_name || ''));
    body.appendChild(el('div', 'meta', [asset.mime_type, asset.size ? fmt(asset.size) : null, asset.uploaded_at ? new Date(asset.uploaded_at).toLocaleString() : null].filter(Boolean).join(' · ')));
    if (asset.url) {
      body.appendChild(el('div', 'url', asset.url));
      var row = el('div', 'row');
      var btn = el('button', null, S.copy);
      btn.addEventListener('click', function () { navigator.clipboard.writeText(asset.url).then(function () { btn.textContent = S.copied; setTimeout(function () { btn.textContent = S.copy; }, 1500); }); });
      row.appendChild(btn);
      body.appendChild(row);
      if (prepend) {
        var say = el('div', 'say');
        say.appendChild(el('div', null, S.hint));
        say.appendChild(el('code', null, S.example.replace('URL', asset.url)));
        body.appendChild(say);
      }
    }
    if (status) body.appendChild(el('div', 'status ' + status.cls, status.text));
    li.appendChild(thumb); li.appendChild(body);
    if (prepend && into.firstChild) into.insertBefore(li, into.firstChild); else into.appendChild(li);
    return { li: li, body: body };
  }

  function handle(files) {
    Array.prototype.forEach.call(files, function (file) {
      if (!/^(image|video)\\//.test(file.type)) { render({ file_name: file.name, mime_type: file.type, size: file.size }, { cls: 'err', text: S.onlyMedia }, results, true); return; }
      if (file.size > S.maxMb * 1048576) { render({ file_name: file.name, mime_type: file.type, size: file.size }, { cls: 'err', text: S.tooLarge }, results, true); return; }
      var pending = render({ file_name: file.name, mime_type: file.type, size: file.size }, { cls: '', text: S.uploading }, results, true);
      fetch('/upload', { method: 'PUT', headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) }, body: file })
        .then(function (r) { return r.ok ? r.json() : r.text().then(function (t) { throw new Error(t || r.status); }); })
        .then(function (asset) { results.removeChild(pending.li); render(asset, { cls: 'ok', text: '✓' }, results, true); })
        .catch(function (err) { pending.body.lastChild.className = 'status err'; pending.body.lastChild.textContent = S.failed + ': ' + err.message; });
    });
  }

  fetch('/upload/list').then(function (r) { return r.json(); }).then(function (d) {
    if (!d.assets || !d.assets.length) { recent.appendChild(el('li', 'meta', S.none)); return; }
    d.assets.forEach(function (a) { render(a, null, recent, false); });
  }).catch(function () {});
})();
</script>
</body>
</html>`;
}

export function registerUploadRoutes(app: Express, store: AssetStore, opts: UploadPageOptions): void {
  app.get("/upload", loopbackOnly, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(renderUploadPage(opts));
  });

  app.get("/upload/list", loopbackOnly, async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ assets: await store.list(50) });
  });

  app.put(
    "/upload",
    loopbackOnly,
    express.raw({ type: () => true, limit: `${opts.maxMb}mb` }),
    async (req: Request, res: Response) => {
      const mime = (req.header("content-type") ?? "application/octet-stream").split(";")[0].trim();
      let name = "upload";
      try {
        name = sanitizeFileName(decodeURIComponent(req.header("x-file-name") ?? "upload"));
      } catch {
        name = sanitizeFileName(req.header("x-file-name"));
      }
      if (!isAllowedMime(mime)) {
        res.status(415).json({ error: "unsupported_type", message: `Only images and videos are accepted (got ${mime})` });
        return;
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: "empty_body", message: "Send the file bytes as the request body" });
        return;
      }
      const asset = await store.save(req.body, { file_name: name, mime_type: mime, source: "upload-page" });
      res.status(201).json(asset);
    },
    // body-parser errors (413 etc.) for this route only
    (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const status = typeof (err as { status?: number }).status === "number" ? (err as { status: number }).status : 400;
      res.status(status).json({
        error: status === 413 ? "too_large" : "bad_request",
        message: status === 413 ? `File exceeds the ${opts.maxMb} MB limit (UPLOAD_MAX_MB)` : String((err as Error).message ?? err),
      });
    }
  );

  // Public, immutable asset serving. dotfiles:"deny" keeps /.meta sidecars private.
  app.use(
    "/assets",
    express.static(store.dir, {
      index: false,
      dotfiles: "deny",
      maxAge: "7d",
      immutable: true,
      etag: true,
      setHeaders: (res) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Disposition", "inline");
      },
    })
  );
}
