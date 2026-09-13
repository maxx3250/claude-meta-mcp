/**
 * Read-only lookups that let a model reason about an ad set's targeting
 * before and after a change:
 *
 *   - get_adset             full ad set config incl. targeting, promoted_object
 *   - estimate_audience     Meta's delivery estimate for a targeting spec
 *   - list_custom_audiences / get_custom_audience
 *   - list_pixels / get_pixel_events
 *
 * All tools here are annotated readOnlyHint so MCP clients can auto-approve.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MetaClient } from "./meta-client.js";
import { targetingSchema } from "./lib/targeting.js";

function asJson(value: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function normalizeAdAccountId(id: string): string {
  return id.startsWith("act_") ? id : `act_${id}`;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

export const ADSET_FIELDS =
  "id,name,campaign_id,status,effective_status,configured_status,daily_budget,lifetime_budget,budget_remaining," +
  "bid_amount,bid_strategy,billing_event,optimization_goal,optimization_sub_event,promoted_object,attribution_spec," +
  "targeting,destination_type,start_time,end_time,created_time,updated_time,learning_stage_info,pacing_type," +
  "is_dynamic_creative,frequency_control_specs,dsa_beneficiary,dsa_payor";

export function registerAudienceTools(server: McpServer, meta: MetaClient): void {
  server.registerTool(
    "get_adset",
    {
      description:
        "Fetch one ad set with its full configuration: targeting (incl. custom-audience inclusions/exclusions and " +
        "placements), promoted_object (pixel + conversion event), optimization goal, bid strategy, attribution, " +
        "budgets, schedule and learning phase. Use before and after update_adset to verify a change. Read-only.",
      inputSchema: {
        adset_id: z.string().describe("Ad set ID"),
      },
      annotations: READ_ONLY,
    },
    async ({ adset_id }) => {
      const data = await meta.get(`/${adset_id}`, { fields: ADSET_FIELDS });
      return asJson(data);
    }
  );

  server.registerTool(
    "estimate_audience",
    {
      description:
        "Ask Meta for a delivery estimate (estimated daily / monthly reach) for a targeting spec inside an ad account. " +
        "Use it to sanity-check a targeting before writing it with create_adset / update_adset. Read-only, changes nothing.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID, with or without 'act_' prefix"),
        targeting: targetingSchema,
        optimization_goal: z
          .string()
          .optional()
          .describe("Optimization goal the estimate is computed for (default REACH), e.g. OFFSITE_CONVERSIONS, LINK_CLICKS"),
      },
      annotations: READ_ONLY,
    },
    async ({ account_id, targeting, optimization_goal }) => {
      const data = await meta.get(`/${normalizeAdAccountId(account_id)}/delivery_estimate`, {
        targeting_spec: JSON.stringify(targeting),
        optimization_goal: optimization_goal ?? "REACH",
      });
      return asJson(data);
    }
  );

  server.registerTool(
    "list_custom_audiences",
    {
      description:
        "List Custom Audiences, Lookalike Audiences and website/pixel audiences of an ad account with size estimates " +
        "and delivery status. Use the ids in targeting.custom_audiences / targeting.excluded_custom_audiences. Read-only.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID, with or without 'act_' prefix"),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ account_id, limit }) => {
      const data = await meta.get(`/${normalizeAdAccountId(account_id)}/customaudiences`, {
        fields:
          "id,name,subtype,description,approximate_count_lower_bound,approximate_count_upper_bound," +
          "delivery_status,operation_status,retention_days,time_updated,lookalike_spec",
        limit: limit ?? 50,
      });
      return asJson(data);
    }
  );

  server.registerTool(
    "get_custom_audience",
    {
      description:
        "Fetch one Custom Audience in detail, including its rule (for website audiences: pixel + event + retention), " +
        "lookalike spec and data source. Read-only.",
      inputSchema: {
        audience_id: z.string().describe("Custom Audience ID"),
      },
      annotations: READ_ONLY,
    },
    async ({ audience_id }) => {
      const data = await meta.get(`/${audience_id}`, {
        fields:
          "id,name,subtype,description,approximate_count_lower_bound,approximate_count_upper_bound," +
          "delivery_status,operation_status,retention_days,rule,lookalike_spec,data_source,pixel_id," +
          "customer_file_source,time_created,time_updated",
      });
      return asJson(data);
    }
  );

  server.registerTool(
    "list_pixels",
    {
      description:
        "List the Meta Pixels / datasets of an ad account (id, name, last fired time). The pixel id is what " +
        "promoted_object.pixel_id expects for conversion ad sets. Read-only.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID, with or without 'act_' prefix"),
      },
      annotations: READ_ONLY,
    },
    async ({ account_id }) => {
      const data = await meta.get(`/${normalizeAdAccountId(account_id)}/adspixels`, {
        fields: "id,name,last_fired_time,creation_time,is_unavailable,data_use_setting,owner_business",
      });
      return asJson(data);
    }
  );

  server.registerTool(
    "get_pixel_events",
    {
      description:
        "Which events a pixel actually received in the last N days (PageView, ViewContent, AddToCart, Purchase, …) " +
        "with counts. Use it to pick a custom_event_type for promoted_object that really fires. Read-only.",
      inputSchema: {
        pixel_id: z.string().describe("Pixel ID from list_pixels"),
        days: z.number().int().min(1).max(30).optional().describe("Look-back window in days (default 7)"),
      },
      annotations: READ_ONLY,
    },
    async ({ pixel_id, days }) => {
      const window = days ?? 7;
      const end = Math.floor(Date.now() / 1000);
      const start = end - window * 86_400;
      interface Bucket {
        start_time?: string;
        data?: { value?: string; count?: number | string }[];
      }
      const raw = await meta.get<{ data?: Bucket[] }>(`/${pixel_id}/stats`, {
        aggregation: "event",
        start_time: start,
        end_time: end,
      });
      const totals = new Map<string, number>();
      for (const bucket of raw.data ?? []) {
        for (const row of bucket.data ?? []) {
          const name = row.value ?? "unknown";
          const count = typeof row.count === "number" ? row.count : parseInt(String(row.count ?? "0"), 10);
          totals.set(name, (totals.get(name) ?? 0) + (Number.isFinite(count) ? count : 0));
        }
      }
      const events = [...totals.entries()]
        .map(([event, count]) => ({ event, count }))
        .sort((a, b) => b.count - a.count);
      return asJson({ pixel_id, days: window, since: new Date(start * 1000).toISOString(), events });
    }
  );
}
