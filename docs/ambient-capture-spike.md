# Ambient Capture spike — deferred

Date: 2026-07-18

## Decision

No Ambient Capture production code is included in this build. The spike established that the official Codex capability exists, but did not establish the required stable desktop end-to-end path. Per the stop-loss rule, the temporary probe and its local hook configuration were removed rather than leaving a partially validated observer in the product.

## What the official interface supports

Codex lifecycle hooks document `PostToolUse` support for `apply_patch`, with `Edit` and `Write` matcher aliases. The hook payload includes `session_id`, `cwd`, `tool_name`, `tool_input`, `tool_response`, and a tool-use id. Commands run with the session cwd. See the official [Codex Hooks documentation](https://learn.chatgpt.com/docs/hooks).

## Why it was not retained

The temporary desktop probe could not be trusted and exercised in a fresh desktop session from this primary thread. It therefore produced no event, which is not enough evidence for the required real edit → hook → debounce → card-wall chain. The app-control surface also could not operate the Codex desktop UI to complete the hook trust flow. The probe wrote no event log and all temporary files were removed.

## Safe implementation contract for the next spike

1. Bundle a `PostToolUse` hook matching `apply_patch|Edit|Write` in an installable Osmosis plugin; do not ask an agent to self-report.
2. Make the hook a tiny exit-0 launcher only. Command hooks are synchronous and Codex currently skips `async` hooks, so the hook itself must not wait for HTTP, run `git diff`, or generate a card.
3. Send only local event metadata to a server-owned observer keyed by `(session_id, cwd)`. Debounce each key for 75 seconds.
4. After the key is idle, let the server inspect the project diff and create at most one card. All failures must be swallowed locally and must never affect Codex's edit result.
5. Preserve source provenance in the card contract and UI: genuine MCP reports are labelled **Reported by agent**; hook-derived cards are labelled **Observed change**.

## Required tests before enabling it

- Two matching mock hook events for the same `(session_id, cwd)` reset one debounce timer and produce one card after idle.
- Different keys debounce independently, and a card from an observed change has the observed source label rather than an agent-report label.
- A failed local notification, diff read, or generation is swallowed without an unhandled rejection, retained timer, or impact on the edit path.
