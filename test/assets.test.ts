import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssetStore, extensionFor, isAllowedMime, sanitizeFileName } from "../src/lib/assets.js";

async function tmpStore(): Promise<AssetStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cmm-assets-"));
  const store = new AssetStore(dir, "https://connector.example.com/");
  await store.init();
  return store;
}

test("save stores the file, a private sidecar, and returns a public URL", async () => {
  const store = await tmpStore();
  const asset = await store.save(Buffer.from("png-bytes"), { file_name: "Sujet Herbst.png", mime_type: "image/png", source: "upload-page" });
  assert.match(asset.id, /^[0-9a-f]{32}$/);
  assert.equal(asset.url, `https://connector.example.com/assets/${asset.id}.png`);
  assert.equal(asset.file_name, "Sujet Herbst.png");
  assert.equal(asset.size, 9);
  const bytes = await fs.readFile(path.join(store.dir, `${asset.id}.png`));
  assert.equal(bytes.toString(), "png-bytes");
  const sidecar = JSON.parse(await fs.readFile(path.join(store.metaDir, `${asset.id}.json`), "utf8"));
  assert.equal(sidecar.source, "upload-page");
});

test("only images and videos are accepted, never empty files", async () => {
  const store = await tmpStore();
  await assert.rejects(store.save(Buffer.from("x"), { mime_type: "application/pdf", source: "t" }), /Unsupported/);
  await assert.rejects(store.save(Buffer.alloc(0), { mime_type: "image/png", source: "t" }), /empty/);
});

test("list returns newest first and honours the limit", async () => {
  const store = await tmpStore();
  const a = await store.save(Buffer.from("1"), { file_name: "a.jpg", mime_type: "image/jpeg", source: "t" });
  await new Promise((r) => setTimeout(r, 5));
  const b = await store.save(Buffer.from("2"), { file_name: "b.mp4", mime_type: "video/mp4", source: "t" });
  const all = await store.list(10);
  assert.deepEqual(all.map((x) => x.id), [b.id, a.id]);
  assert.equal((await store.list(1)).length, 1);
});

test("extension comes from the mime type, then the file name, then bin", () => {
  assert.equal(extensionFor("image/jpeg", "whatever.txt"), "jpg");
  assert.equal(extensionFor("image/x-unknown", "photo.HEIF"), "heif");
  assert.equal(extensionFor("video/x-unknown"), "bin");
});

test("file names are stripped of paths and control characters", () => {
  assert.equal(sanitizeFileName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFileName("C:\\Users\\x\\bild\u0000.png"), "bild.png");
  assert.equal(sanitizeFileName(""), "upload");
  assert.equal(isAllowedMime("image/svg+xml"), true);
  assert.equal(isAllowedMime("text/html"), false);
});
