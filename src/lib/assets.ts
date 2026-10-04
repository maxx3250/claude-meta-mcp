/**
 * Local asset store: files uploaded through the /upload page or handed over
 * by ChatGPT (openai/fileParams) are kept on disk under UPLOAD_DIR and served
 * read-only at PUBLIC_URL/assets/<random-id>.<ext>.
 *
 * Why a store at all? Meta fetches Instagram media from a public URL, and no
 * chat client can hand raw bytes to an MCP tool — so every inbound file gets
 * a stable, unguessable URL first. Ids are 128-bit random, so the URL itself
 * is the secret; sidecar metadata lives in a dot-directory the static server
 * refuses to serve.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface StoredAsset {
  id: string;
  url: string;
  file_name: string;
  mime_type: string;
  size: number;
  uploaded_at: string;
  source: string;
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-m4v": "m4v",
};

export function isAllowedMime(mime: string): boolean {
  return /^(image|video)\/[\w.+-]+$/i.test(mime);
}

export function sanitizeFileName(name: string | undefined, fallback = "upload"): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|]/g, "").trim();
  return (cleaned || fallback).slice(0, 120);
}

export function extensionFor(mime: string, fileName?: string): string {
  const byMime = MIME_EXT[mime.toLowerCase()];
  if (byMime) return byMime;
  const fromName = /\.([a-z0-9]{1,5})$/i.exec(fileName ?? "")?.[1]?.toLowerCase();
  if (fromName) return fromName;
  return "bin";
}

export class AssetStore {
  readonly dir: string;
  private readonly publicUrl: string;

  constructor(dir: string, publicUrl: string) {
    this.dir = path.resolve(dir);
    this.publicUrl = publicUrl.replace(/\/+$/, "");
  }

  get metaDir(): string {
    return path.join(this.dir, ".meta");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.metaDir, { recursive: true });
  }

  urlFor(storedName: string): string {
    return `${this.publicUrl}/assets/${storedName}`;
  }

  async save(
    bytes: Buffer,
    info: { file_name?: string; mime_type: string; source: string }
  ): Promise<StoredAsset> {
    const mime = info.mime_type.split(";")[0].trim().toLowerCase();
    if (!isAllowedMime(mime)) {
      throw new Error(`Unsupported file type "${mime}" — only images and videos can be stored`);
    }
    if (bytes.length === 0) throw new Error("Refusing to store an empty file");
    const id = randomBytes(16).toString("hex");
    const fileName = sanitizeFileName(info.file_name);
    const storedName = `${id}.${extensionFor(mime, fileName)}`;
    const asset: StoredAsset = {
      id,
      url: this.urlFor(storedName),
      file_name: fileName,
      mime_type: mime,
      size: bytes.length,
      uploaded_at: new Date().toISOString(),
      source: info.source,
    };
    await fs.writeFile(path.join(this.dir, storedName), bytes, { mode: 0o644 });
    await fs.writeFile(path.join(this.metaDir, `${id}.json`), JSON.stringify(asset), { mode: 0o600 });
    return asset;
  }

  async list(limit = 20): Promise<StoredAsset[]> {
    let names: string[] = [];
    try {
      names = (await fs.readdir(this.metaDir)).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const assets: StoredAsset[] = [];
    for (const name of names) {
      try {
        assets.push(JSON.parse(await fs.readFile(path.join(this.metaDir, name), "utf8")) as StoredAsset);
      } catch {
        // skip unreadable sidecar
      }
    }
    assets.sort((a, b) => (a.uploaded_at < b.uploaded_at ? 1 : a.uploaded_at > b.uploaded_at ? -1 : 0));
    return assets.slice(0, Math.max(1, limit));
  }
}
