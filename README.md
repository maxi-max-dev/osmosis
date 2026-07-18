# Osmosis

Osmosis turns the time you spend waiting for an AI coding agent into short lessons about the technology it is using in your project. It advances AI education for non-technical builders by turning their own projects into the curriculum.

This is a plain JavaScript, local-first MCP server and browser UI built for the OpenAI Build Week Education track.

> Build status: Steps 1–3, 5, and 6 are complete and verified. The app has polished UI, none-provider recording/replay, a static public replay page, and cross-project mastery proof. GPT-5.6 generation remains gated on API billing and the API key.

## Run locally

```bash
cd /Users/max/code/osmosis
npm start
```

Open <http://localhost:4321>. The default provider is `none`, so the first build stage uses a local template lesson and needs no API key.

## Start Codex with Osmosis

Project-level MCP config is not supported by the tested Codex CLI version. Start Codex from the project you want to learn about and pass the MCP server with `-c` overrides:

```bash
cd /Users/max/code/osmosis-demo-a
codex \
  -c 'mcp_servers.osmosis.command="node"' \
  -c 'mcp_servers.osmosis.args=["/Users/max/code/osmosis/server.js"]' \
  -c 'mcp_servers.osmosis.env={OSMOSIS_PROVIDER="none"}'
```

The server inherits that launch directory, so each project keeps its own `.osmosis/` tree and card state while mastery remains user-level.

## Agent instruction

Give any coding agent the root [`AGENTS.md`](AGENTS.md) instruction, which tells it to call `osmosis_report` immediately after every completed milestone and to write reports in English.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `OSMOSIS_PROVIDER` | `none` | `none` is implemented now. `openai` and `codex` are gated Step 4 work; start with `none` until API billing is enabled. |
| `OSMOSIS_MODE` | `live` | `live` creates template lessons; `record` saves report-driven cards; `replay` consumes a local replay fixture in order. |
| `OSMOSIS_PORT` | `4321` | Local HTTP/SSE port. |
| `OSMOSIS_HOST` | `127.0.0.1` | Local bind address. |
| `OPENAI_API_KEY` | unset | Required only by the future `openai` provider; never commit it. |

## Testing

Run the automated local checks:

```bash
cd /Users/max/code/osmosis
npm test
```

The current suite verifies all completed P0 behavior:

- an SSE connection receives a full `snapshot` followed by a template `card`;
- raw MCP `initialize`, `tools/list`, and two sequential `tools/call` requests produce only valid JSON-RPC on stdout;
- a second server instance keeps MCP stdio alive after its HTTP port is guarded, then relays its report to the primary instance;
- `POST /answer` atomically persists `cards.json` and `~/.osmosis/profile.json`, and a reconnecting browser receives the answered state;
- an incorrect answer waits for two other delivered cards before it reappears.
- record mode excludes starter cards and wrong-answer requeues from `.osmosis/replay.json`;
- replay mode uses real reports to emit sanitized recorded cards in order, then finishes calmly when exhausted;
- two distinct project directories sharing one profile prove mastery carry-over: project B shows gold `carried over` state and skips a mastered none-provider concept.

For a quick manual SSE check:

```bash
OSMOSIS_PROVIDER=none npm start
curl -Ns --max-time 5 http://127.0.0.1:4321/events
```

The stream should start with `event: snapshot` and then show `event: card`.

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

Each real `osmosis_report` consumes one replay entry in order and uses the current report as the visible source line. Replay makes zero model calls and returns a calm `replay-complete` status after the final card.

The included [`sanitized-none-replay.json`](fixtures/sanitized-none-replay.json) is an anonymized template-card recording. It is intentionally not GPT-generated; the final submission fixture will be re-recorded with GPT-5.6 only after the live provider is available.

## Replay and public demo

The [static replay page](docs/index.html) is a single deployable file in `docs/`: no API key, local server, or live agent is required. Configure GitHub Pages to deploy the `/docs` directory for a judge-facing URL. Its banner accurately identifies the current fixture as a sanitized `none`-provider recording.

## How Osmosis was built

Codex built all current product code in one primary thread. The gated live stage will use GPT-5.6 for card and tree generation via Structured Outputs. The known limitation is intentional for the hackathon: the local server lives and dies with the Codex session.

The MCP is agent-agnostic even though the demo uses Codex.
