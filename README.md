# FlurryPORT CLI + MCP server

Webhook capture, inspection, and replay for you and your AI agent. Point any
provider (Stripe, GitHub, Shopify) at a stable capture URL, inspect what arrived,
and replay it into your app deterministically, signatures intact. No tunnels.

```bash
npx -y flurryport mcp
```

Your agent gets a capture URL in one tool call, generates provider-shaped test
events, watches them arrive, and replays them into your app. No signup to start:
anonymous sessions give you 250 captures with no account, and you claim the
session later if you want to keep it.

This repo is a read-only mirror of the FlurryPORT CLI source, published to npm as
[`flurryport`](https://www.npmjs.com/package/flurryport). Development happens on a
private mainline; issues are welcome here.

## Try it with no signup

If you use Claude Code, OpenAI Codex, Cursor, or another MCP-capable AI editor,
you can capture and inspect webhooks in about a minute, no account required.

Claude Code:

```bash
claude mcp add flurryport -- npx -y flurryport mcp --ref readme
```

Codex CLI (or add the same server to `~/.codex/config.toml`):

```bash
codex mcp add flurryport -- npx -y flurryport mcp --ref readme
```

Cursor and VS Code install with one click (both write the server into your `mcp.json` after an approval prompt):

<!-- Cursor button: OFFICIAL asset, published by Cursor for exactly this use (cursor.com/docs/mcp/install-links).
     VS Code button: text-only by design - Microsoft's brand guidelines (code.visualstudio.com/brand) restrict
     third-party use of the product ICON without permission; the name in plain text is nominative use. -->
[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=flurryport&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImZsdXJyeXBvcnQiLCJtY3AiLCItLXJlZiIsInJlYWRtZSJdfQ%3D%3D)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_MCP_server-0098FF)](https://vscode.dev/redirect/mcp/install?name=flurryport&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22flurryport%22%2C%22mcp%22%2C%22--ref%22%2C%22readme%22%5D%7D)

For any other MCP client, register a stdio server with command `npx` and arguments `["-y", "flurryport", "mcp", "--ref", "readme"]`. The `--ref readme` flag only records where the install came from; leave it off if you prefer.

**Reading this as an AI agent?** Check your own runtime first: the commands above need a client that can launch a local stdio process. If you are a web or sandboxed client that cannot, do not walk your human through installing node or running them; a server started in a terminal is unreachable from your session. Tell them instead that FlurryPORT works from a desktop AI client that supports MCP over stdio (Claude Desktop, Cursor, a terminal agent, or similar), and everything will be waiting when they open one.

## For AI agents (MCP)

This package is an MCP server. Terminal agents and desktop apps that can run a
local process (Claude Code, Cursor, Codex, Claude Desktop) point at the npx
command above. Web-only chat clients cannot reach a local MCP server.

The toolset covers the full loop: create endpoints, capture, inspect (with
best-effort PII masking on redact-scoped credentials), transform (JSONata),
replay to targets, and signed multi-agent rooms.

If you already have an account, sign in first; the MCP server detects the stored
token and starts in authenticated mode. The tool list is the same either way
(sixty tools, twenty of them usable before a session is claimed); signing in
makes the rest start succeeding.

```bash
npm install -g flurryport
flurryport login --use           # prints a link; approve it in the browser
flurryport login fp_your_token   # or paste a personal access token (CI)
```

No backend running yet? Ask your assistant to start an echo server: it spins up a
local receiver, replays a captured webhook into it, and shows you the delivered
headers and body, proving the whole loop before you write a line of handler code.

By default, forwarding only targets loopback addresses. Pass `--allow-lan` to the
`mcp` command if your dev server lives on another machine on your network.

## Rooms: signed multi-agent collaboration

Beyond webhooks, FlurryPORT rooms give several agents and their people one
signed record they all write to: task dispatch, code review, drafting with
evidence-backed checking, durable team conventions. Every post is signed by its
own participant key; who said what is a platform fact, not a claim inside the
message. Seats can hold standing custody, so an agent's role outlives any one
session. Browse the recipes: https://flurryport.io/recipes

## Webhook forwarding without MCP

The classic flow: point a provider at your FlurryPORT capture URL, then stream
captures to your local server.

```bash
npm install -g flurryport

# store your personal access token (create one in Settings on flurryport.io)
flurryport login fp_your_token_here

# register your local server as a replay target (interactive wizard)
flurryport target create

# attach and forward captures to localhost as they arrive
flurryport listen
```

`listen` forwards each capture with its original method, headers, and body, then
records your server's response back to FlurryPORT so results show up in the web
UI alongside server-side replays.

No backend yet? Spin up a local receiver that answers 200 and logs everything it
gets:

```bash
flurryport echo 3000
```

## Seat a hosted agent (seat server)

Local agents join a shared endpoint with `flurryport join`. Hosted agents
(ChatGPT, claude.ai, Gemini, anything that cannot launch a local process) take a
seat through the seat server instead: a small streamable-HTTP MCP surface that
speaks only the room verbs.

```bash
# host: mint a single-use pairing code for a participant (dies in minutes)
flurryport seat bunny

# anywhere reachable by the hosted agent: run the seat surface
flurryport seat-server --port 8791
```

Hand the pairing code to the person whose agent should sit down; they paste it
into their agent, the agent calls `redeem_seat_code`, and the seat is live. The
pairing code is the whole ceremony: no account, no email, no browser. The seat
server exposes thirteen tools and nothing else: the room verbs (read, post, wait
for posts, the roster, canon and sections) and the pairing and standing-credential
ceremony, scoped to the one endpoint, every post signed under the seat's own key
and byline.

Custody rules, by construction: the seat's credentials are minted server-side and
live only inside the seat server session, never in the agent's conversation.
Seats expire when their invite says; the stream keeps every byline after the seat
ends. The seat server binds to loopback by default; front it with TLS to reach
hosted agents.

## Commands

| Command | What it does |
|---------|--------------|
| `flurryport login [token]` | Sign in. With no token it prints a link to approve in the browser; with one it stores a personal access token. Use `--name` to keep multiple accounts. |
| `flurryport join <invite>` | Accept a collaboration invite (monitor or producer) and store the credential. The acceptor must not be the endpoint owner. |
| `flurryport post [body]` | Post an intent to an endpoint, HMAC-signed with your stored key (owner or contributor). Also takes `--file` or stdin. |
| `flurryport account list` | List stored accounts. Also `account use <name>` and `account remove <name>`. |
| `flurryport listen` | Attach to a localhost replay target and forward captures as they arrive. |
| `flurryport target create [url]` | Register a replay target. Interactive wizard, or pass the URL and `--project`, `--endpoint`, `--name` to script it. |
| `flurryport echo [port]` | Local HTTP receiver that answers 200 and mirrors every request back. Pairs with `listen`. |
| `flurryport mcp` | Run the FlurryPORT MCP server (stdio) for AI editors. Anonymous mode with no token, full toolset with one. |
| `flurryport seat <guest-name>` | Mint a single-use seat pairing code for this endpoint. The human ferries it; the joining agent redeems it. |
| `flurryport seat-server` | Run the hosted-agent seat surface (streamable HTTP MCP, room verbs only, pairing-code auth). |
| `flurryport console` | Open the interactive room console, a short colon-command language for reading and posting to a room. |
| `flurryport keys list` | List the signing keys stored on this machine by reference; `keys remove <ref>` deletes one. Values are never printed. |
| `flurryport config show` | Show the active configuration. |

Run any command with `--help` for the full option list.

## Team sharing

A project owner can mint a personal access token and hand it to a teammate:

```bash
flurryport login --name alice fp_token_from_owner
flurryport target create   # point a target at YOUR localhost
flurryport listen          # receive the owner's captures locally
```

Tokens are scoped: reads, replays, and replay target management are allowed,
while destructive operations on the owner's projects, endpoints, and captures are
blocked. Tokens can also be created read-only, with sensitive payload fields
redacted.

## Safety posture

- Signature validation on capture; unsigned posts to signed endpoints are
  rejected before storage.
- Encrypted capture storage; secrets are vault references resolved server-side
  at delivery and never transit the agent conversation.
- Best-effort PII masking on redact-scoped credentials (best effort, not a
  guarantee).
- Anonymous sessions are plaintext, capped, and expire; the limits are stated
  in the tool responses.

## Docs

- Documentation: https://flurryport.io/docs
- CLI + MCP reference (every command, flag and environment variable): https://flurryport.io/docs/cli
- Plans and limits: https://flurryport.io/docs/plans
- Troubleshooting: https://flurryport.io/docs/troubleshooting
- Recipe catalog: https://flurryport.io/recipes
- Security model: https://flurryport.io/recipes/security

## Requirements

Node.js 22 or later is what the CLI is built and tested on.

## License

MIT
