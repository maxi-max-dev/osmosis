# Osmosis

Osmosis turns the time you spend waiting for an AI coding agent into short lessons about the technology it is using in your project. It advances AI education for non-technical builders by turning their own projects into the curriculum.

This is a plain-JavaScript, local-first MCP server and browser UI built for the OpenAI Build Week Education track.

> Build status: Steps 1–3, 5, and 6 are complete and verified. The app has polished UI, none-provider recording/replay, a static public replay page, and cross-project mastery proof. GPT-5.6 generation remains gated on API billing and an API key.

## Requirements and local run

- Node.js 20 or later
- No runtime package installation: the app uses Node's built-in modules only

```bash
cd /Users/max/code/osmosis
npm start
```

Open <http://localhost:4321>. The default provider is `none`, so it needs no API key and uses a local template lesson. In this temporary provider mode, Osmosis intentionally does not infer or grow a project tree; live GPT card and tree generation belongs to the gated Step 4 provider.

## Start Codex with Osmosis

Project-level MCP config is not supported by the tested Codex CLI version. Start Codex from the project you want to learn about and pass the MCP server with `-c` overrides:

```bash
cd /Users/max/code/osmosis-demo-a
codex \
  -c 'mcp_servers.osmosis.command="node"' \
  -c 'mcp_servers.osmosis.args=["/Users/max/code/osmosis/server.js"]' \
  -c 'mcp_servers.osmosis.env={OSMOSIS_PROVIDER="none"}'
```

The server inherits that launch directory, so each project keeps its own `.osmosis/` card and tree state while mastery remains user-level.

## Agent instruction

Copy or merge the root [AGENTS.md](AGENTS.md) into the **target project** that Codex will work in. The Osmosis repository's own AGENTS file is a template; it is not automatically read when Codex is launched from another project.

For each completed milestone, the agent must call this tool before starting the next one:

```text
osmosis_report({
  task: "M1 — Browser shell",
  what_i_did: "Built the browser shell and verified its responsive layout.",
  stack_hints: ["HTML", "CSS", "responsive design"]
})
```

Use one report per completed milestone. Every field is English. Do not batch milestones or report planned/in-progress work. The MCP acknowledgement is immediate and non-blocking.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `OSMOSIS_PROVIDER` | `none` | `none` is implemented now. `openai` and `codex` are Step 4-gated; start with `none` until billing is enabled. |
| `OSMOSIS_MODE` | `live` | `live` creates template lessons; `record` saves report-driven cards; `replay` consumes a local replay fixture in order. |
| `OSMOSIS_PORT` | `4321` | Local HTTP/SSE port. Set `0` only when an isolated test needs an OS-assigned free port. |
| `OSMOSIS_HOST` | `127.0.0.1` | Local bind address. |
| `OSMOSIS_PROFILE_DIR` | `~/.osmosis` | User-level mastery directory. Point this at an isolated directory for demos/tests, or share it to prove cross-project mastery. |
| `OSMOSIS_TEMPLATE_DELAY_MS` | `900` | Delay before the local `none` starter lesson; useful for development and tests. |
| `OPENAI_API_KEY` | unset | Required only by the future `openai` provider; never commit it. |

Local data stays local: `~/.osmosis/profile.json` holds user-level mastery; the target project's `.osmosis/tree.json`, `cards.json`, and `replay.json` hold project-level state. They are private/ignored. Only the sanitized replay fixture in this repository is intended to ship.

## Testing

Run the automated local checks:

```bash
cd /Users/max/code/osmosis
npm test
```

Each test uses an OS-assigned port and a self-contained teardown: SSE readers close first, child servers close next, and temporary project data is removed last. The suite exits naturally. On 2026-07-18, three consecutive full runs passed in about 2.5 seconds each.

The suite verifies all completed P0 behavior:

