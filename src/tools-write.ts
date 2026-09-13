/**
 * Write-side tools for the Meta connector.
 *
 * Covers:
 *   - Ad Image / Ad Video uploads (multipart + chunked)
 *   - Campaign / Ad Set / Ad CRUD (PAUSED-default for safety)
 *   - Ad Creative create + delete
 *
 * All creates are forced to status=PAUSED and no update tool can change a
 * status — activation only happens through the explicit set_*_status tools.
 * Budget increases need confirm_budget_increase=true and are capped by
 * MAX_DAILY_BUDGET_CENTS / MAX_LIFETIME_BUDGET_CENTS (src/lib/guards.ts).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MetaClient } from "./meta-client.js";
import { config } from "./config.js";
import { assertBudgetChangeAllowed, parseCents } from "./lib/guards.js";
import {
  targetingSchema,
  mergeTargeting,
  stripReadOnlyTargetingKeys,
  changedTargetingKeys,
  type Targeting,
} from "./lib/targeting.js";

const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

const bidStrategySchema = z
  .enum(["LOWEST_COST_WITHOUT_CAP", "LOWEST_COST_WITH_BID_CAP", "COST_CAP", "LOWEST_COST_WITH_MIN_ROAS"])
  .describe("Bid strategy");

const optimizationGoalSchema = z
  .string()
  .describe(
    "Optimization goal, must fit the campaign objective. Common: OFFSITE_CONVERSIONS, VALUE, LINK_CLICKS, " +
      "LANDING_PAGE_VIEWS, REACH, IMPRESSIONS, POST_ENGAGEMENT, THRUPLAY, LEAD_GENERATION, QUALITY_LEAD, CONVERSATIONS"
  );

const promotedObjectSchema = z
  .object({
    pixel_id: z.string().optional().describe("Meta Pixel / dataset ID (list_pixels)"),
    custom_event_type: z
      .string()
      .optional()
      .describe("Standard event to optimize for: PURCHASE, ADD_TO_CART, INITIATED_CHECKOUT, LEAD, COMPLETE_REGISTRATION, CONTENT_VIEW, SEARCH, ADD_TO_WISHLIST, CONTACT, SUBSCRIBE, OTHER"),
    custom_event_str: z.string().optional().describe("Custom event name when custom_event_type is OTHER"),
    page_id: z.string().optional(),
    product_catalog_id: z.string().optional(),
    product_set_id: z.string().optional(),
    application_id: z.string().optional(),
    object_store_url: z.string().optional(),
  })
  .passthrough()
  .describe("What the ad set optimizes for. Conversion ad sets need pixel_id + custom_event_type.");

const confirmBudgetSchema = z
  .boolean()
  .optional()
  .describe(
    "Must be true to RAISE a budget. Only set it after the user explicitly agreed to the new amount. Lowering never needs it."
  );

const statusSchema = z
  .enum(["ACTIVE", "PAUSED", "ARCHIVED"])
  .describe("ACTIVE starts delivery and spending immediately");

function registerStatusTool(
  server: McpServer,
  meta: MetaClient,
  name: string,
  idKey: "campaign_id" | "adset_id" | "ad_id",
  label: string
): void {
  server.registerTool(
    name,
    {
      description:
        `Set the status of a ${label}. This is the ONLY tool that can activate a ${label} (status ACTIVE) and thereby ` +
        "start spending — call it only after the user explicitly asked to go live. PAUSED stops delivery, ARCHIVED " +
        "hides it. WRITE OPERATION.",
      inputSchema: {
        [idKey]: z.string().describe(`${label} ID`),
        status: statusSchema,
      } as Record<string, z.ZodTypeAny>,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: Record<string, unknown>) => {
      const id = String(args[idKey]);
      const status = String(args.status);
      const data = await meta.post(`/${id}`, { status });
      return asJson({ result: data, [idKey]: id, status });
    }
  );
}

function asJson(value: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(value, null, 2) },
    ],
  };
}

function normalizeAdAccountId(id: string): string {
  return id.startsWith("act_") ? id : `act_${id}`;
}

const assetSourceSchema = z
  .object({
    url: z.string().url().optional().describe("Public URL to download the asset from"),
    data_base64: z.string().optional().describe("Base64-encoded asset bytes (alternative to url)"),
    mime: z.string().optional().describe("MIME type override, e.g. image/jpeg"),
    filename: z.string().optional().describe("Optional filename for the upload"),
  })
  .refine((v) => Boolean(v.url) !== Boolean(v.data_base64), {
    message: "Provide exactly one of `url` or `data_base64`",
  });

export function registerWriteTools(server: McpServer, meta: MetaClient): void {
  // ============================================================ Asset uploads

  server.registerTool(
    "upload_ad_image",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description:
        "Upload an image to an ad account's image library. Returns the image hash (use this in ad creative `image_hash`). WRITE OPERATION.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID (with or without 'act_' prefix)"),
        source: assetSourceSchema,
      },
    },
    async ({ account_id, source }) => {
      const blob = await meta.fetchAsBlob({
        ...source,
        mime: source.mime ?? "image/jpeg",
        filename: source.filename ?? "image.jpg",
      });
      const data = await meta.postMultipart<{
        images?: Record<string, { hash: string; url: string }>;
      }>(`/${normalizeAdAccountId(account_id)}/adimages`, {
        filename: blob,
      });
      return asJson(data);
    }
  );

  server.registerTool(
    "list_ad_images",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: "List images previously uploaded to this ad account.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ account_id, limit }) => {
      const data = await meta.get(`/${normalizeAdAccountId(account_id)}/adimages`, {
        fields: "hash,name,status,width,height,url,permalink_url,created_time",
        limit: limit ?? 25,
      });
      return asJson(data);
    }
  );

  server.registerTool(
    "upload_ad_video",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description:
        "Upload a video to an ad account. Small videos (<50MB) upload in one request. Returns the video ID. " +
        "Videos process asynchronously — use get_video_processing_status to poll readiness. WRITE OPERATION.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        source: assetSourceSchema,
        title: z.string().optional().describe("Optional video title"),
        description: z.string().optional().describe("Optional video description"),
      },
    },
    async ({ account_id, source, title, description }) => {
      const blob = await meta.fetchAsBlob({
        ...source,
        mime: source.mime ?? "video/mp4",
        filename: source.filename ?? "video.mp4",
      });

      // For simplicity, single-shot upload. Meta accepts up to ~1GB on /advideos
      // when sent as multipart, though chunked is recommended for >50MB.
      const data = await meta.postMultipart<{ id?: string }>(
        `/${normalizeAdAccountId(account_id)}/advideos`,
        {
          source: blob,
          title,
          description,
        }
      );
      return asJson(data);
    }
  );

  server.registerTool(
    "get_video_processing_status",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description:
        "Check whether an uploaded video has finished processing. Returns status_code (e.g. 'ready', 'processing', 'error') and any error reason.",
      inputSchema: {
        video_id: z.string().describe("Video ID returned by upload_ad_video"),
      },
    },
    async ({ video_id }) => {
      const data = await meta.get(`/${video_id}`, {
        fields: "id,status,published,permalink_url,length,source",
      });
      return asJson(data);
    }
  );

  server.registerTool(
    "list_ad_videos",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: "List videos uploaded to this ad account.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ account_id, limit }) => {
      const data = await meta.get(`/${normalizeAdAccountId(account_id)}/advideos`, {
        fields: "id,title,description,status,length,permalink_url,created_time",
        limit: limit ?? 25,
      });
      return asJson(data);
    }
  );

  // ============================================================ Ad Creatives (write)

  server.registerTool(
    "create_ad_creative",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description:
        "Create a reusable ad creative (link-ad with image, image-only, or video creative). Required for create_ad. " +
        "WRITE OPERATION. Use upload_ad_image / upload_ad_video first to obtain the image_hash / video_id.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        name: z.string().describe("Internal name for this creative (not shown to users)"),
        page_id: z.string().describe("Facebook Page ID that will own the ad"),
        message: z.string().describe("Primary text shown above the ad creative"),
        link: z.string().url().optional().describe("Destination URL when clicked"),
        link_title: z.string().optional().describe("Headline shown below the image (link ads)"),
        link_description: z.string().optional().describe("Description shown under the headline"),
        image_hash: z.string().optional().describe("Image hash from upload_ad_image (use either image_hash or video_id)"),
        video_id: z.string().optional().describe("Video ID from upload_ad_video"),
        call_to_action: z
          .enum([
            "LEARN_MORE", "SHOP_NOW", "SIGN_UP", "BOOK_TRAVEL", "DOWNLOAD",
            "GET_QUOTE", "SUBSCRIBE", "CONTACT_US", "APPLY_NOW", "GET_OFFER",
            "ORDER_NOW", "MESSAGE_PAGE",
          ])
          .optional()
          .describe("Call-to-action button label"),
        instagram_user_id: z
          .string()
          .optional()
          .describe("Optional Instagram Business Account ID for cross-platform delivery"),
      },
    },
    async ({
      account_id, name, page_id, message, link, link_title, link_description,
      image_hash, video_id, call_to_action, instagram_user_id,
    }) => {
      if (!image_hash && !video_id) {
        throw new Error("Provide either image_hash (from upload_ad_image) or video_id (from upload_ad_video)");
      }
      const cta = call_to_action
        ? { type: call_to_action, value: link ? { link } : undefined }
        : undefined;

      let object_story_spec: Record<string, unknown>;
      if (video_id) {
        object_story_spec = {
          page_id,
          video_data: {
            video_id,
            title: link_title,
            message,
            call_to_action: cta,
            link_description,
          },
        };
      } else {
        object_story_spec = {
          page_id,
          link_data: {
            image_hash,
            link,
            message,
            name: link_title,
            description: link_description,
            call_to_action: cta,
          },
        };
      }
      if (instagram_user_id) object_story_spec.instagram_actor_id = instagram_user_id;

      const data = await meta.post(`/${normalizeAdAccountId(account_id)}/adcreatives`, {
        name,
        object_story_spec: JSON.stringify(object_story_spec),
      });
      return asJson(data);
    }
  );

  server.registerTool(
    "delete_ad_creative",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description: "Delete an ad creative. DESTRUCTIVE — cannot be undone.",
      inputSchema: { creative_id: z.string().describe("Creative ID") },
    },
    async ({ creative_id }) => {
      const data = await meta.delete(`/${creative_id}`);
      return asJson(data);
    }
  );

  // ============================================================ Campaigns (write)

  server.registerTool(
    "create_campaign",
    {
      description:
        "Create a new campaign. ALWAYS created PAUSED — activation is a separate, explicit step via set_campaign_status. " +
        "WRITE OPERATION.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        name: z.string().describe("Campaign name"),
        objective: z
          .enum([
            "OUTCOME_AWARENESS", "OUTCOME_TRAFFIC", "OUTCOME_ENGAGEMENT",
            "OUTCOME_LEADS", "OUTCOME_APP_PROMOTION", "OUTCOME_SALES",
          ])
          .describe("Campaign objective (Outcome-Driven Ad Experience format)"),
        special_ad_categories: z
          .array(z.enum(["NONE", "EMPLOYMENT", "HOUSING", "CREDIT", "ISSUES_ELECTIONS_POLITICS"]))
          .optional()
          .describe("Required for regulated ad categories (default: ['NONE'])"),
        daily_budget_cents: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Daily budget in account currency cents (e.g. 1000 = €10.00). Set on Campaign for CBO."),
        lifetime_budget_cents: z.number().int().positive().optional(),
        bid_strategy: bidStrategySchema.optional(),
        is_adset_budget_sharing_enabled: z
          .boolean()
          .optional()
          .describe(
            "Only relevant WITHOUT a campaign budget (ad set budgets). Meta requires it: true = ad sets may share " +
              "up to 20% of their budget with each other, false = strict per-ad-set budgets (default false)."
          ),
      },
      annotations: WRITE,
    },
    async ({
      account_id, name, objective, special_ad_categories,
      daily_budget_cents, lifetime_budget_cents, bid_strategy, is_adset_budget_sharing_enabled,
    }) => {
      const body: Record<string, string | number> = {
        name,
        objective,
        status: "PAUSED",
        special_ad_categories: JSON.stringify(special_ad_categories ?? ["NONE"]),
      };
      if (daily_budget_cents) {
        assertBudgetChangeAllowed({
          kind: "daily", requestedCents: daily_budget_cents, confirm: false,
          capCents: config.limits.maxDailyBudgetCents,
        });
        body.daily_budget = daily_budget_cents;
      }
      if (lifetime_budget_cents) {
        assertBudgetChangeAllowed({
          kind: "lifetime", requestedCents: lifetime_budget_cents, confirm: false,
          capCents: config.limits.maxLifetimeBudgetCents,
        });
        body.lifetime_budget = lifetime_budget_cents;
      }
      if (bid_strategy) body.bid_strategy = bid_strategy;
      if (!daily_budget_cents && !lifetime_budget_cents) {
        // Required by Meta since 2025 for campaigns that leave budgets on the ad sets.
        body.is_adset_budget_sharing_enabled = String(is_adset_budget_sharing_enabled ?? false);
      }

      const data = await meta.post(`/${normalizeAdAccountId(account_id)}/campaigns`, body);
      return asJson(data);
    }
  );

  server.registerTool(
    "update_campaign",
    {
      description:
        "Update a campaign's name, budget or bid strategy. Status is NOT changed here — use set_campaign_status. " +
        "Raising a budget requires confirm_budget_increase=true after the user agreed. WRITE OPERATION.",
      inputSchema: {
        campaign_id: z.string(),
        name: z.string().optional(),
        daily_budget_cents: z.number().int().positive().optional(),
        lifetime_budget_cents: z.number().int().positive().optional(),
        bid_strategy: bidStrategySchema.optional(),
        is_adset_budget_sharing_enabled: z.boolean().optional().describe("Ad-set budget sharing (only without campaign budget)"),
        confirm_budget_increase: confirmBudgetSchema,
      },
      annotations: WRITE,
    },
    async ({
      campaign_id, name, daily_budget_cents, lifetime_budget_cents, bid_strategy,
      is_adset_budget_sharing_enabled, confirm_budget_increase,
    }) => {
      const body: Record<string, string | number> = {};
      if (name !== undefined) body.name = name;
      if (bid_strategy) body.bid_strategy = bid_strategy;
      if (is_adset_budget_sharing_enabled !== undefined) {
        body.is_adset_budget_sharing_enabled = String(is_adset_budget_sharing_enabled);
      }
      if (daily_budget_cents || lifetime_budget_cents) {
        const current = await meta.get<{ daily_budget?: string; lifetime_budget?: string }>(`/${campaign_id}`, {
          fields: "id,daily_budget,lifetime_budget",
        });
        if (daily_budget_cents) {
          assertBudgetChangeAllowed({
            kind: "daily", currentCents: parseCents(current.daily_budget), requestedCents: daily_budget_cents,
            confirm: Boolean(confirm_budget_increase), capCents: config.limits.maxDailyBudgetCents,
          });
          body.daily_budget = daily_budget_cents;
        }
        if (lifetime_budget_cents) {
          assertBudgetChangeAllowed({
            kind: "lifetime", currentCents: parseCents(current.lifetime_budget), requestedCents: lifetime_budget_cents,
            confirm: Boolean(confirm_budget_increase), capCents: config.limits.maxLifetimeBudgetCents,
          });
          body.lifetime_budget = lifetime_budget_cents;
        }
      }
      if (Object.keys(body).length === 0) throw new Error("Nothing to update — provide at least one field");
      const data = await meta.post(`/${campaign_id}`, body);
      return asJson({ result: data, changed_fields: Object.keys(body) });
    }
  );

  server.registerTool(
    "delete_campaign",
    {
      description:
        "Delete (or rather: soft-delete) a campaign by setting its status to DELETED. DESTRUCTIVE.",
      inputSchema: { campaign_id: z.string() },
      annotations: DESTRUCTIVE,
    },
    async ({ campaign_id }) => {
      const data = await meta.delete(`/${campaign_id}`);
      return asJson(data);
    }
  );

  // ============================================================ Ad Sets (write)

  server.registerTool(
    "create_adset",
    {
      description:
        "Create an ad set inside a campaign. ALWAYS created PAUSED — activation is a separate, explicit step via " +
        "set_adset_status. For conversion ad sets (optimization_goal OFFSITE_CONVERSIONS / VALUE) pass promoted_object " +
        "with pixel_id + custom_event_type (see list_pixels, get_pixel_events). Meta usually requires " +
        "targeting.targeting_automation.advantage_audience (0 or 1) to be set explicitly. Use estimate_audience first " +
        "to sanity-check the targeting. WRITE OPERATION.",
      inputSchema: {
        account_id: z.string(),
        campaign_id: z.string(),
        name: z.string(),
        daily_budget_cents: z.number().int().positive().optional(),
        lifetime_budget_cents: z.number().int().positive().optional(),
        billing_event: z
          .string()
          .optional()
          .describe("Default IMPRESSIONS. Others: LINK_CLICKS, POST_ENGAGEMENT, PAGE_LIKES, VIDEO_VIEWS, THRUPLAY"),
        optimization_goal: optimizationGoalSchema,
        bid_strategy: bidStrategySchema.optional(),
        bid_amount_cents: z.number().int().positive().optional().describe("Bid cap / cost cap in cents, required for some bid strategies"),
        targeting: targetingSchema,
        promoted_object: promotedObjectSchema.optional(),
        destination_type: z.string().optional().describe("e.g. WEBSITE, APP, MESSENGER, INSTAGRAM_DIRECT, ON_AD"),
        attribution_spec: z
          .array(z.object({ event_type: z.string(), window_days: z.number().int() }))
          .optional()
          .describe("e.g. [{event_type:'CLICK_THROUGH',window_days:7},{event_type:'VIEW_THROUGH',window_days:1}]"),
        start_time: z.string().optional().describe("ISO 8601 start time"),
        end_time: z.string().optional().describe("ISO 8601 end time"),
        dsa_beneficiary: z.string().optional().describe("EU DSA: who benefits from the ads (required for EU-targeted ad sets)"),
        dsa_payor: z.string().optional().describe("EU DSA: who pays for the ads (required for EU-targeted ad sets)"),
      },
      annotations: WRITE,
    },
    async ({
      account_id, campaign_id, name,
      daily_budget_cents, lifetime_budget_cents,
      billing_event, optimization_goal, bid_strategy, bid_amount_cents,
      targeting, promoted_object, destination_type, attribution_spec,
      start_time, end_time, dsa_beneficiary, dsa_payor,
    }) => {
      const body: Record<string, string | number> = {
        name,
        campaign_id,
        billing_event: billing_event ?? "IMPRESSIONS",
        optimization_goal,
        targeting: JSON.stringify(stripReadOnlyTargetingKeys(targeting)),
        status: "PAUSED",
      };
      if (daily_budget_cents) {
        assertBudgetChangeAllowed({
          kind: "daily", requestedCents: daily_budget_cents, confirm: false,
          capCents: config.limits.maxDailyBudgetCents,
        });
        body.daily_budget = daily_budget_cents;
      }
      if (lifetime_budget_cents) {
        assertBudgetChangeAllowed({
          kind: "lifetime", requestedCents: lifetime_budget_cents, confirm: false,
          capCents: config.limits.maxLifetimeBudgetCents,
        });
        body.lifetime_budget = lifetime_budget_cents;
      }
      if (bid_strategy) body.bid_strategy = bid_strategy;
      if (bid_amount_cents) body.bid_amount = bid_amount_cents;
      if (promoted_object) body.promoted_object = JSON.stringify(promoted_object);
      if (destination_type) body.destination_type = destination_type;
      if (attribution_spec) body.attribution_spec = JSON.stringify(attribution_spec);
      if (start_time) body.start_time = start_time;
      if (end_time) body.end_time = end_time;
      if (dsa_beneficiary) body.dsa_beneficiary = dsa_beneficiary;
      if (dsa_payor) body.dsa_payor = dsa_payor;

      const data = await meta.post(`/${normalizeAdAccountId(account_id)}/adsets`, body);
      return asJson(data);
    }
  );

  server.registerTool(
    "update_adset",
    {
      description:
        "Update an ad set: name, budget, bid, optimization goal, promoted_object (pixel + conversion event), schedule, " +
        "and targeting. Targeting is applied as a MERGE by default: only the keys you pass change, everything else " +
        "(ages, other audiences, placements) is kept — e.g. targeting:{geo_locations:{countries:['AT']}} drops DE and " +
        "keeps the rest. Use targeting_unset to remove keys (e.g. ['excluded_custom_audiences']) and " +
        "targeting_mode='replace' to overwrite the whole spec. Returns targeting_before / targeting_after for a " +
        "before-after check. Status is NOT changed here — use set_adset_status. Raising a budget requires " +
        "confirm_budget_increase=true after the user agreed. WRITE OPERATION.",
      inputSchema: {
        adset_id: z.string(),
        name: z.string().optional(),
        daily_budget_cents: z.number().int().positive().optional(),
        lifetime_budget_cents: z.number().int().positive().optional(),
        bid_strategy: bidStrategySchema.optional(),
        bid_amount_cents: z.number().int().positive().optional(),
        optimization_goal: optimizationGoalSchema.optional(),
        billing_event: z.string().optional(),
        promoted_object: promotedObjectSchema.optional(),
        attribution_spec: z
          .array(z.object({ event_type: z.string(), window_days: z.number().int() }))
          .optional(),
        start_time: z.string().optional(),
        end_time: z.string().optional(),
        dsa_beneficiary: z.string().optional(),
        dsa_payor: z.string().optional(),
        targeting: targetingSchema.optional().describe("Partial targeting patch (merge) or full spec (replace)"),
        targeting_unset: z
          .array(z.string())
          .optional()
          .describe("Targeting keys to remove, dotted paths allowed: ['excluded_custom_audiences','geo_locations.cities']"),
        targeting_mode: z
          .enum(["merge", "replace"])
          .optional()
          .describe("merge (default): patch into the current targeting. replace: send exactly what you pass."),
        confirm_budget_increase: confirmBudgetSchema,
      },
      annotations: WRITE,
    },
    async (args) => {
      const {
        adset_id, name, daily_budget_cents, lifetime_budget_cents, bid_strategy, bid_amount_cents,
        optimization_goal, billing_event, promoted_object, attribution_spec, start_time, end_time,
        dsa_beneficiary, dsa_payor, targeting, targeting_unset, targeting_mode, confirm_budget_increase,
      } = args;
      const body: Record<string, string | number> = {};
      const touchesTargeting = targeting !== undefined || (targeting_unset?.length ?? 0) > 0;
      const touchesBudget = Boolean(daily_budget_cents || lifetime_budget_cents);

      let current: { daily_budget?: string; lifetime_budget?: string; targeting?: Targeting } = {};
      if (touchesTargeting || touchesBudget) {
        current = await meta.get(`/${adset_id}`, { fields: "id,name,daily_budget,lifetime_budget,targeting" });
      }

      if (name !== undefined) body.name = name;
      if (daily_budget_cents) {
        assertBudgetChangeAllowed({
          kind: "daily", currentCents: parseCents(current.daily_budget), requestedCents: daily_budget_cents,
          confirm: Boolean(confirm_budget_increase), capCents: config.limits.maxDailyBudgetCents,
        });
        body.daily_budget = daily_budget_cents;
      }
      if (lifetime_budget_cents) {
        assertBudgetChangeAllowed({
          kind: "lifetime", currentCents: parseCents(current.lifetime_budget), requestedCents: lifetime_budget_cents,
          confirm: Boolean(confirm_budget_increase), capCents: config.limits.maxLifetimeBudgetCents,
        });
        body.lifetime_budget = lifetime_budget_cents;
      }
      if (bid_strategy) body.bid_strategy = bid_strategy;
      if (bid_amount_cents) body.bid_amount = bid_amount_cents;
      if (optimization_goal) body.optimization_goal = optimization_goal;
      if (billing_event) body.billing_event = billing_event;
      if (promoted_object) body.promoted_object = JSON.stringify(promoted_object);
      if (attribution_spec) body.attribution_spec = JSON.stringify(attribution_spec);
      if (start_time) body.start_time = start_time;
      if (end_time) body.end_time = end_time;
      if (dsa_beneficiary) body.dsa_beneficiary = dsa_beneficiary;
      if (dsa_payor) body.dsa_payor = dsa_payor;

      let targetingBefore: Targeting | undefined;
      let targetingAfter: Targeting | undefined;
      if (touchesTargeting) {
        targetingBefore = current.targeting ?? {};
        targetingAfter =
          targeting_mode === "replace"
            ? stripReadOnlyTargetingKeys(targeting ?? {})
            : mergeTargeting(targetingBefore, targeting ?? {}, targeting_unset ?? []);
        body.targeting = JSON.stringify(targetingAfter);
      }

      if (Object.keys(body).length === 0) throw new Error("Nothing to update — provide at least one field");
      const data = await meta.post(`/${adset_id}`, body);
      return asJson({
        result: data,
        changed_fields: Object.keys(body),
        ...(targetingBefore && targetingAfter
          ? {
              targeting_changed_keys: changedTargetingKeys(
                stripReadOnlyTargetingKeys(targetingBefore),
                targetingAfter
              ),
              targeting_before: targetingBefore,
              targeting_after: targetingAfter,
            }
          : {}),
      });
    }
  );

  server.registerTool(
    "delete_adset",
    {
      description: "Delete an ad set. DESTRUCTIVE.",
      inputSchema: { adset_id: z.string() },
      annotations: DESTRUCTIVE,
    },
    async ({ adset_id }) => {
      const data = await meta.delete(`/${adset_id}`);
      return asJson(data);
    }
  );

  // ============================================================ Ads (write)

  server.registerTool(
    "create_ad",
    {
      description:
        "Create an ad inside an ad set. ALWAYS created PAUSED — activation is a separate, explicit step via " +
        "set_ad_status. Requires a creative_id from create_ad_creative. WRITE OPERATION.",
      inputSchema: {
        account_id: z.string(),
        adset_id: z.string(),
        creative_id: z.string(),
        name: z.string(),
      },
      annotations: WRITE,
    },
    async ({ account_id, adset_id, creative_id, name }) => {
      const data = await meta.post(`/${normalizeAdAccountId(account_id)}/ads`, {
        name,
        adset_id,
        creative: JSON.stringify({ creative_id }),
        status: "PAUSED",
      });
      return asJson(data);
    }
  );

  server.registerTool(
    "update_ad",
    {
      description:
        "Update an ad's name or creative. Status is NOT changed here — use set_ad_status. WRITE OPERATION.",
      inputSchema: {
        ad_id: z.string(),
        name: z.string().optional(),
        creative_id: z.string().optional().describe("Replace the ad's creative"),
      },
      annotations: WRITE,
    },
    async ({ ad_id, name, creative_id }) => {
      const body: Record<string, string | number> = {};
      if (name !== undefined) body.name = name;
      if (creative_id) body.creative = JSON.stringify({ creative_id });
      if (Object.keys(body).length === 0) throw new Error("Nothing to update");
      const data = await meta.post(`/${ad_id}`, body);
      return asJson(data);
    }
  );

  server.registerTool(
    "delete_ad",
    {
      description: "Delete an ad. DESTRUCTIVE.",
      inputSchema: { ad_id: z.string() },
      annotations: DESTRUCTIVE,
    },
    async ({ ad_id }) => {
      const data = await meta.delete(`/${ad_id}`);
      return asJson(data);
    }
  );

  // ============================================================ Status (explicit activation)

  registerStatusTool(server, meta, "set_campaign_status", "campaign_id", "campaign");
  registerStatusTool(server, meta, "set_adset_status", "adset_id", "ad set");
  registerStatusTool(server, meta, "set_ad_status", "ad_id", "ad");

  server.registerTool(
    "preview_ad",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description:
        "Render a preview of an ad for a given placement (returns HTML iframe markup). " +
        "Useful for QA before activating an ad.",
      inputSchema: {
        ad_id: z.string(),
        ad_format: z
          .enum([
            "DESKTOP_FEED_STANDARD", "MOBILE_FEED_STANDARD", "MOBILE_FEED_BASIC",
            "INSTAGRAM_STANDARD", "INSTAGRAM_STORY", "INSTAGRAM_REELS",
            "FACEBOOK_STORY_MOBILE", "AUDIENCE_NETWORK_OUTSTREAM_VIDEO",
            "MESSENGER_MOBILE_INBOX_MEDIA",
          ])
          .describe("Placement format to render"),
      },
    },
    async ({ ad_id, ad_format }) => {
      const data = await meta.get(`/${ad_id}/previews`, { ad_format });
      return asJson(data);
    }
  );
}
