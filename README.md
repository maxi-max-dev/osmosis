# Osmosis

Osmosis turns the time you spend waiting for an AI coding agent into short lessons about the technology it is using in your project. It advances AI education for non-technical builders by turning their own projects into the curriculum.

This is a plain-JavaScript, local-first MCP server and browser UI built for the OpenAI Build Week Education track.

> Build status: Steps 1–3, 5, and 6 are complete and verified. Step 4 now has a provider-neutral curriculum pipeline plus a local Codex generator. The OpenAI API backend remains gated on API billing and an API key.

## Requirements and local run

- Node.js 20 or later
- No runtime package installation: the app uses Node's built-in modules only

```bash
# From the cloned Osmosis repository root
npm start
```

Open <http://localhost:4321>. The default provider is `none`, so it needs no API key and uses a local template lesson. In this temporary provider mode, Osmosis intentionally does not infer or grow a project tree; live curriculum card and tree generation belongs to the Step 4 providers.

## Use the local Codex provider

When the Codex CLI is installed and authenticated locally, use its read-only generator without an OpenAI API key:

```bash
OSMOSIS_PROVIDER=codex npm start
```

For the first report, Osmosis runs Codex once to build the initial 12–14-node project tree and once to make the first card. Later reports make one card at a time. Each call runs `codex exec --skip-git-repo-check --sandbox read-only` with a 60-second timeout, receives strict JSON, and retries once silently before skipping a failed lesson. This provider is intentionally slower; the page shows `Generating (this provider is slower).` while it works. It uses the locally signed-in Codex account/credits, not `OPENAI_API_KEY`.

## Start Codex with Osmosis

Project-level MCP config is not supported by the tested Codex CLI version. Start Codex from the project you want to learn about and pass the MCP server with `-c` overrides. The following assumes the clone and the demo project are sibling directories:

```bash
# From the cloned Osmosis repository root
export OSMOSIS_ROOT="$PWD"
mkdir -p ../osmosis-demo-a
cd ../osmosis-demo-a
codex \
  -c 'mcp_servers.osmosis.command="node"' \
  -c "mcp_servers.osmosis.args=[\"$OSMOSIS_ROOT/server.js\"]" \
  -c 'mcp_servers.osmosis.env={OSMOSIS_PROVIDER="none"}'
```

The server inherits that launch directory, so each project keeps its own `.osmosis/` card and tree state while mastery remains user-level.

## Experimental: inline MCP Apps

The browser learning wall remains Osmosis's primary form. An optional experimental MCP Apps surface can also place the newest unanswered lesson directly in the Codex desktop conversation flow.

MCP Apps support is under development in Codex and is off by default. Enable the feature, then fully restart the Codex desktop app before launching Codex with the normal Osmosis MCP configuration:

```bash
codex features enable enable_mcp_apps
```

When the host supports it, the `osmosis_report` response points to a dynamic local `ui://osmosis/card.html` resource. It shows the newest unanswered lesson, its provenance line, three answer choices, and the current tree/queue progress. The report acknowledgement remains non-blocking, so a slow provider can briefly show the calm empty state before its first card is generated; that empty iframe silently refreshes the loopback `/inline-card` view every 2.5 seconds until a real lesson is ready.

The iframe uses only loopback endpoints: it refreshes `GET /inline-card` while waiting, then attempts to save an answer with `POST http://127.0.0.1:4321/answer` (or the configured local port). They deliberately permit permissive CORS, including private-network preflight, so a sandboxed local tool can reach them. This is an intentional local-tool tradeoff; the primary browser wall does not depend on MCP Apps. If the host rejects the answer connection or CSP allowance, the inline card shows local right/wrong feedback and the explicit fallback note `answer synced on your wall only` rather than claiming that a mastery update was saved.

## Ambient Watch

Ambient Watch fills the wait window without relying on an agent to remember `osmosis_report`. When a local Codex sessions directory is available, the HTTP-owning Osmosis server polls the current Codex rollout logs and turns newly appended tool activity into an observed lesson while the agent is still working. It attaches at the end of each active log, so it never replays earlier session history.

