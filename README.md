<p align="center">
  <img src="assets/icon.svg" alt="MemoSync" width="88" />
</p>

<h1 align="center">MemoSync</h1>

<p align="center">Anonymous review artifact</p>

<p align="center">
  <strong>Co-manage your coding agent's memory: see what it remembers, decide what it keeps, choose what it uses, and audit how it used it.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <img alt="Bun 1.3.5+" src="https://img.shields.io/badge/bun-%E2%89%A51.3.5-f9f1e1.svg" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.8-3178c6.svg" />
  <img alt="React 19" src="https://img.shields.io/badge/React-19-61dafb.svg" />
</p>

<br />

<p align="center">
  <img src="docs/figures/main-ui.png" alt="MemoSync in the middle of a turn" width="960" />
</p>

<p align="center">
  <sub>MemoSync in the middle of a turn. <b>(A)</b> the pre-turn review of long-term memory, <b>(B)</b> the Memory Board, <b>(C)</b> the working memory confirmed for this turn, <b>(D)</b> inline memory citations with a Stop control, <b>(E)</b> the post-turn Memory Use Audit, <b>(F)</b> the per-turn Memory Record.</sub>
</p>

<br />

## Demo video

Watch a complete memory co-management walkthrough.

<video controls preload="metadata" width="960" height="540" style="display: block; width: 100%; max-width: 960px; height: auto; margin: 0 auto;" src="docs/videos/MemoSync-demo.mp4"></video>

<p align="center">
  <a href="docs/videos/MemoSync-demo.mp4">Video file (MP4)</a>
</p>

## Why MemoSync

Coding agents accumulate memory — `CLAUDE.md` files, auto-extracted notes, session summaries — but the developer rarely knows what is in it, what the agent brought into a turn, or whether the agent followed it. Memory changes behind your back, stale rules from an old project leak into a new one, and a violated constraint only shows up when the tests fail.

MemoSync is a local web workbench for coding agents that treats agent memory as a **shared, operable representation**: a store of versioned memory items that you and the agent both read, propose changes to, and act on. At every stage of a turn the system shows what changed and proposes an action; you review and decide. Nothing is written to memory, injected into a turn, or enforced on the agent without your say-so.

<p align="center">
  <img src="docs/figures/metamemory-loop.png" alt="The metamemory loop, distributed between developer and agent" width="860" />
</p>

<p align="center">
  <sub>The design borrows the <em>metamemory</em> loop from cognitive psychology: meta-level judgements <b>monitor</b> object-level memory processes and <b>control</b> them. With a coding agent, that loop is split across the human–agent boundary — the agent runs the memory processes, but the developer needs to keep the monitoring and control. MemoSync closes the loop at five points: how memory is represented, how it evolves, what is selected for a turn, how it is applied during execution, and what effect it had.</sub>
</p>

Each memory item is a one-line summary with a scope (**personal**, **project**, or **session**) plus metadata that accumulates over time: a detailed form the agent loads on demand, a version number, a status, a usage count, and a history log. The same item takes a different form at each stage of a turn — a proposal card, a working-memory row, an inline citation, an audit verdict — and two persistent views, the Memory Board and the Memory Record, carry it between turns.

## Contents

