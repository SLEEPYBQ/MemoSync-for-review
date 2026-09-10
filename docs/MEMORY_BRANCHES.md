# Memory Branch Execution

Memory reasoning uses the selected coding CLI. Results are reviewed and validated before they affect the memory store or coding turn.

## Lifecycle

1. C extracts and routes candidates. T analyzes applicability, abstraction, localization, and transfer landing. M checks conflicts, redundancy, and staleness. They start concurrently against the same parent conversation and project snapshot.
2. Candidate, Transfer, and Change reviews proceed sequentially. Candidate decisions continue T and M; transfer decisions continue M. The existing child conversations return stable-ID proposal deltas. Invalid collection shapes and unknown removal identities are rejected.
3. Review routes persist approved changes. Version and dependency checks reject obsolete results. W then selects from the updated store and provides an expected-use instruction per selected item. Manual planning and natural-language adjustments continue W.
4. Confirmed items form the main Memory Block. Claude receives a selected snapshot and later deltas. Codex receives the selected block, expected uses, and enforced items through per-turn developer instructions. Detail tools are restricted to the current confirmed IDs.
5. A forks the completed main session and audits every injected item against its delivered snapshot and this turn's reply and tool evidence. Verdicts are Shaped, Not applicable, No visible effect, and Violated. Not applicable requires a separate missing-opportunity field. A violation requires cause and impact fields. Invalid or incomplete output remains a failed audit.
6. Validated tool IDs and quotes support Where used navigation. A violated item can be enforced for the next turn. Interruption and correction preserve the main coding conversation.

The Memory Board stores item content, scopes, versions, relations, and history. The Memory Record presents per-turn activity. Branch reasoning is not appended to the main coding transcript.

## Context and limits

Claude uses `query()` with `resume` and `forkSession: true`, then resumes the returned child session. Codex forks a thread and continues later requests on that child.

Before the first main turn is persisted, there is no session to fork. Initial branches start with empty conversation history, the current task, and project tools. Later branches fork the available parent history. Invalid existing parent handles are reported as errors. Actual provider cache reuse and latency savings are not guaranteed.

Each request has a default 120-second deadline:

| Request | Model turns or visible steps | Read-tool allowance |
| --- | ---: | ---: |
| Initial analysis | 6 | 4 |
| Review or working-memory adjustment | 3 | 1 |
| One schema correction | 2 | 0 |

Claude checks its SDK model-turn limit and each read call, including parallel calls. Structured-output completion does not consume the read allowance. Codex counts observable tool calls and completed assistant messages. This does not expose internal model turns or provider retries, and a native command may already have started when its event arrives. Read-only restrictions and the deadline remain active.

One schema-only correction may run in the same child conversation. A second invalid result fails. Cancelling preparation aborts requests and prevents late results from advancing the turn.

## Isolation

Branches inspect files and run bounded read-only commands. They cannot edit project files or persist speculative memory changes. Inherited hooks, plugins, external tool servers, and unsupported agent capabilities are restricted at the branch boundary.

`MEMOSYNC_ISOLATE_CLI=1` creates separate engine profiles. Main sessions and branches use the same selected provider configuration. Credentials remain in the reviewer's local environment and are not inserted into model prompts or source files.

## Reproduction

Run `bun run check` and `bun test src/ --timeout 30000` for offline validation. Provider-backed smoke commands are listed in the [README](../README.md#verification). Transport checks exercise real branching and continuation; application checks exercise two complete turns with temporary memory reviews, working-memory injection, and auditing.