It observes local event metadata only: command and tool names, the working-directory/project label, changed file basenames and extensions, and MCP `server.tool` names. It never reads project-file contents. The watcher ignores the `osmosis` MCP server itself, so it cannot create a feedback loop. The raw rollout logs remain local; Ambient Watch does not transmit them or project contents. In `none` mode its observed metadata stays on the machine; replay mode leaves Ambient Watch off to preserve deterministic judging. Any configured generator provider has its own documented request path.

Ambient Watch is automatic when `~/.codex/sessions` exists. Disable it completely with:

```bash
OSMOSIS_AMBIENT=0 npm start
```

Use `OSMOSIS_SESSIONS_DIR` to point at an isolated local sessions directory for a demo or test. The watcher runs only in the server instance that owns the local HTTP wall, which prevents a port-guarded MCP-only instance from producing duplicate cards.

Every lesson states where it came from: **Reported by agent** means the agent explicitly called `osmosis_report`; **Observed change** means Ambient Watch synthesized the lesson from local Codex event metadata. These labels are shown both on the browser wall and, when available, the experimental inline card. Observed lessons are intentionally phrased around the concrete tool or technology seen in the event, not an inferred project story.

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
| `OSMOSIS_PROVIDER` | `none` | `none` is the default template mode. `codex` is implemented with the local read-only Codex CLI. `openai` keeps the same interface but awaits API billing/key activation. |
| `OSMOSIS_MODE` | `live` | `live` runs the selected provider; `record` saves report-driven cards; `replay` consumes a local replay fixture in order. |
| `OSMOSIS_PORT` | `4321` | Local HTTP/SSE port. Set `0` only when an isolated test needs an OS-assigned free port. |
| `OSMOSIS_HOST` | `127.0.0.1` | Local bind address. |
| `OSMOSIS_PROFILE_DIR` | `~/.osmosis` | User-level mastery directory. Point this at an isolated directory for demos/tests, or share it to prove cross-project mastery. |
| `OSMOSIS_SESSIONS_DIR` | `~/.codex/sessions` | Local Codex rollout-log root used by Ambient Watch. Point it at an isolated local directory for demos/tests. |
| `OSMOSIS_AMBIENT` | enabled when the sessions directory exists | Set to `0` to disable Ambient Watch entirely. |
| `OSMOSIS_AMBIENT_EMIT_INTERVAL_MS` | `45000` | Minimum per-session interval between observed reports after the first fast report. |
| `OSMOSIS_TEMPLATE_DELAY_MS` | `900` | Delay before the local `none` starter lesson; useful for development and tests. |
| `OSMOSIS_CARD_PACING_MS` | `12000` | Minimum spacing between delivered live curriculum cards after the first card. |
| `OSMOSIS_UNANSWERED_CARD_CAP` | `5` | Maximum unanswered live curriculum cards before generation pauses and marks the direct concept as surfaced. |
| `OSMOSIS_CODEX_COMMAND` | `codex` | Local Codex executable used by the `codex` provider. |
| `OSMOSIS_CODEX_TIMEOUT_MS` | `60000` | Per-attempt timeout for a `codex exec` generation call. |
| `OPENAI_API_KEY` | unset | Required only by the future `openai` provider; never commit it. |

Local data stays local: `~/.osmosis/profile.json` holds user-level mastery; the target project's `.osmosis/tree.json`, `cards.json`, and `replay.json` hold project-level state; and Codex's own rollout logs live below `~/.codex/sessions`. They are private/ignored. Only the sanitized replay fixture in this repository is intended to ship.

## Testing

Run the automated local checks:

```bash
# From the cloned Osmosis repository root
npm test
```

Each test uses an OS-assigned port and a self-contained teardown: SSE readers close first, child servers close next, and temporary project data is removed last. The suite exits naturally.

The suite verifies all completed P0 behavior:

