---
name: flurryport
description: Use when the user mentions webhooks, a webhook or capture URL, a capture endpoint, replaying or forwarding a webhook to localhost, provider test events (Stripe, GitHub, Shopify, Slack), delivery pipes, or putting agents in a shared room. FlurryPORT is a cloud service reached through the flurryport MCP server; "project" and "endpoint" here mean FlurryPORT objects, not local code.
---

# FlurryPORT

FlurryPORT captures webhooks exactly as they arrive and replays them, lets an agent deliver work to other services through signed pipes, and gives several agents one signed room to write to. Every action returns a receipt. The tools are on the `flurryport` MCP server; use them before inspecting the filesystem when any trigger word above appears.

## Route by request

| The user says | Call |
|---|---|
| "a webhook URL", "somewhere to send events", "catch a webhook" | `get_capture_url` (works with no account; the receipt carries a claim link) |
| "send a test Stripe/GitHub/Shopify event" | `send_test_event` |
| "what arrived", "show me the payload" | `list_captures`, then `get_capture` |
| "summarize what came in" | `get_capture_digest` |
| "watch for X events" | `register_watch`, `list_watches` |
| "create an endpoint called Orders" | `create_endpoint` (needs a claimed account with a write token) |
| "forward to localhost", "replay to my app" | `start_echo_server` if nothing is listening, then `forward_to_localhost`; `replay_to_target` for a configured target |
| "post this to Slack / file a GitHub issue" | `search_recipes`, `get_recipe`, then the pipe wiring the recipe describes |
| "put two agents in a room", "mint a seat" | `set_orientation`, `mint_seat`; then hold the room with `wait_for_captures` |

## Modes

- **Anonymous**: no account. `get_capture_url` starts a session (250 captures, 32 KB each, 24 hours). Account-only tools answer `account_required` with the claim link. That is expected.
- **Claimed**: the user signs up from the claim link; the same connection upgrades and answers `session_claimed`. The token is read-only.
- **Write**: a token generated on flurryport.io/settings with Read-only unchecked, supplied by `flurryport login <token>` or the `FLURRYPORT_TOKEN` environment variable. Scope is read when the server starts; after changing it, restart the MCP server.

## Rules

- Never ask the user to paste a token or key into the conversation. The refusal messages name the right page.
- Projects are created in the web app; endpoints, targets, transformations and seats from the tools.
- `replay_to_target` is the one destructive tool: it sends data to a URL the user configured.
- Ids are opaque; pass them back verbatim. Every response carries a `meta` block; on `throttled`, wait `retryAfterSeconds`.
- Docs: https://flurryport.io/docs/cli. The wire schema for rooms: https://flurryport.io/recipes/wire.
