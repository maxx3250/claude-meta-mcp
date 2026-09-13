/**
 * Targeting spec schema + merge helpers shared by create_adset, update_adset
 * and estimate_audience.
 *
 * Meta's ad set update REPLACES the whole `targeting` object — there is no
 * partial update on the Graph API. `mergeTargeting` therefore implements the
 * read-modify-write semantics the tools expose: top-level keys in the patch
 * replace the current value, `geo_locations` / `excluded_geo_locations` merge
 * one level deeper so "countries: ['AT']" keeps cities/location_types intact,
 * and `unset` removes keys (dotted paths allowed) that Meta would otherwise
 * keep, e.g. `excluded_custom_audiences` or `geo_locations.cities`.
 */

import { z } from "zod";

const idRef = z
  .object({ id: z.string(), name: z.string().optional() })
  .passthrough();

const geoSchema = z
  .object({
    countries: z
      .array(z.string().length(2))
      .optional()
      .describe("ISO 3166-1 alpha-2 codes, e.g. ['AT','DE']"),
    regions: z.array(z.object({ key: z.string() }).passthrough()).optional(),
    cities: z
      .array(
        z
          .object({
            key: z.string(),
            radius: z.number().optional(),
            distance_unit: z.enum(["mile", "kilometer"]).optional(),
          })
          .passthrough()
      )
      .optional(),
    zips: z.array(z.object({ key: z.string() }).passthrough()).optional(),
    location_types: z
      .array(z.string())
      .optional()
      .describe("e.g. home, recent, frequently_in"),
  })
  .passthrough();

export const targetingSchema = z
  .object({
    geo_locations: geoSchema.optional(),
    excluded_geo_locations: geoSchema.optional(),
    age_min: z.number().int().min(13).max(65).optional(),
    age_max: z.number().int().min(13).max(65).optional(),
    genders: z
      .array(z.union([z.literal(1), z.literal(2)]))
      .optional()
      .describe("[1]=men, [2]=women, omit = all"),
    locales: z
      .array(z.number().int())
      .optional()
      .describe("Meta locale IDs, e.g. 6 = German, 24 = English (US)"),
    interests: z.array(idRef).optional(),
    behaviors: z.array(idRef).optional(),
    custom_audiences: z
      .array(idRef)
      .optional()
      .describe("Include these Custom / Lookalike Audiences (ids from list_custom_audiences)"),
    excluded_custom_audiences: z
      .array(idRef)
      .optional()
      .describe("Exclude these audiences, e.g. buyers of the last 180 days for a prospecting ad set"),
    publisher_platforms: z
      .array(z.enum(["facebook", "instagram", "messenger", "audience_network"]))
      .optional(),
    facebook_positions: z
      .array(z.string())
      .optional()
      .describe("e.g. feed, video_feeds, story, facebook_reels, marketplace, search, right_hand_column, instream_video, profile_feed"),
    instagram_positions: z
      .array(z.string())
      .optional()
      .describe("e.g. stream, story, reels, explore, explore_home, profile_feed, ig_search, profile_reels"),
    messenger_positions: z
      .array(z.string())
      .optional()
      .describe("e.g. messenger_home, story"),
    audience_network_positions: z
      .array(z.string())
      .optional()
      .describe("e.g. classic, rewarded_video"),
    device_platforms: z.array(z.enum(["mobile", "desktop"])).optional(),
    targeting_automation: z
      .object({
        advantage_audience: z
          .union([z.literal(0), z.literal(1)])
          .describe("1 = Advantage+ audience (Meta may expand beyond the defined audience), 0 = strict"),
      })
      .passthrough()
      .optional(),
    flexible_spec: z.array(z.record(z.unknown())).optional(),
    exclusions: z.record(z.unknown()).optional(),
    brand_safety_content_filter_levels: z.array(z.string()).optional(),
  })
  .passthrough()
  .describe(
    "Meta targeting spec (https://developers.facebook.com/docs/marketing-api/audiences/reference/targeting-spec/). " +
      "Omitting all placement fields means Advantage+ placements."
  );

export type Targeting = Record<string, unknown>;

/**
 * Keys Meta returns inside `targeting` on GET but rejects (or ignores) on
 * POST. Stripped before every write so a read-modify-write round trip is
 * accepted unchanged.
 */
export const READ_ONLY_TARGETING_KEYS: readonly string[] = ["age_range"];

const ONE_LEVEL_MERGE = new Set(["geo_locations", "excluded_geo_locations"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stripReadOnlyTargetingKeys(targeting: Targeting): Targeting {
  const result: Targeting = { ...targeting };
  for (const key of READ_ONLY_TARGETING_KEYS) delete result[key];
  return result;
}

/**
 * Merge a partial targeting patch into the ad set's current targeting.
 * Pure — never mutates its inputs.
 */
export function mergeTargeting(
  current: Targeting | null | undefined,
  patch: Targeting | null | undefined,
  unset: readonly string[] = []
): Targeting {
  const result: Targeting = structuredClone(current ?? {});
  for (const key of READ_ONLY_TARGETING_KEYS) delete result[key];

  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue;
    const existing = result[key];
    if (ONE_LEVEL_MERGE.has(key) && isPlainObject(value) && isPlainObject(existing)) {
      const merged: Record<string, unknown> = { ...existing };
      for (const [subKey, subValue] of Object.entries(value)) {
        if (subValue !== undefined) merged[subKey] = subValue;
      }
      result[key] = merged;
    } else {
      result[key] = structuredClone(value);
    }
  }

  for (const path of unset) {
    const parts = path.split(".").filter(Boolean);
    if (parts.length === 0) continue;
    let node: unknown = result;
    for (let i = 0; i < parts.length - 1; i += 1) {
      node = isPlainObject(node) ? node[parts[i]] : undefined;
    }
    if (isPlainObject(node)) delete node[parts[parts.length - 1]];
  }

  return result;
}

/**
 * Shallow list of keys whose value differs between two targeting specs —
 * returned by update_adset so the caller can verify what actually changed.
 */
export function changedTargetingKeys(before: Targeting, after: Targeting): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed.push(key);
  }
  return changed.sort();
}