- [Demo video](#demo-video)
- [How a turn works](#how-a-turn-works)
  - [1 · Evolution — review changes to long-term memory](#1--evolution--review-changes-to-long-term-memory)
  - [2 · Selection — compose the working memory](#2--selection--compose-the-working-memory)
  - [3 · Execution — trace and interrupt memory use](#3--execution--trace-and-interrupt-memory-use)
  - [4 · Impact — audit memory use and enforce a rule](#4--impact--audit-memory-use-and-enforce-a-rule)
  - [Between turns — Memory Board and Memory Record](#between-turns--memory-board-and-memory-record)
- [Features at a glance](#features-at-a-glance)
- [Quickstart](#quickstart)
- [Configuration](#configuration)
- [Command line](#command-line)
- [How it is built](#how-it-is-built)
- [Development](#development)
- [License](#license)

## How a turn works

The walkthrough below follows a developer adding Stripe checkout to a small shop whose store already holds personal habits (`M-02` "Use pnpm, never npm"), project facts (`M-07` "Prices are stored as integer cents, never floats"), and lessons from an earlier payments project.

### 1 · Evolution — review changes to long-term memory

<p align="center">
  <img src="docs/figures/evolution.png" alt="Reviewing changes to long-term memory" width="960" />
</p>

Before a turn starts, MemoSync presents three review steps for proposed changes to long-term memory. Each change needs explicit approval before it is written to the store.

1. **Review New Memory Candidates** — items extracted from the last exchange (including the real work trajectory: files touched, commands run, errors hit), each with a proposed scope. Accept, edit, rescope, or dismiss.
2. **Memory Transfer Suggestions** — rules from *other* projects that may apply here. Copying a rule verbatim drags in source-project details, so transfer is two-staged: an **encoder** abstracts the source rule into a project-independent form, a **decoder** rewrites it against this project's memory and the current task. Source, abstract rule, and rewritten rule sit side by side so every transformation is reviewable.
3. **Review Suggested Changes to Existing Memories** — conflicts between new and old items, redundant pairs to merge, and items that have gone stale, each with a one-line reason. Repeatedly violated items surface here with a revision proposal.

### 2 · Selection — compose the working memory

<p align="center">
  <img src="docs/figures/selection.png" alt="Composing the working memory for a turn" width="960" />
</p>

**Working Memory for This Turn** opens before the agent starts. Each proposed row shows the item, its scope, and a line stating *how the agent is expected to use it* ("Compute the checkout total from stored prices, not the client payload"). Remove a row, add items from the memory pool, or adjust the selection in plain language — "Anything about the API server setup? Drop the commit-style ones" — and the in-card assistant answers with live `M-NN` chips. What you confirm is exactly what the agent is charged against later.

### 3 · Execution — trace and interrupt memory use

<p align="center">
  <img src="docs/figures/execution.png" alt="Tracing and interrupting memory application" width="960" />
</p>

As the reply streams, the agent is instructed to cite each memory it applies. Hover a citation for the item's content, scope, version, and usage count. Every citation includes a **Stop** control: press it when the agent does the opposite of what the item says, and execution is interrupted. A recovery card quotes the sentence and asks what should have happened; write the correction, optionally tick **Enforce for this resumed run**, and the agent continues in the same main session. Use the item's Save control to retain corrected memory content.

### 4 · Impact — audit memory use and enforce a rule

<p align="center">
  <img src="docs/figures/impact.png" alt="Auditing memory use after a turn" width="960" />
</p>

When a turn ends, the **Memory Use Audit** reports one of four verdicts for each injected item: **violated**, **shaped** the turn, **not applicable**, or **no visible effect**. To avoid relying on the agent's self-report, a separate judgment of the full exchange runs after the turn, so an item violated without being cited is still caught — verdicts are tagged **audit-found** or **self-reported**. A violated row offers **Where used** (scroll to the judged sentence and the tool call behind it) and **Enforce this next run** (the item becomes a mandatory row in the next turn's working memory that only you can remove). Verdicts are written into each item's history.

### Between turns — Memory Board and Memory Record

<p align="center">
  <img src="docs/figures/memory-board.png" alt="The Memory Board" width="960" />
</p>

The **Memory Board** shows every item as one column per scope. Drag an item between columns to rescope it (dropping into another project runs the same encoder/decoder preview as a transfer); open an item to edit its content and detailed form, change its scope, transfer or archive it, and read its full history; archived items can be restored. The **Memory files** card keeps a Markdown copy of the board in sync, so the accumulated memory stays usable with `CLAUDE.md`-style files and other agents, and can import an existing configuration file as candidates for review.

The **Memory Record** in the sidebar lists, for each turn of a session, what was proposed, selected, cited, interrupted, and audited. It persists independently of the agent's context window, so after the conversation is compacted both you and the agent can still refer to it.

## Features at a glance

- **Versioned memory items** — one line each, optional detail loaded on demand, scoped to personal / project / session, with status, usage count, and full history with revert.
- **Mixed-initiative review at every stage** — the system proposes, you decide: candidates, transfers, conflicts/redundancy/staleness, per-turn selection, audit follow-ups.
- **Cross-project transfer** with an encoder/decoder pair that abstracts and re-localizes rules instead of copying them.
- **Inline citations with per-citation Stop**, correction-and-resume, and one-run enforcement.
- **Independent post-turn audit** with four verdicts and source tags (audit-found / self-reported).
- **Memory Board + Memory files** — drag-to-rescope, search, archive/restore, Markdown projection that syncs both ways, import of existing config files.
- **Memory Record** — a per-turn ledger that survives context compaction.
- **Stable session injection** — confirmed memory rides the session as a snapshot plus per-turn deltas, so memory edits can take effect without restarting the conversation.
- **Claude Code and Codex engines** — use your official CLI login and choose a model in the composer. Memory reasoning forks from the selected engine's conversation.
- **A full coding workbench underneath** — project-first sidebar, plan mode, rich transcript rendering, embedded terminal, file and git panels, session resumption, local-first persistence.

## Quickstart

Install [Bun](https://bun.sh) 1.3.5 or newer. Install and sign in to the coding CLI you want to use: **Claude Code** or **Codex**. MemoSync includes the Claude Agent SDK runtime; the Codex engine requires the `codex` command on `PATH`.

Use the anonymous repository URL supplied with the submission:

```bash
git clone <ANONYMOUS_REPOSITORY_URL> MemoSync
cd MemoSync
bun install
cp .env.example .env
bun run build
bun run start
```

Open [localhost:3210](http://localhost:3210), add a project folder, and choose **Claude Code** or **Codex** in the composer. For Claude Code, select **Anthropic** and an official Claude model; for Codex, select an available official Codex model. Send a task, review the memory proposals, and confirm working memory to begin execution.

## Configuration

The default [`.env.example`](.env.example) contains only `PORT=3210`. Change the port there or pass `--port` when starting MemoSync. The selected engine uses your existing CLI login. Leave `MEMOSYNC_ISOLATE_CLI` and `MEMOSYNC_CLI_PROFILE_DIR` unset for this setup; separate engine profiles remain available for advanced configurations.

## Command line

```bash
bun run start
bun run start --port 4000
bun run start --no-open
bun run start --remote
bun run start --password <s>
bun run start --share
```

## How it is built

<p align="center">
  <img src="docs/figures/implementation.png" alt="MemoSync memory orchestration before execution and after a turn" width="960" />
</p>

<p align="center">
  <sub>Candidate extraction, transfer analysis, and memory-change analysis run in parallel branches for sequential review. Approved changes reach the store before a further branch selects working memory. The main session executes with the confirmed Memory Block, followed by a separate audit branch. Review decisions continue the existing branches; memory reasoning stays outside the main conversation.</sub>
</p>

- **Stack.** React 19 + TypeScript on the client, Bun on the server. Memory items and their histories live in SQLite; projects, chats, and transcripts are append-only JSONL logs with snapshot compaction.
- **Agent runtime.** Claude Code runs through the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) `query()` interface with an asynchronous prompt queue. Codex runs through the [Codex app-server](https://developers.openai.com/codex/app-server/) protocol with native thread creation, resume, fork, dynamic tools, and per-turn developer instructions. Both use the selected CLI's authentication and preserve its conversation across turns.
- **Memory tools.** Claude receives memory tools through an MCP server; Codex receives equivalent dynamic tools. `load_memory_detail` fetches an item's detailed form on demand, and `propose_memory` lets the agent nominate a candidate mid-turn for your review.
- **Parallel memory branches.** Candidate extraction (C), transfer (T), and memory changes (M) start together. Candidate decisions continue T and M in their existing conversations; transfer decisions continue M. A further branch selects working memory and writes expected uses after approved changes reach the store. An audit branch judges the completed turn, including uncited tool evidence. MemoSync has no direct-API fallback: every memory model call uses the chosen CLI runtime. Before the first main turn is persisted, branches explicitly start with empty history because Claude cannot fork an unpersisted session. [Implementation and validation details](docs/MEMORY_BRANCHES.md).
- **Confirmed memory injection.** Only confirmed items enter the main Memory Block and detail-tool allowlist. Claude keeps its session and updates selections through deltas; Codex receives the selected block and expected uses through per-turn developer instructions. Branch analysis transcripts stay out of the main conversation. Provider cache reuse depends on the runtime and provider; no latency saving is assumed.

```
src/
├── client/                React UI
│   ├── app/               Router, pages (chat, Memory Board, settings), central state
│   ├── components/        Transcript messages, memory cards and gates, chat chrome
│   └── stores/            Zustand stores
├── server/                Bun backend
│   ├── agent.ts           Turn coordination: review gates, injection, interrupt/resume, post-turn passes
│   ├── codex-app-server.ts Codex threads, turns, tools, and session continuity
│   ├── memory/            The memory engine
│   │   ├── MemoryStore.ts     Versioned items, events, relations (SQLite)
│   │   ├── capture.ts         Candidate extraction and routing
│   │   ├── checkup.ts         Conflict / redundancy / staleness / promotion checks
│   │   ├── branch-pipeline.ts Parallel preparation and sequential review updates
│   │   ├── branch-stages.ts   Stage prompts and result validation
│   │   ├── trace.ts           Post-turn memory-use audit
│   │   ├── transfer.ts        Cross-project transfer (encoder / decoder)
│   │   ├── injection.ts       Snapshot + delta injection planning
│   │   ├── branch-runtime.ts CLI session forks and bounded branch requests
│   │   └── tools.ts           MCP tools exposed to the agent
│   ├── event-store.ts     JSONL persistence, replay, and compaction
│   └── ws-router.ts       WebSocket routing and subscriptions
└── shared/                Types, protocol, tool hydration
```

## Development

```bash
bun run dev
bun test src/ --timeout 30000
bun run check
```

The test suite validates memory orchestration with mocked CLI transports. See [memory branch execution](docs/MEMORY_BRANCHES.md) for architecture and request budgets.

## License

See [LICENSE](LICENSE) for distribution terms and retained third-party notices.
