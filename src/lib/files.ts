/**
 * ChatGPT file hand-over (Apps SDK `openai/fileParams`).
 *
 * A tool lists its file-typed input fields under `_meta["openai/fileParams"]`.
 * ChatGPT then offers a file picker / takes the chat attachment and calls the
 * tool with a file object: `download_url` (temporary signed URL) and `file_id`
 * always, `mime_type` and `file_name` sometimes. The server downloads the
 * bytes itself — the model never has to serialize an image as text.
 *
 * Other MCP clients (Claude, …) simply see an optional object parameter.
 */

import { z } from "zod";
import type { MetaClient } from "../meta-client.js";
import type { AssetStore, StoredAsset } from "./assets.js";

export const chatgptFileSchema = z
  .object({
    download_url: z.string().url().describe("Temporary download URL supplied by ChatGPT"),
    file_id: z.string().describe("ChatGPT file id"),
    mime_type: z.string().optional(),
    file_name: z.string().optional(),
  })
  .describe(
    "A file attached in ChatGPT. ChatGPT fills this in when the user attaches or picks a file — " +
      "do not construct it by hand. Other clients: use `source` / a public URL instead."
  );

export type ChatGptFile = z.infer<typeof chatgptFileSchema>;

/** Tool descriptor meta that tells ChatGPT which input field carries a file. */
export const FILE_PARAMS_META = { "openai/fileParams": ["file"] } as const;

export async function downloadChatGptFile(
  meta: MetaClient,
  file: ChatGptFile,
  defaults: { mime: string; filename: string }
): Promise<Blob> {
  return meta.fetchAsBlob({
    url: file.download_url,
    mime: file.mime_type ?? defaults.mime,
    filename: file.file_name ?? defaults.filename,
  });
}

export async function storeBlob(
  store: AssetStore,
  blob: Blob,
  info: { file_name?: string; mime_type?: string; source: string }
): Promise<StoredAsset> {
  const bytes = Buffer.from(await blob.arrayBuffer());
  return store.save(bytes, {
    file_name: info.file_name ?? (blob as { name?: string }).name,
    mime_type: info.mime_type ?? blob.type ?? "application/octet-stream",
    source: info.source,
  });
}

export interface AssetSource {
  url?: string;
  data_base64?: string;
  mime?: string;
  filename?: string;
}

/**
 * Turn whatever the client handed us — a public URL, base64, or a ChatGPT
 * file — into a Blob for Meta, and keep a copy in the asset store when the
 * bytes did not already come from a stable public URL.
 */
export async function resolveMedia(
  meta: MetaClient,
  store: AssetStore | undefined,
  input: { source?: AssetSource; file?: ChatGptFile },
  defaults: { mime: string; filename: string }
): Promise<{ blob: Blob; asset?: StoredAsset }> {
  if (input.file && input.source) throw new Error("Provide either `source` or `file`, not both");
  if (input.file) {
    const blob = await downloadChatGptFile(meta, input.file, defaults);
    const asset = store
      ? await storeBlob(store, blob, {
          file_name: input.file.file_name ?? defaults.filename,
          mime_type: input.file.mime_type ?? blob.type ?? defaults.mime,
          source: "chatgpt-file",
        })
      : undefined;
    return { blob, asset };
  }
  if (input.source) {
    const blob = await meta.fetchAsBlob({
      ...input.source,
      mime: input.source.mime ?? defaults.mime,
      filename: input.source.filename ?? defaults.filename,
    });
    const asset =
      store && input.source.data_base64
        ? await storeBlob(store, blob, {
            file_name: input.source.filename ?? defaults.filename,
            mime_type: input.source.mime ?? defaults.mime,
            source: "base64",
          })
        : undefined;
    return { blob, asset };
  }
  throw new Error(
    "No media given. Pass `source` (public URL or base64), attach a file (ChatGPT), or upload it on the " +
      "connector's /upload page and pick it via list_assets."
  );
}
