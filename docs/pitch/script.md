# Osmosis — final 2:30 voiceover

Target pace: **about 130 words per minute**. Speak only the quoted paragraphs. Bracketed lines are screen direction, not narration.

## 0:00–0:12 — Slide 1 / face or repo list

> “My AI writes all my code. I’ve shipped over sixty projects. I still can’t read most of them.”

## 0:12–0:22 — Slide 2 / comprehension debt

> “That is comprehension debt: working code without a working mental model. In Anthropic’s 52-person study, AI-assisted coders scored about seventeen percent lower on immediate comprehension.”

## 0:22–0:32 — Slide 3 / pivot

> “So I asked a different question: what if the minutes my coding agent spends working could teach me the thing it just did?”

## 0:32–0:47 — Slide 4, then live demo: Codex and Osmosis side by side

> “This is Osmosis. I ask Codex to build a 3D scene. While it works, Osmosis watches project activity. Two seconds in, it spots a relevant tool and serves an instant warmup question.”

## 0:47–1:02 — Live demo: answer warmup, then show full card provenance

> “One question. No invented curriculum: it is technology my agent uses now. Behind it, Codex turns sanitized context into a fuller, provenance-linked lesson.”

## 1:02–1:15 — Live demo: answer correctly, tree lights, switch to Project B

> “Answer correctly and the learning trail lights up. In another project, gold means I already mastered that concept, so Osmosis skips the duplicate. The knowledge follows me, not the repository.”

## 1:15–1:28 — Slide 5 / live demo: open Why no card

> “And when there is no card, Osmosis says why. The activity ledger records what it observed, tried, delivered, and deliberately suppressed. That honesty matters: no invisible black box.”

## 1:28–1:44 — Slide 7 / architecture

> “Under the wall is a local MCP reporting server, an experimental observer for Codex rollout activity, and an owner-only broker that protects project state, ledgers, and shared mastery. The system has 186 automated tests.”

## 1:44–2:10 — Slide 8 / primary Codex session, AGENTS.md, session ID, commits

> “I set direction, milestones, provider and privacy boundaries, then ran acceptance and adversarial review. Codex implemented every product line in one primary session; here is the ID. In this recording environment, Codex ran on GPT-5.6 Terra: it wrote the code and recorded card lessons. Elsewhere, the provider inherits local Codex configuration. The direct OpenAI API backend is reserved, not implemented.”

## 2:10–2:23 — Slide 9 / differentiation

> “Unlike a manual codebase tutor, a PR merge gate, or live IDE teaching for aspiring engineers, Osmosis starts automatically in the wait window, uses multiple-choice retrieval, and remembers cross-project mastery for non-technical builders.”

## 2:23–2:30 — Slide 10 / return to calm card or close slide

> “Vibe coding should make you smarter, not dumber. Osmosis turns your project into the curriculum.”

---

## Recording checklist

- Open `docs/pitch/deck.html` directly for the offline deck. Arrow keys, Space, Page Up/Down, Home/End, navigation dots, and background clicks move slides; it works via `file://` with no external assets.
- Keep the live-demo frame dominant from **0:32–1:28**. The five judge-visible moments are: agent coding, card caused by observed/reported activity, correct answer lights mastery, Project B skips a carried-over concept, and the Codex primary session ID.
- Use your own English voice. This script is intentionally explicit about the GPT-5.6 recording environment and the unimplemented direct OpenAI API backend.
