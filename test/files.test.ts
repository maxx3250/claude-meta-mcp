import { test } from "node:test";
import assert from "node:assert/strict";
import { chatgptFileSchema, FILE_PARAMS_META } from "../src/lib/files.js";

test("ChatGPT file objects need download_url and file_id, the rest is optional", () => {
  assert.ok(chatgptFileSchema.safeParse({ download_url: "https://files.example/x", file_id: "file_1" }).success);
  assert.ok(
    chatgptFileSchema.safeParse({ download_url: "https://files.example/x", file_id: "file_1", mime_type: "image/png", file_name: "a.png" }).success
  );
  assert.equal(chatgptFileSchema.safeParse({ download_url: "https://files.example/x" }).success, false);
  assert.equal(chatgptFileSchema.safeParse({ file_id: "file_1" }).success, false);
  assert.equal(chatgptFileSchema.safeParse({ download_url: "not a url", file_id: "f" }).success, false);
});

test("tool meta points ChatGPT at the `file` field", () => {
  assert.deepEqual(FILE_PARAMS_META, { "openai/fileParams": ["file"] });
});
