# claude-meta-mcp

> Self-hosted Meta Ads (Facebook & Instagram) connector for Claude.
> Bring your campaign data into Claude conversations — no SaaS middleman, no per-seat pricing, your tokens stay on your server.

[![CI](https://github.com/maxx3250/claude-meta-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/maxx3250/claude-meta-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![MCP](https://img.shields.io/badge/MCP-Streamable_HTTP-blue.svg)](https://modelcontextprotocol.io/)
[![Status](https://img.shields.io/badge/status-v0.5_alpha-orange.svg)](./CHANGELOG.md)

> **Status — v0.5.0 (single-tenant alpha).**
> One Meta System User token, one shared Bearer secret, no database. Perfect for personal use or a single agency account. Multi-tenant + OAuth 2.1 + DCR are on the roadmap (see [Roadmap](#roadmap)).
>
> **v0.5 makes ad sets fully steerable from a conversation**: complete targeting spec on create *and* update (custom audiences, exclusions, placements, Advantage+ audience), `promoted_object` for conversion ad sets, audience / pixel lookups, a delivery estimate, and a safety layer — activation only through explicit `set_*_status` tools, budget raises need confirmation, optional hard caps. Every tool carries MCP annotations (`readOnlyHint` / `destructiveHint`) so clients can auto-approve reads. **56 tools** across four surfaces — Ads, Pages, Instagram, Catalogs.

---

## Why?

Existing options for connecting Meta Ads to Claude are either:

- **SaaS-only** (Windsor.ai, Pipeboard) — your ad data flows through a third-party platform, monthly fees, vendor lock-in.
- **Local-only** (most community MCP servers) — stdio transport, only works in Claude Desktop, can't be installed as a remote connector in claude.ai web.

`claude-meta-mcp` is a small, self-hostable Node service that:

- Speaks **MCP Streamable HTTP**, so it works with claude.ai web and Claude Desktop alike.
- Reads & writes Meta Ads (campaigns, ad sets, ads, creatives + image/video uploads), publishes & manages Facebook Page posts, publishes & moderates Instagram Business posts/reels/stories/carousels, and inspects Product Catalogs (feeds, products, diagnostics) for Dynamic Product Ads.
- Is **MIT licensed** — fork it, sell it, embed it.

---

## Quick start

### Prerequisites

- Node.js ≥ 20
- A Meta Developer App with a **System User token**. For the full v0.4 toolset that's `ads_read`, `ads_management`, `business_management`, `pages_*`, `instagram_*` and `catalog_management` scopes
  → see [`docs/META_APP_SETUP.md`](./docs/META_APP_SETUP.md) for the full step-by-step
- A public HTTPS URL (Claude requires HTTPS for custom connectors)

### Install

```bash
git clone https://github.com/maxx3250/claude-meta-mcp.git
cd claude-meta-mcp
npm install
cp .env.example .env
# fill in META_ACCESS_TOKEN and generate AUTH_TOKEN:
echo "AUTH_TOKEN=$(openssl rand -hex 32)" >> .env
npm run build
node --env-file=.env dist/index.js
```

The server listens on `PORT` (default `3210`) and exposes:

- `GET /health` — liveness probe (no auth)
- `POST /mcp` — MCP Streamable HTTP transport (Bearer auth)

### Connect to Claude

1. Put the service behind a reverse proxy that terminates TLS — see [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md).
2. In Claude → **Settings → Connectors → Add custom connector**.
3. URL: `https://your-domain.example.com/mcp`
4. Add header `Authorization: Bearer <your AUTH_TOKEN>` in the connector's advanced settings.
5. Save. Tools should appear in the connector list.

---

## Available tools

56 tools in v0.5 across four surfaces — Ads (read + write), Facebook Pages (read + write), Instagram Business (read + write), Product Catalogs (read).

> **Safety (v0.5):**
> - Campaigns, ad sets and ads are **always created `PAUSED`** — there is no way to create something live.
> - `update_*` tools **cannot change a status**. Going live is a separate, explicit call to `set_campaign_status` / `set_adset_status` / `set_ad_status`, so an MCP client shows it as its own confirmation.
> - **Raising a budget** needs `confirm_budget_increase: true`; lowering never does. Optional hard caps `MAX_DAILY_BUDGET_CENTS` / `MAX_LIFETIME_BUDGET_CENTS` are enforced server-side and cannot be overridden from a conversation.
> - Every tool is annotated: `readOnlyHint` on reads (clients such as ChatGPT developer mode auto-approve them), `destructiveHint` on deletes.
> - Meta's rate limits (1 edit per object per 30 s, per-account bursts) are waited out and retried automatically.

### Meta Ads — read

| Tool | What it does |
|---|---|
| `list_ad_accounts` | List ad accounts the token has access to |
| `get_ad_account` | Fetch one ad account's details (balance, currency, spend cap, …) |
| `list_campaigns` | List campaigns inside an ad account, optionally filtered by status |
| `get_campaign` | Fetch one campaign's full configuration |
| `list_adsets` | List ad sets under a campaign or an ad account |
| `get_adset` | One ad set in full: targeting (audiences, exclusions, placements), `promoted_object`, optimization goal, bids, attribution, budgets, learning phase — use before/after `update_adset` |
| `list_ads` | List ads under a campaign, ad set, or ad account |
| `get_insights` | Performance metrics (impressions, clicks, spend, CTR, CPC, CPM, reach, conversions) at any level, with date presets / custom ranges and breakdowns |
| `list_creatives` | List ad creatives inside an ad account |
| `estimate_audience` | Meta's delivery estimate (reach bounds) for a targeting spec — sanity-check before writing |
| `list_custom_audiences` | Custom / Lookalike / website audiences with size estimates and delivery status |
| `get_custom_audience` | One audience in detail incl. rule (pixel + event + retention) and lookalike spec |
| `list_pixels` | Pixels / datasets of an ad account (id for `promoted_object.pixel_id`) |
| `get_pixel_events` | Events the pixel actually received in the last N days, with counts |

### Meta Ads — write & assets

| Tool | What it does |
|---|---|
| `upload_ad_image` | Upload an image (URL or base64) to an ad account's library; returns image hash |
| `list_ad_images` | List images in an ad account's library |
| `upload_ad_video` | Upload a video (URL or base64) to an ad account; returns video id |
| `get_video_processing_status` | Poll Meta's async transcoding status for an uploaded video |
| `list_ad_videos` | List videos uploaded to an ad account |
| `create_ad_creative` | Create an ad creative from a Page post or `object_story_spec` (link_data / video_data) |
| `delete_ad_creative` | Delete an ad creative |
| `create_campaign` ⚠️ | Create a campaign (always `PAUSED`; objective, special_ad_categories, optional campaign budget, `is_adset_budget_sharing_enabled`) |
| `update_campaign` ⚠️ | Update name / budget / bid strategy (budget raise needs `confirm_budget_increase`) |
| `delete_campaign` ⚠️ | **Destructive** — delete a campaign |
| `create_adset` ⚠️ | Create an ad set (always `PAUSED`) with the full targeting spec — geo incl. exclusions, age, gender, locales, interests, custom audiences + exclusions, per-platform positions, Advantage+ audience — plus `promoted_object` (pixel + conversion event), bid strategy, attribution, schedule, EU DSA fields |
| `update_adset` ⚠️ | Update targeting as a **merge** (only the keys you pass change; `targeting_unset` removes keys; `targeting_mode: replace` overwrites), plus name, budget, bid, attribution, schedule. Returns `targeting_before` / `targeting_after`. Optimization goal, billing event and `promoted_object` are locked by Meta after creation |
| `delete_adset` ⚠️ | **Destructive** — delete an ad set |
| `create_ad` ⚠️ | Create an ad bound to an ad set + creative (always `PAUSED`) |
| `update_ad` ⚠️ | Update an ad's name or bound creative |
| `delete_ad` ⚠️ | **Destructive** — delete an ad |
| `set_campaign_status` ⚠️ | The **only** way to activate a campaign (`ACTIVE` / `PAUSED` / `ARCHIVED`) |
| `set_adset_status` ⚠️ | The **only** way to activate an ad set |
| `set_ad_status` ⚠️ | The **only** way to activate an ad |
| `preview_ad` | Render a preview HTML iframe for any placement (DESKTOP_FEED_STANDARD, INSTAGRAM_STANDARD, …) |

### Facebook Pages (read & write)

| Tool | What it does |
|---|---|
| `list_pages` | List Facebook Pages the System User manages |
| `list_page_posts` | List recent posts on a Page (newest first) |
| `get_page_insights` | Page-level metrics (impressions, engagement, follows, page views) |
| `create_page_post` ⚠️ | **Write** — publishes a new post on a Page (text + optional link) |
| `delete_page_post` ⚠️ | **Destructive** — deletes a post from a Page |

### Instagram Business (read & write)

| Tool | What it does |
|---|---|
| `list_instagram_accounts` | List IG Business accounts linked to the managed Pages |
| `list_instagram_posts` | List recent media on an IG account |
| `get_instagram_insights` | Account-level metrics (reach, impressions, profile_views, …) |
| `get_instagram_post_insights` | Per-post metrics (likes, saves, reach, plays for video/reels) |
| `create_instagram_post` ⚠️ | Publish IMAGE / VIDEO / REELS / STORIES (2-phase: container + publish, with FINISHED-polling) |
| `create_instagram_carousel` ⚠️ | Publish a 2–10-item carousel post |
| `delete_instagram_media` ⚠️ | **Destructive** — delete an IG post / reel / story |
| `list_instagram_comments` | List comments on an IG media |
| `reply_instagram_comment` ⚠️ | Reply to a comment |
| `delete_instagram_comment` ⚠️ | **Destructive** — delete a comment |
| `hide_instagram_comment` | Hide / unhide a comment |

### Product Catalogs (read)

| Tool | What it does |
|---|---|
| `list_businesses` | Discover Business Manager accounts via dedup over `/me/adaccounts` + `/me/accounts` (System User tokens get empty `/me/businesses`) |
| `list_product_catalogs` | List catalogs owned by a Business (id, name, vertical, product_count, feed_count) |
| `get_product_catalog` | Single catalog details with business edge |
| `list_product_feeds` | Feeds attached to a catalog with `latest_upload` error/warning counts |
| `list_catalog_products` | Paginated product listing with availability/condition filters (max 100/call, pass `after` cursor for next page) |
| `get_catalog_diagnostics` | Aggregated catalog issues from `/{catalog_id}/diagnostics`; falls back to latest feed-upload error report when empty |

`get_insights` is the workhorse. Examples (in plain English from Claude):

- *"What did we spend in the last 7 days, broken down by campaign?"*
- *"Compare CTR across publisher_platform breakdown for campaign 12345 last month."*
- *"Which ad sets had the worst CPM yesterday?"*

---

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `META_ACCESS_TOKEN` | yes | — | Meta System User token (recommended, never expires) or long-lived user access token. Full v0.4 scopes: `ads_read`, `ads_management`, `business_management`, `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `pages_manage_metadata`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights`, `catalog_management`. Subsets are allowed — missing scopes simply make the matching tools return 403. |
| `META_API_VERSION` | no | `v26.0` | Graph API version |
| `AUTH_TOKEN` | yes | — | Shared bearer secret for `POST /mcp`. Generate with `openssl rand -hex 32` |
| `PUBLIC_URL` | no | `http://localhost:3210` | Public URL (currently informational; v0.2 will use it for OAuth callbacks) |
| `PORT` | no | `3210` | TCP port to bind |
| `LOG_LEVEL` | no | `info` | `debug` / `info` / `warn` / `error` |
| `MAX_DAILY_BUDGET_CENTS` | no | — | Hard cap for any daily budget written by the connector (account currency, cents). Unset = no cap |
| `MAX_LIFETIME_BUDGET_CENTS` | no | — | Hard cap for any lifetime budget written by the connector |

See [`.env.example`](./.env.example).

---

## How is this different from … ?

| | claude-meta-mcp | Windsor.ai | Pipeboard | hashcott/meta-ads-mcp-server |
|---|---|---|---|---|
| Self-hosted | ✓ | ✗ | ✗ | ✓ |
| Remote claude.ai web | ✓ | ✓ | ✓ | partial |
| License | **MIT** | proprietary | BSL 1.1 | MIT |
| Your data leaves your server | ✗ | ✓ | ✓ | ✗ |
| Monthly fee | $0 | from $19 | from $29 | $0 |

<sub>As of May 2026, based on each project's public README and pricing page. Names and trademarks belong to their respective owners; comparison is informational only.</sub>

---

## Architecture (v0.5)

```
┌─────────────────────┐     POST /mcp        ┌──────────────────────────┐
│  Claude.ai / Desktop│ ──────────────────►  │  Express + MCP server    │
│                     │  Bearer AUTH_TOKEN   │  StreamableHTTPTransport │
└─────────────────────┘                      │           │              │
                                             │           ▼              │
                                             │  Meta Graph API client   │
                                             │  (axios, v26.0)          │
                                             └─────────────┬────────────┘
                                                           │
                                                           ▼
                                             https://graph.facebook.com
```

No database. No state between requests. One Meta System User token, one Bearer token, 56 tools.

For sequence diagrams and the planned v1.0 multi-tenant architecture, see [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

---

## Roadmap

**v0.2 — Pages support** ✓ shipped
- [x] `list_pages`, `list_page_posts`, `get_page_insights`, `create_page_post`, `delete_page_post`

**v0.5 — Ad set steering + safety layer** ✓ shipped
- [x] Full targeting spec on create + update (merge / unset / replace), `promoted_object`, DSA fields
- [x] `get_adset`, `estimate_audience`, audience + pixel lookups
- [x] Explicit activation via `set_*_status`, budget-raise confirmation, hard caps, MCP annotations, rate-limit retry

**v0.3 — Ads write + Instagram** ✓ shipped
- [x] Ads CRUD (campaigns, ad sets, ads, creatives)
- [x] Image + video upload
- [x] Instagram Business publishing (image / video / reel / story / carousel)
- [x] Instagram comments (read / reply / delete / hide)

**v0.4 — Product Catalogs (read)** ✓ shipped (current)
- [x] Business discovery via adaccount + page dedup
- [x] Catalog + feed listing, single-catalog detail
- [x] Product listing with availability/condition filters
- [x] `get_catalog_diagnostics` (`/{catalog_id}/diagnostics` + feed-upload fallback)

**v0.5 — Catalog writes + Signal Diagnostics**
- [ ] `create_product_catalog`, `create_product_feed`, `update_product_feed_schedule`
- [ ] Pixel + CAPI health (`list_pixels`, `get_pixel_stats`, `get_pixel_event_match_quality`, `get_capi_status`)

**v0.6 — proper auth**
- [ ] OAuth 2.1 with Dynamic Client Registration on the Claude side
- [ ] `.well-known/oauth-authorization-server` discovery endpoint
- [ ] Token issuance + refresh

**v0.7 — multi-tenant**
- [ ] Meta OAuth user flow + 60-day token refresh
- [ ] SQLite (then Postgres) for user → meta-token mapping
- [ ] AES-256-GCM encryption at rest for stored tokens

**v0.8 — performance**
- [ ] Insights pre-aggregation cache with smart invalidation
- [ ] Background refresh for "yesterday and earlier" data

**v1.0 — production-ready**
- [ ] Audit log, rate limiting per tenant
- [ ] Prometheus `/metrics` endpoint
- [ ] Health checks for downstream Meta API

**Stretch**
- [ ] Google Ads connector under the same umbrella
- [ ] TikTok Ads connector
- [ ] LinkedIn Ads connector

---

## Project layout

```
src/
├── index.ts             Express + MCP bootstrap, Bearer middleware
├── config.ts            Env validation
├── meta-client.ts       Graph API axios wrapper + pagination + multipart helpers
├── tools.ts             Read tools (Ads + Pages)
├── tools-write.ts       Ads write tools (campaigns/ad sets/ads/creatives + asset uploads)
├── tools-instagram.ts   Instagram Business tools (publish + comments + insights)
└── tools-catalogs.ts    Product Catalog read tools (businesses, catalogs, feeds, products, diagnostics)

docs/
├── ARCHITECTURE.md
├── DEPLOYMENT.md
└── META_APP_SETUP.md

ecosystem.config.cjs  pm2 example
.env.example          Configuration template
```

---

## Development

```bash
npm run dev       # tsx watch mode
npm run build     # tsc → dist/
npm start         # node dist/index.js
```

---

## Security notes

- The Bearer token in `AUTH_TOKEN` is a single shared secret. Anyone with it can **mutate ad campaigns, publish/delete posts on your Facebook Pages and Instagram Business accounts, and read your product catalogs** via the connector. Treat it like a database password.
- All write tools that create campaigns/ad sets/ads default to `status: PAUSED`. Activating an ad still costs nothing until you set `status: "ACTIVE"`.
- The connector's scopes are additive. If you only want a read-only Ads experience, omit `ads_management` and the IG/Pages write scopes from your System User token — the matching tools will then fail with 403 at runtime.
- Always run behind HTTPS. Claude refuses to connect to non-TLS connectors anyway.
- Rotate `AUTH_TOKEN` by editing `.env` and restarting the process.
- Rotate `META_ACCESS_TOKEN` by revoking the System User token in Meta Business and minting a new one.

If you find a security issue, please email `security@markusstoeger.com` instead of opening a public issue.

---

## Contributing

PRs welcome. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for ground rules and
[`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md). Security issues should follow
[`SECURITY.md`](./SECURITY.md), not the public issue tracker.

---

## License

[MIT](./LICENSE) © 2026 Markus Stöger

---

## Acknowledgements

Inspired by the open MCP ecosystem and prior art in
[hashcott/meta-ads-mcp-server](https://github.com/hashcott/meta-ads-mcp-server),
[pipeboard-co/meta-ads-mcp](https://github.com/pipeboard-co/meta-ads-mcp),
and the [Model Context Protocol](https://modelcontextprotocol.io/) team.
