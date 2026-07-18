# Osmosis agent instruction

Copy this instruction into the target project before using Osmosis with a coding agent.

## Report completed milestones

After completing every task or milestone, and before starting the next one, call:

```text
osmosis_report({
  task: "the completed milestone name",
  what_i_did: "One concise English sentence explaining what you completed.",
  stack_hints: ["the relevant technologies"]
})
```

Call it immediately. The immutable tool instruction is: “Call this immediately after completing each task or milestone, before starting the next. Write what_i_did in English.”

- Write `task`, `what_i_did`, and every `stack_hints` item in English.
- Send exactly one report for each completed milestone.
- Report completed work only; do not batch milestones or report plans/in-progress work.
- Treat the acknowledgement as immediate and non-blocking, then continue with the next task.

## Primary-thread exception

If the primary production-build thread is deliberately not mounted with the Osmosis MCP server, emit a truthful text report in that thread instead:

```text
REPORT — <task>: <one concise English sentence describing completed work>
```

Use this exception only when no MCP tool is mounted. Never claim that an `osmosis_report` call happened when it did not.
