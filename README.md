# Osmosis

Osmosis builds a living map of the project concepts your AI surfaces—and what you have demonstrated you understand—then uses the agent’s wait time for short lessons that add evidence to that map.

This is a plain-JavaScript, local-first MCP server and browser UI built for the OpenAI Build Week Education track.

> **Build status**
>
> - **Verified:** the local MCP server, browser Learning Studio, project-channel broker, shared cross-project mastery, record/replay fixtures, experimental Ambient Watch, experimental inline MCP Apps, and the local read-only Codex card/tree generator.
> - **Pending:** the direct `openai` provider interface is reserved, but its generation backend is not yet implemented. Once implemented, it would additionally need verified API billing and an `OPENAI_API_KEY` before it could generate lessons.

## The problem: comprehension debt

AI coding agents can finish a feature while a non-technical builder waits, leaving them with working code but no mental model of what it does. This is now commonly described as **comprehension debt**: the widening gap between the code a system contains and the code a human genuinely understands. [O'Reilly Radar's explanation of comprehension debt](https://www.oreilly.com/radar/comprehension-debt-the-hidden-cost-of-ai-generated-code/) is the framing Osmosis is built around.

The risk is measurable, not just anecdotal. In [Anthropic's randomized study](https://www.anthropic.com/research/AI-assistance-coding-skills), 52 mostly junior software engineers learning a new Python library scored 17% lower on an immediate comprehension quiz when using AI assistance than when coding by hand. Osmosis uses the agent's wait time to turn the work itself into short retrieval questions, so the owner builds a usable model of the technology while the project moves forward.

## Adjacent tools

**Aisance** is a PR-merge gate aimed at engineers. **[learn-codebase](https://github.com/ktaletsk/learn-codebase)** is a manually invoked Socratic codebase tutor for engineers. Osmosis instead triggers automatically during the non-technical builder's wait time, serves multiple-choice cards, and remembers mastery across projects.

## Quick start — one command

```bash
npx github:maxi-max-dev/osmosis
```

For this GitHub `npx` path, install Git and Node.js 20 or later first. On an interactive first run, Osmosis asks the required question below; answer `y` here to mount it into Codex and enable the full experience while Codex works:

```text
Mount Osmosis into your Codex so lessons appear while it works? (y/n)
```

Without Codex, Osmosis still opens the local browser wall with template lessons. If you prefer not to use `npx`, download the repository ZIP, extract it, then run the normal local fallback from its root:

```bash
npm start
```

## Requirements and local run

- Node.js 20 or later
- No runtime package installation: the app uses Node's built-in modules only

```bash
# From the cloned Osmosis repository root
npm start
```

Open <http://localhost:4321>. The default provider is `none`, so it needs no API key and uses a local template lesson. In this temporary provider mode, Osmosis intentionally does not infer or grow a project tree; live curriculum card and tree generation belongs to the active generator providers.

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

The server resolves the nearest Git root as the project channel (or preserves an existing nested `.osmosis/` directory from an earlier Osmosis install). A browser wall owner is a local broker: it keeps each project's cards/tree under that project's `.osmosis/`, while user-wide mastery, the project registry, and activity ledgers live under `~/.osmosis/`. A second Codex project can safely register with the owner instead of mixing into the first project's wall.

## Project channels

One local wall can broker several Osmosis-enabled projects. Once you choose **Carry**, the first project is hydrated immediately; other registered projects are summaries until you open their tab, keeping an old project from doing unnecessary provider work. Each tab has its own card queue and tree, while the shared mastery profile makes only deliberately global starter concepts carry gold mastery across projects.

Browser-wall pacing is per channel: work in Project A never inserts a cross-project gap before Project B's next card. A user-level interruption throttle is deliberately reserved for a future notification adapter; it is a documented no-op in this browser-only release. Shared `profile.json` updates use a Node-core cross-process lock around read-modify-write, so concurrent answers and owner takeover preserve monotonic mastery and counters.

The relay performs a local registration handshake before forwarding a report. It sends the canonical project root exactly once to receive an ephemeral capability token; subsequent relay requests carry only the opaque project id and token. This prevents a report request from choosing a filesystem path or another project's channel.

Project summaries are persisted at `~/.osmosis/projects.json`. Per-project activity traces are durable, bounded JSONL files at `~/.osmosis/ledger/<project-id>.jsonl`; they explain whether a report was accepted, waiting, skipped, failed, or delivered. Archive hides an old project from the main tab rail without deleting its state; a restore control keeps it recoverable, and dormant channels automatically collapse into the archived group after 30 days. New activity unarchives a channel with a ready badge but never steals the active tab.

## Answer integrity and deliberate recovery

Every successful real-card answer now leaves an immutable, local answer receipt at `~/.osmosis/receipts/<project-id>.jsonl` (or under `OSMOSIS_PROFILE_DIR`). It contains only stable answer evidence: receipt id, project/card/concept ids, selected option, correctness, and resulting mastery/counter values. The server returns success only after the shared profile, the project card state, and this receipt are durable. Receipts are separate from the bounded six-state activity ledger, so an old activity/delivery entry is never treated as proof that somebody answered a card. The specific cause of the pre-receipt historical regression remains undetermined; the safeguards and recovery path are evidence-based rather than an attribution or automatic backfill.

For a confirmed historical regression, stop **every** Osmosis wall/relay process first. Inspect the exact receipt and obtain operator approval, then run this one-time, receipt-only restore from the cloned repository root:

```bash
node bin/osmosis-recover-answer.js --receipt <receipt-id> --confirm
```

Answers from before receipts existed require a separate, fully specified historical declaration after Max has reviewed the evidence. It is still not a ledger backfill: the operator must state the exact ids and outcome, then explicitly confirm it:

```bash
node bin/osmosis-recover-answer.js \
  --manual --project <project-id> --card <card-id> --concept <concept-id> \
  --chosen-index <0-2> --correct --strength 2 --confirm
```

Set `OSMOSIS_PROFILE_DIR` (or pass `--profile-dir <directory>`) for an isolated profile. Both paths verify the exact registered project plus card/concept ids, refuse conflicting current answers, restore monotonic profile strength, persist the reviewed evidence as an immutable receipt, and record that the receipt was consumed so it cannot be applied twice. Neither path guesses from a delivery ledger, runs automatically, or should be used before the historical evidence has been reviewed.

## Learning Studio (Stage 1)

The browser wall is now a focused Learning Studio: one **Now** question, a quiet prepared **Next** lesson, and a review trail of lessons you have already answered. Project tabs keep their own learning trail and ready badge; changing a tab is always your choice, and each channel can be deep-linked from the URL. Optional auto-advance only moves forward when a prepared next lesson exists, pauses when you interact, and never removes the **Next** control.

The first time a project reaches Osmosis, the Studio asks for three choices and saves them in `~/.osmosis/settings.json`:

- **Global learning — On or Paused.** Paused stops new lesson work without deleting the projects, trail, or review history you already have.
- **Carry this project — Carry or Don't carry.** Carry is the explicit decision that registers the project as a Studio channel and lets it participate in shared mastery. Don't carry keeps ambient activity from creating project learning state. Explicit agent reports wait for an activation decision instead of silently becoming a lesson.
- **Capture — Agent reports only or + experimental Ambient Watch.** The first mode teaches only from explicit `osmosis_report` milestones. The second also permits the local experimental observer described below, with its provenance labels kept visible.

The activation flow also records English or Simplified Chinese as your lesson preference. Stage 1 persists that preference; locale-aware bite-size lesson content arrives in Stage 2, so current generated cards remain provider-controlled. You can revisit the global and project choices from Studio settings at any time.

## Experimental: inline MCP Apps

The browser learning wall remains Osmosis's primary form. An optional experimental MCP Apps surface can also place the newest unanswered lesson directly in the Codex desktop conversation flow.

MCP Apps support is under development in Codex and is off by default. Enable the feature, then fully restart the Codex desktop app before launching Codex with the normal Osmosis MCP configuration:

```bash
codex features enable enable_mcp_apps
```

When the host supports it, the `osmosis_report` response points to a dynamic local `ui://osmosis/card.html` resource. It shows the newest unanswered lesson, its provenance line, three answer choices, and the current tree/queue progress. The report acknowledgement remains non-blocking, so a slow provider can briefly show the calm empty state before its first card is generated; that empty iframe silently refreshes the loopback `/inline-card` view every 2.5 seconds until a real lesson is ready.

The iframe uses only loopback endpoints: it refreshes `GET /inline-card` while waiting, then attempts to save an answer with `POST http://127.0.0.1:4321/answer` (or the configured local port). They deliberately permit permissive CORS, including private-network preflight, so a sandboxed local tool can reach them. This is an intentional local-tool tradeoff; the primary browser wall does not depend on MCP Apps. If the host rejects the answer connection or CSP allowance, the inline card shows local right/wrong feedback and the explicit fallback note `answer synced on your wall only` rather than claiming that a mastery update was saved.

## Ambient Watch

Ambient Watch is an **experimental opt-in** that fills the wait window without relying on an agent to remember `osmosis_report`. Enable it explicitly with `OSMOSIS_AMBIENT=1`. The HTTP-owning Osmosis server tails newly appended records from active local Codex rollout JSONL files and can turn qualifying activity into a lesson while the agent is still working. It attaches at the end of logs that already exist when the watcher starts, so it does not replay earlier session history.

Ambient Watch reads raw rollout records locally, then derives a small, sanitized metadata set: allowlisted command/tool technologies, file extensions, known frameworks, and the session working directory used for project matching. The watcher ignores the `osmosis` MCP server and its isolated generator marker to avoid feedback loops. Raw rollout records stay local; the implemented `codex` provider may receive the sanitized metadata needed to generate a lesson, while the reserved `openai` interface does not make API calls yet. In `none` mode it stays on the machine. Record and replay modes leave Ambient Watch off for deterministic fixtures.

Ambient observation never registers a project by itself. Only a runner/MCP registration can create a channel; an observed unknown root produces a sanitized `suppressed` trace in the user-level `unregistered` ledger, with no new tab or project-state write.

The current rollout-tailing mechanism is deliberately experimental. `PostToolUse` lifecycle hooks are the production roadmap once Codex exposes a stable, verified desktop contract; see [the Ambient Capture spike note](docs/ambient-capture-spike.md). To enable the experiment:

```bash
OSMOSIS_AMBIENT=1 npm start
```

`OSMOSIS_SESSIONS_DIR` selects an isolated local sessions directory for a demo or test. Without it, the default is `$CODEX_HOME/sessions` when `CODEX_HOME` is set, otherwise `~/.codex/sessions`. The watcher runs only in the server instance that owns the local HTTP wall, which prevents a port-guarded MCP-only instance from producing duplicate cards. A port-loser retries ownership about every 15 seconds; after takeover it refreshes the project's persisted state before accepting local writes and only then starts Ambient Watch.

Every lesson states where it came from: **Reported by agent** means the agent explicitly called `osmosis_report`; **Observed change** is reserved for a successful patch event; and **Observed activity** covers allowlisted exec or non-Osmosis MCP activity. These labels are shown both on the browser wall and, when available, the experimental inline card. Observed lessons are intentionally phrased around the concrete tool or technology seen in the event, not an inferred project story.

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
| `OSMOSIS_PROVIDER` | `none` | `none` is the default template mode. `codex` is implemented with the local read-only Codex CLI. `openai` is a reserved interface behind the same curriculum contract; its generation backend is not yet implemented, and a future implementation would also require verified API billing plus a key. |
| `OSMOSIS_MODE` | `live` | `live` runs the selected provider; `record` saves report-driven cards; `replay` consumes a local replay fixture in order. |
| `OSMOSIS_PORT` | `4321` | Local HTTP/SSE port. Set `0` only when an isolated test needs an OS-assigned free port. |
| `OSMOSIS_HOST` | `127.0.0.1` | Local bind address. |
| `OSMOSIS_PORT_RETRY_MS` | `15000` | Retry interval for an MCP-only port loser to acquire the local HTTP wall after its owner exits. |
| `OSMOSIS_PROFILE_DIR` | `~/.osmosis` | User-level mastery directory. Point this at an isolated directory for demos/tests, or share it to prove cross-project mastery. |
| `OSMOSIS_SESSIONS_DIR` | `$CODEX_HOME/sessions`, else `~/.codex/sessions` | Local Codex rollout-log root used by Ambient Watch. Point it at an isolated local directory for demos/tests. |
| `OSMOSIS_AMBIENT` | off | Set exactly to `1` to enable the experimental Ambient Watch; every other value leaves it off. |
| `OSMOSIS_AMBIENT_EMIT_INTERVAL_MS` | `45000` | Minimum per-session interval between observed reports after the first fast report. |
| `OSMOSIS_TEMPLATE_DELAY_MS` | `900` | Delay before the local `none` starter lesson; useful for development and tests. |
| `OSMOSIS_CARD_PACING_MS` | `12000` | Minimum spacing between delivered live curriculum cards after the first card. |
| `OSMOSIS_UNANSWERED_CARD_CAP` | `5` | Maximum unanswered live curriculum cards before generation pauses and marks the direct concept as surfaced. |
| `OSMOSIS_GLOBAL_REPORT_QUEUE_CAP` | `OSMOSIS_UNANSWERED_CARD_CAP` | Broker-wide active-plus-queued report cap. The broker allocates available work fairly across project channels. |
| `OSMOSIS_PROJECT_ARCHIVE_AFTER_DAYS` | `30` | Days of inactivity before a non-current channel collapses into the archived group. This never deletes channel data. |
| `OSMOSIS_CODEX_COMMAND` | `codex` | Local Codex executable used by the `codex` provider. |
| `OSMOSIS_CODEX_TIMEOUT_MS` | `60000` | Per-attempt timeout for a `codex exec` generation call. |
| `OPENAI_API_KEY` | unset | Would be required by a future implemented `openai` backend; never commit it. |

Local data stays local by default: `~/.osmosis/profile.json` holds user-level mastery; `~/.osmosis/projects.json` holds lightweight project summaries; `~/.osmosis/ledger/` holds bounded per-project activity traces; and each target project's `.osmosis/tree.json`, `cards.json`, and `replay.json` hold channel state. Codex's own rollout logs live below the configured sessions root. They are private/ignored. Only the sanitized replay fixture in this repository is intended to ship. When an Ambient Watch lesson uses the implemented `codex` generator, its sanitized metadata is sent through that provider's local request path; the reserved `openai` interface has no generation request path yet.

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
- a second server instance keeps MCP stdio alive after its HTTP port is guarded, registers its canonical project once, then relays reports to its own primary-broker channel;
- project-channel snapshots dual-emit legacy and v2 forms, keep background project events out of the active wall, and lazily hydrate a tab only when requested;
- `POST /answer?project=<id>` keeps its frozen two-key body, atomically persists `cards.json` and `~/.osmosis/profile.json`, includes the local iframe CORS response headers, and a reconnecting browser receives the answered state;
- profile mutations take a Node-core cross-process lock around their read-modify-write cycle, project provider concepts are namespaced, and legacy mastery records remain readable during migration;
- activity ledgers trace report acceptance, refusal, provider result, failure, and delivery without treating a provider failure as idle;
- the Learning Studio keeps one visible Now lesson, one hidden ready Next lesson, and a bounded two-signal candidate watermark; an answered lesson stays in review while an explicit Next click bypasses background pacing;
- Ambient Watch is opt-in, tails only the matching project's active rollout logs in isolated fixtures, labels patch observations separately from exec/MCP activity, respects bounded queue/pacing behavior, ignores Osmosis's own generator activity, runs only in the HTTP owner, and shuts down without retained timers;
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

The [static replay page](docs/index.html) is an offline-deployable static demo page composed of local assets under `docs/`: no API key, local server, or live agent is required. Configure GitHub Pages to deploy the `/docs` directory for a judge-facing URL. It renders the real Codex-provider fixture tree and cards, plus a separately sanitised Project B tree where `Animation loop` is visibly gold `CARRIED OVER` from the shared profile while only the new `Ferry movement` card is recorded. No public judge URL is claimed until a remote repository and GitHub Pages deployment exist.

## Current boundary

The broker is local to one user profile and one loopback wall. It is designed for several project channels on that machine, not for remote multi-user synchronization. Codex desktop/browser verification of the live multi-project UI remains an operator-run check.

## What's next

- **MCP Apps inline hardening:** keep the experimental inline card current as the under-development Codex host interface matures, then package it with the runner.
- **Plugin distribution:** keep evolving the npm runner and plugin shell so installation is repeatable and the Codex child-process cwd trap is contained.
- **PostToolUse production path:** replace experimental rollout tailing when Codex exposes a stable, verified lifecycle-hook contract, preserving the same provenance and privacy boundaries.

## How Osmosis was built

**Division of labor.** The human owner set product direction, sliced milestones, made every provider and privacy-boundary decision, and ran acceptance plus independent adversarial review on each delivery. Codex implemented all product code in one primary session thread.

**GPT-5.6.** In this submission and its recording environment, the primary Codex session ran on GPT-5.6 (Terra), which wrote every line of this codebase and the recorded lesson cards through Codex; at runtime, however, the local `codex` provider inherits the runner's local Codex model configuration rather than fixing generations to GPT-5.6. The direct `openai` interface is reserved through the same curriculum contract, but its generation backend is not yet implemented; once implemented, it would additionally require verified API billing and an API key.

The wall is intentionally local-first and lives with its local Codex session.

The MCP is agent-agnostic even though the demo uses Codex.