- an SSE connection receives a full `snapshot` followed by a template `card`;
- raw MCP `initialize`, `tools/list`, and two sequential `tools/call` requests produce only valid JSON-RPC on stdout;
- a second server instance keeps MCP stdio alive after its HTTP port is guarded, then relays its report to the primary instance;
- `POST /answer` atomically persists `cards.json` and `~/.osmosis/profile.json`, and a reconnecting browser receives the answered state;
- an incorrect answer waits for two other delivered cards before it reappears;
- record mode excludes starter cards and wrong-answer requeues from `.osmosis/replay.json`;
- replay mode uses real reports to emit sanitized recorded cards in order, then finishes calmly when exhausted;
- two distinct project directories sharing one profile prove mastery carry-over: project B shows gold `carried over` state and skips a mastered none-provider concept.

For a quick manual SSE check:

```bash
OSMOSIS_PROVIDER=none npm start
curl -Ns --max-time 5 http://127.0.0.1:4321/events
```

The stream starts with `event: snapshot` and then shows `event: card`.

## Night 1 gate: operator-run Codex proof

This proof passed in an independent mounted demo session on 2026-07-18: the expected cwd, source-linked SSE card, answer/reload persistence, clean stdout, and ordered M1/M2/M3 reports all passed. The production build thread deliberately does **not** mount Osmosis itself.

In a separate terminal, start a disposable Codex session from the demo project:

```bash
mkdir -p /Users/max/code/osmosis-demo-a
cd /Users/max/code/osmosis-demo-a
codex \
  -c 'mcp_servers.osmosis.command="node"' \
  -c 'mcp_servers.osmosis.args=["/Users/max/code/osmosis/server.js"]' \
  -c 'mcp_servers.osmosis.env={OSMOSIS_PROVIDER="none"}'
```

Then ask Codex to complete a tiny task in exactly three milestones, calling `osmosis_report` in English immediately after M1, M2, and M3. Keep the session open and run:

```bash
curl -fsS http://127.0.0.1:4321/health
curl -fsS http://127.0.0.1:4321/debug/reports
```

The expected proof is: the health response names `/Users/max/code/osmosis-demo-a` as `processCwd`; one explicit report produces a browser card; two consecutive calls have no stdout corruption; and `/debug/reports` shows M1, M2, M3 in order.

## Record and replay

Record a clean, report-driven local session with no starter card:

```bash
OSMOSIS_PROVIDER=none OSMOSIS_MODE=record npm start
```

Every real report card is appended atomically to `./.osmosis/replay.json`. The recording stores only durable generated card fields and the report trigger—never runtime card IDs, answer state, or user profile data.

To replay a fixture, place one at `./.osmosis/replay.json` and start in replay mode:

```bash
mkdir -p .osmosis
cp fixtures/sanitized-none-replay.json .osmosis/replay.json
OSMOSIS_PROVIDER=none OSMOSIS_MODE=replay npm start
```

Each real `osmosis_report` consumes one replay entry in order and uses the current report as the visible source line. Replay makes zero model calls and returns a calm `replay-complete` status after the final card. The submission video runs in `replay` mode.

The included [sanitized-none-replay.json](fixtures/sanitized-none-replay.json) is an anonymized template-card recording. It is intentionally not GPT-generated; the final submission fixture will be re-recorded with GPT-5.6 only after the live provider is available.

## Replay and public demo

The [static replay page](docs/index.html) is a single deployable file in `docs/`: no API key, local server, or live agent is required. Configure GitHub Pages to deploy the `/docs` directory for a judge-facing URL. Its banner accurately identifies the current fixture as a sanitized `none`-provider recording. No public judge URL is claimed until a remote repository and GitHub Pages deployment exist.

## How Osmosis was built

Codex built all current product code in one primary thread. When the API billing gate is cleared, the live stage will use GPT-5.6 Structured Outputs for card and tree generation. The known limitation is intentional for the hackathon: the local server lives and dies with the Codex session.

The MCP is agent-agnostic even though the demo uses Codex.
