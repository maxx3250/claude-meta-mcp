/**
 * Asset store tools — lets a model find files the user uploaded through the
 * /upload page (or that arrived as ChatGPT attachments) without guessing URLs.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AssetStore } from "./lib/assets.js";

function asJson(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function registerAssetTools(server: McpServer, store: AssetStore | undefined): void {
  server.registerTool(
    "list_assets",
    {
      description:
        "List files the user uploaded to this connector's upload page (or attached in ChatGPT), newest first, " +
        "with their public URLs. Use a URL as `source.url` for upload_ad_image / upload_ad_video or as " +
        "image_url / video_url for Instagram posts. When the user says 'the image I just uploaded', call this. Read-only.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("How many recent files (default 20)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ limit }) => {
      if (!store) {
        throw new Error(
          "The asset store is not configured on this connector (set UPLOAD_DIR). " +
            "Ask the operator to enable the upload page, or pass a public image URL instead."
        );
      }
      const assets = await store.list(limit ?? 20);
      return asJson({ count: assets.length, assets });
    }
  );
}