- an SSE connection receives a full `snapshot` followed by a template `card`;
- raw MCP `initialize`, `tools/list`, `resources/read`, and sequential `tools/call` requests produce only valid JSON-RPC on stdout; inline resources expose the newest unanswered card or a calm empty state with localhost CSP metadata;
- a second server instance keeps MCP stdio alive after its HTTP port is guarded, then relays its report to the primary instance;
- `POST /answer` atomically persists `cards.json` and `~/.osmosis/profile.json`, includes the local iframe CORS response headers, and a reconnecting browser receives the answered state;
- an incorrect answer waits for two other delivered cards before it reappears;
- Ambient Watch attaches to the current end of fake local rollout logs, groups metadata-only tool and patch signals at the configured interval, ignores Osmosis's own MCP calls, runs only in the HTTP owner, and shuts down without retained timers;
- record mode excludes starter cards and wrong-answer requeues from `.osmosis/replay.json`;
- replay mode uses real reports to emit sanitized recorded cards in order, then finishes calmly when exhausted;
- two distinct project directories sharing one profile prove mastery carry-over: project B shows gold `carried over` state and skips a mastered none-provider concept;
- the Codex provider starts without a template starter, builds the first validated tree, returns a source-linked strict-schema card, and keeps Codex stdout out of the MCP protocol.

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
# From the cloned Osmosis repository root
export OSMOSIS_ROOT="$PWD"
mkdir -p ../osmosis-demo-a
cd ../osmosis-demo-a
codex \
  -c 'mcp_servers.osmosis.command="node"' \
  -c "mcp_servers.osmosis.args=[\"$OSMOSIS_ROOT/server.js\"]" \
  -c 'mcp_servers.osmosis.env={OSMOSIS_PROVIDER="none"}'
```

Then ask Codex to complete a tiny task in exactly three milestones, calling `osmosis_report` in English immediately after M1, M2, and M3. Keep the session open and run:

```bash
curl -fsS http://127.0.0.1:4321/health
curl -fsS http://127.0.0.1:4321/debug/reports
```

The expected proof is: the health response names the current demo directory (`$PWD`) as `processCwd`; one explicit report produces a browser card; two consecutive calls have no stdout corruption; and `/debug/reports` shows M1, M2, M3 in order.

## Record and replay

Record a clean, report-driven local session with no starter card:

```bash
OSMOSIS_PROVIDER=none OSMOSIS_MODE=record npm start
```

Every real report card is appended atomically to `./.osmosis/replay.json`. The recording stores only durable generated card fields and the report trigger—never runtime card IDs, answer state, or user profile data.

To replay a fixture, place one at `./.osmosis/replay.json` and start in replay mode:

```bash
mkdir -p .osmosis
cp fixtures/sanitized-codex-replay.json .osmosis/replay.json
OSMOSIS_PROVIDER=none OSMOSIS_MODE=replay npm start
```

Each real `osmosis_report` consumes one replay entry in order and uses the current report as the visible source line. Replay makes zero model calls and returns a calm `replay-complete` status after the final card. The submission video runs in `replay` mode.

The included [sanitized-codex-replay.json](fixtures/sanitized-codex-replay.json) was recorded from a real Codex-provider session (`OSMOSIS_PROVIDER=codex`), replayed for deterministic judging. It contains five report-driven Sydney Harbour lessons and the real 13-node knowledge tree; it has been reviewed to exclude local paths, credentials, browser traces, and personal data.

## Replay and public demo

The [static replay page](docs/index.html) is a single deployable file in `docs/`: no API key, local server, or live agent is required. Configure GitHub Pages to deploy the `/docs` directory for a judge-facing URL. It renders the real Codex-provider fixture tree and cards, plus a separately sanitised Project B tree where `Animation loop` is visibly gold `CARRIED OVER` from the shared profile while only the new `Ferry movement` card is recorded. No public judge URL is claimed until a remote repository and GitHub Pages deployment exist.

## Known limitation

Run one Osmosis-enabled project at a time. Concurrent projects can relay reports to the same localhost HTTP owner and mix project state; this version does not isolate them.

## What's next

- **MCP Apps inline hardening:** keep the experimental inline card current as the under-development Codex host interface matures, then package it with the runner.
- **Plugin distribution:** package an npm runner and plugin shell so installation is repeatable and the Codex child-process cwd trap is contained.
- **Ambient Watch hardening:** validate rollover-log observation across additional Codex desktop releases and refine metadata-only signal grouping without weakening provenance or privacy guarantees.

## How Osmosis was built

Codex built all current product code in one primary thread. The current `codex` provider uses local read-only `codex exec` for strict card and tree generation; when the API billing gate is cleared, the `openai` backend will use GPT-5.6 Structured Outputs through the same curriculum interface. The known limitation is intentional for the hackathon: the local server lives and dies with the Codex session.

The MCP is agent-agnostic even though the demo uses Codex.
