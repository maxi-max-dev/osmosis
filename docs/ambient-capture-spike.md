# Ambient Capture hook spike — production roadmap after experimental Ambient Watch

Date: 2026-07-18 (historical note)

## 1. Original decision

The original Ambient Capture spike investigated Codex `PostToolUse` hooks as a way to turn edits into lessons. It was stopped under its 90-minute rule: the required trusted desktop edit → hook → debounce → card-wall path was not established, and the temporary hook configuration was removed rather than shipping a partial observer.

## 2. Current experiment and production direction

Ambient Watch is the current **experimental** mechanism, not a replacement for the hook goal. It tails newly appended Codex session rollout records under the configured sessions root (normally `$CODEX_HOME/sessions` when set, otherwise `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`). That provides a practical real-time signal while Codex's desktop `PostToolUse` contract remains unverified. A stable, independently verified `PostToolUse` lifecycle hook is the production roadmap.

## 3. Current Ambient Watch contract

The server polls only active rollout files from today and yesterday, attaches at their current EOF, and reads only appended JSONL events. It reads those raw records locally to derive bounded, sanitized metadata: allowlisted command/tool technologies, file extensions, known frameworks, and a session working directory used solely for project matching. The `osmosis` MCP server and the isolated generator marker are ignored to prevent feedback loops.

The first qualifying signal for a session can create a fast observed report. Later signals are grouped into one report per configured interval, then continue through the normal card pacing and queue cap. The watcher exists only in the HTTP-port owner, runs locally, and is stopped with the server. Filesystem, parsing, and timer failures are contained and logged to stderr without affecting Codex's MCP path.

## 4. Privacy and control

The raw Codex rollout records stay local. Ambient Watch derives only bounded metadata from them; it does not add a transport for the raw records. A configured `codex` or `openai` card generator may receive that sanitized metadata through its normal request path. Enable the experiment only with `OSMOSIS_AMBIENT=1`; any other value leaves it off. Set `OSMOSIS_SESSIONS_DIR` to use an isolated local directory for a test or demo.

## 5. Provenance contract

Every lesson carries a source, and both Osmosis surfaces make it visible:

- **Reported by agent** — the agent explicitly called the strict three-field `osmosis_report` MCP tool. The server stamps this report as `source: 'agent'` only after validation.
- **Observed change** — Ambient Watch synthesized a card from a successful patch event. This label is never used for exec or MCP activity.
- **Observed activity** — Ambient Watch synthesized a card from allowlisted exec or non-Osmosis MCP activity. It must never be presented as an agent-authored report.

Observed lessons should teach the concrete tool or technology that was seen (for example, a command, extension, or framework), not invent a project narrative from unseen code.

## 6. Hook status

`PostToolUse` hooks are the production roadmap, not a runtime dependency of this build. Any future hook integration must be stable in the desktop host, non-blocking, and preserve the same privacy, source-provenance, and failure-containment contract described above. Until that contract is verified, rollout tailing remains explicitly experimental.
