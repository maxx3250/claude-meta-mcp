/**
 * Tool registry for the Meta connector.
 *
 * Each tool wraps a small slice of the Graph API and returns the response
 * as JSON text content. Ads tools are read-only. Pages tools include two
 * write operations (create_page_post, delete_page_post) which mutate the
 * connected Facebook Page.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MetaClient } from "./meta-client.js";

const dateRangeSchema = z
  .object({
    since: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "ISO date YYYY-MM-DD")
      .describe("Start date (inclusive), format YYYY-MM-DD"),
    until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "ISO date YYYY-MM-DD")
      .describe("End date (inclusive), format YYYY-MM-DD"),
  })
  .describe("Custom date range for insights");

const datePresetSchema = z
  .enum([
    "today",
    "yesterday",
    "this_month",
    "last_month",
    "this_quarter",
    "last_quarter",
    "this_year",
    "last_year",
    "last_3d",
    "last_7d",
    "last_14d",
    "last_28d",
    "last_30d",
    "last_90d",
  ])
  .describe("Preset date range; mutually exclusive with time_range");

const insightLevelSchema = z
  .enum(["account", "campaign", "adset", "ad"])
  .describe("Aggregation level for the insights query");

const DEFAULT_INSIGHT_FIELDS = [
  "impressions",
  "clicks",
  "spend",
  "ctr",
  "cpc",
  "cpm",
  "reach",
  "frequency",
  "actions",
  "action_values",
];

function asJson(value: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function normalizeAdAccountId(id: string): string {
  // Meta IDs for ad accounts must start with "act_". Tolerate either form.
  return id.startsWith("act_") ? id : `act_${id}`;
}

export function registerTools(server: McpServer, meta: MetaClient): void {
  // ---------------------------------------------------------------- Accounts
  server.registerTool(
    "list_ad_accounts",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description:
        "List all Meta ad accounts the authenticated user has access to. Returns id, name, currency, account status and timezone.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max accounts per page (default 25)"),
      },
    },
    async ({ limit }) => {
      const data = await meta.get<{ data: unknown[] }>("/me/adaccounts", {
        fields:
          "id,name,account_id,account_status,currency,timezone_name,business_name",
        limit: limit ?? 25,
      });
      return asJson(data);
    }
  );

  server.registerTool(
    "get_ad_account",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description:
        "Fetch details for a single Meta ad account including spend cap, balance, and amount spent today.",
      inputSchema: {
        account_id: z
          .string()
          .describe("Ad account ID, with or without 'act_' prefix"),
        fields: z
          .string()
          .optional()
          .describe(
            "Comma-separated fields to retrieve (default: a useful summary)"
          ),
      },
    },
    async ({ account_id, fields }) => {
      const data = await meta.get(`/${normalizeAdAccountId(account_id)}`, {
        fields:
          fields ??
          "id,name,account_id,account_status,currency,timezone_name,business_name,balance,amount_spent,spend_cap,disable_reason",
      });
      return asJson(data);
    }
  );

  // ------------------------------------------------------------------ Campaigns
  server.registerTool(
    "list_campaigns",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description:
        "List campaigns inside an ad account. Read-only — does not modify any campaign.",
      inputSchema: {
        account_id: z
          .string()
          .describe("Ad account ID, with or without 'act_' prefix"),
        status: z
          .enum(["ACTIVE", "PAUSED", "DELETED", "ARCHIVED"])
          .optional()
          .describe("Filter by effective status"),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ account_id, status, limit }) => {
      const params: Record<string, string | number> = {
        fields:
          "id,name,objective,status,effective_status,buying_type,daily_budget,lifetime_budget,start_time,stop_time,created_time,updated_time",
        limit: limit ?? 25,
      };
      if (status) {
        params.effective_status = JSON.stringify([status]);
      }
      const data = await meta.get(
        `/${normalizeAdAccountId(account_id)}/campaigns`,
        params
      );
      return asJson(data);
    }
  );

  server.registerTool(
    "get_campaign",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: "Fetch a single campaign by ID with its full configuration.",
      inputSchema: {
        campaign_id: z.string().describe("Campaign ID"),
      },
    },
    async ({ campaign_id }) => {
      const data = await meta.get(`/${campaign_id}`, {
        fields:
          "id,name,objective,status,effective_status,buying_type,daily_budget,lifetime_budget,bid_strategy,special_ad_categories,start_time,stop_time,created_time,updated_time",
      });
      return asJson(data);
    }
  );

  // ------------------------------------------------------------------ Ad Sets
  server.registerTool(
    "list_adsets",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: "List ad sets inside a campaign or an ad account.",
      inputSchema: {
        parent_id: z
          .string()
          .describe(
            "Campaign ID or ad account ID (act_…) to list ad sets under"
          ),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ parent_id, limit }) => {
      const path = parent_id.startsWith("act_")
        ? `/${parent_id}/adsets`
        : `/${parent_id}/adsets`;
      const data = await meta.get(path, {
        fields:
          "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,billing_event,optimization_goal,bid_strategy,start_time,end_time,targeting",
        limit: limit ?? 25,
      });
      return asJson(data);
    }
  );

  // -------------------------------------------------------------------- Ads
  server.registerTool(
    "list_ads",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: "List ads inside a campaign, ad set, or ad account.",
      inputSchema: {
        parent_id: z
          .string()
          .describe("Ad account (act_…), campaign or ad set ID"),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ parent_id, limit }) => {
      const data = await meta.get(`/${parent_id}/ads`, {
        fields:
          "id,name,status,effective_status,adset_id,campaign_id,creative,created_time,updated_time",
        limit: limit ?? 25,
      });
      return asJson(data);
    }
  );

  // -------------------------------------------------------------- Insights
  server.registerTool(
    "get_insights",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description:
        "Performance metrics (impressions, clicks, spend, CTR, CPC, CPM, conversions). Works at account, campaign, ad set, or ad level. Provide either a date_preset OR a time_range.",
      inputSchema: {
        object_id: z
          .string()
          .describe(
            "ID of the object to query: ad account (act_…), campaign, ad set, or ad ID"
          ),
        level: insightLevelSchema.describe(
          "Aggregation level for the response rows"
        ),
        date_preset: datePresetSchema.optional(),
        time_range: dateRangeSchema.optional(),
        fields: z
          .array(z.string())
          .optional()
          .describe(
            "Insights fields to retrieve. Defaults to a useful set including impressions, clicks, spend, CTR, CPC, CPM, reach, frequency, actions."
          ),
        breakdowns: z
          .string()
          .optional()
          .describe(
            "Comma-separated breakdowns, e.g. 'age,gender' or 'country' or 'publisher_platform'"
          ),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({
      object_id,
      level,
      date_preset,
      time_range,
      fields,
      breakdowns,
      limit,
    }) => {
      if (date_preset && time_range) {
        throw new Error(
          "Provide either date_preset OR time_range, not both."
        );
      }
      const params: Record<string, string | number> = {
        level,
        fields: (fields ?? DEFAULT_INSIGHT_FIELDS).join(","),
        limit: limit ?? 100,
      };
      if (date_preset) params.date_preset = date_preset;
      if (time_range) params.time_range = JSON.stringify(time_range);
      if (breakdowns) params.breakdowns = breakdowns;

      const path = object_id.startsWith("act_")
        ? `/${object_id}/insights`
        : `/${object_id}/insights`;

      const data = await meta.get(path, params);
      return asJson(data);
    }
  );

  // ------------------------------------------------------------- Pages
  server.registerTool(
    "list_pages",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description:
        "List Facebook Pages the authenticated System User manages. Returns id, name, category, fan_count, and link.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ limit }) => {
      const data = await meta.get("/me/accounts", {
        fields:
          "id,name,category,category_list,fan_count,followers_count,link,about,verification_status",
        limit: limit ?? 25,
      });
      return asJson(data);
    }
  );

  server.registerTool(
    "list_page_posts",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description:
        "List recent posts on a Facebook Page (newest first). Read-only.",
      inputSchema: {
        page_id: z.string().describe("Facebook Page ID"),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ page_id, limit }) => {
      const pageToken = await meta.getPageAccessToken(page_id);
      const data = await meta.get(`/${page_id}/posts`, {
        access_token: pageToken,
        fields:
          "id,message,story,created_time,permalink_url,full_picture,attachments{type,url,title,description},shares",
        limit: limit ?? 25,
      });
      return asJson(data);
    }
  );

  server.registerTool(
    "get_page_insights",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description:
        "Fetch insights metrics for a Facebook Page (impressions, engaged users, fans, etc.). Provide either a date_preset OR a time_range.",
      inputSchema: {
        page_id: z.string().describe("Facebook Page ID"),
        metrics: z
          .array(z.string())
          .optional()
          .describe(
            "Insights metric names. Defaults to a useful set (page_impressions, page_impressions_unique, page_post_engagements, page_fans)."
          ),
        date_preset: datePresetSchema.optional(),
        time_range: dateRangeSchema.optional(),
        period: z
          .enum(["day", "week", "days_28"])
          .optional()
          .describe("Aggregation window (default: day)"),
      },
    },
    async ({ page_id, metrics, date_preset, time_range, period }) => {
      if (date_preset && time_range) {
        throw new Error(
          "Provide either date_preset OR time_range, not both."
        );
      }
      const pageToken = await meta.getPageAccessToken(page_id);
      const params: Record<string, string | number> = {
        access_token: pageToken,
        metric: (
          metrics ?? [
            "page_impressions_unique",
            "page_post_engagements",
            "page_follows",
            "page_views_total",
          ]
        ).join(","),
        period: period ?? "day",
      };
      if (date_preset) params.date_preset = date_preset;
      if (time_range) {
        params.since = time_range.since;
        params.until = time_range.until;
      }
      const data = await meta.get(`/${page_id}/insights`, params);
      return asJson(data);
    }
  );

  server.registerTool(
    "create_page_post",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description:
        "Create a new post on a Facebook Page. WRITE OPERATION. Set published=false to create as an unpublished draft. Returns the new post ID.",
      inputSchema: {
        page_id: z.string().describe("Facebook Page ID"),
        message: z.string().min(1).describe("The text content of the post"),
        link: z
          .string()
          .url()
          .optional()
          .describe("Optional URL to attach to the post (link preview)"),
        published: z
          .boolean()
          .optional()
          .describe(
            "If false, post is saved as unpublished/draft. Default: true (published immediately)."
          ),
      },
    },
    async ({ page_id, message, link, published }) => {
      const pageToken = await meta.getPageAccessToken(page_id);
      const body: Record<string, string | boolean> = { message };
      if (link) body.link = link;
      if (published === false) body.published = false;
      const data = await meta.post(`/${page_id}/feed`, body, {
        access_token: pageToken,
      });
      return asJson(data);
    }
  );

  server.registerTool(
    "delete_page_post",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description:
        "Delete a post from a Facebook Page. DESTRUCTIVE — cannot be undone. Returns Graph's success payload.",
      inputSchema: {
        page_id: z
          .string()
          .describe("Facebook Page ID that owns the post (for token lookup)"),
        post_id: z
          .string()
          .describe(
            "Post ID to delete (in the form pageid_postid as returned by list_page_posts)"
          ),
      },
    },
    async ({ page_id, post_id }) => {
      const pageToken = await meta.getPageAccessToken(page_id);
      const data = await meta.delete(`/${post_id}`, {
        access_token: pageToken,
      });
      return asJson(data);
    }
  );

  // ------------------------------------------------------------- Creatives
  server.registerTool(
    "list_creatives",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: "List ad creatives inside an ad account.",
      inputSchema: {
        account_id: z
          .string()
          .describe("Ad account ID, with or without 'act_' prefix"),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ account_id, limit }) => {
      const data = await meta.get(
        `/${normalizeAdAccountId(account_id)}/adcreatives`,
        {
          fields:
            "id,name,status,object_type,thumbnail_url,image_url,body,title,call_to_action_type,object_story_spec",
          limit: limit ?? 25,
        }
      );
      return asJson(data);
    }
  );
}
