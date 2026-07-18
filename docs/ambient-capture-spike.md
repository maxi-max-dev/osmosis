# Ambient Capture hook spike — superseded by Ambient Watch

Date: 2026-07-18 (historical note)

## 1. Original decision

The original Ambient Capture spike investigated Codex `PostToolUse` hooks as a way to turn edits into lessons. It was stopped under its 90-minute rule: the required trusted desktop edit → hook → debounce → card-wall path was not established, and the temporary hook configuration was removed rather than shipping a partial observer.

## 2. What changed

Ambient Watch supersedes that hook-only plan. Codex writes current session rollout records locally under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; these records provide real-time, non-blocking tool and patch metadata without requiring an agent to cooperate or a desktop hook to be trusted.

## 3. Current Ambient Watch contract

The server polls only active rollout files from today and yesterday, attaches at their current EOF, and reads only appended JSONL events. It extracts command/tool names, working-directory/project labels, changed file basenames/extensions, and MCP `server.tool` metadata; it never reads project-file contents. The `osmosis` MCP server is ignored to prevent feedback loops.

The first qualifying signal for a session can create a fast observed report. Later signals are grouped into one report per configured interval, then continue through the normal card pacing and queue cap. The watcher exists only in the HTTP-port owner, runs locally, and is stopped with the server. Filesystem, parsing, and timer failures are contained and logged to stderr without affecting Codex's MCP path.

## 4. Privacy and control

The raw Codex rollout logs stay local. Ambient Watch does not transmit those logs or project contents; it uses metadata only. Set `OSMOSIS_AMBIENT=0` to disable it, or set `OSMOSIS_SESSIONS_DIR` to use an isolated local directory for a test or demo. A configured card-generation provider follows its own request path; Ambient Watch itself does not add a remote transport.

## 5. Provenance contract

Every lesson carries a source, and both Osmosis surfaces make it visible:

- **Reported by agent** — the agent explicitly called the strict three-field `osmosis_report` MCP tool. The server stamps this report as `source: 'agent'` only after validation.
- **Observed change** — Ambient Watch synthesized `source: 'observed'` from local Codex event metadata. It must never be presented as an agent-authored report.

Observed lessons should teach the concrete tool or technology that was seen (for example, a command, extension, or framework), not invent a project narrative from unseen code.

## 6. Hook status

`PostToolUse` hooks remain an optional future research path, not a runtime dependency of this build. Any future hook integration must remain non-blocking and preserve the same privacy, source-provenance, and failure-containment contract described above.
