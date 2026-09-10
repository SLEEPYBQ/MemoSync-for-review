# Local Data and Telemetry

The review repository contains source and reproduction instructions. Running the application creates local state. Model requests send necessary task context and memory to the selected provider; local storage does not make those requests offline.

## Storage

Application data defaults to `~/.memosync/data/`; development mode uses `~/.memosync-dev/data/`. These are application defaults, not researcher-specific paths.

| Relative path | Contents |
| --- | --- |
| `memory.sqlite` | Memory items, versions, scopes, statuses, relations, and history. |
| `memories/` | Markdown projections. |
| `projects.jsonl`, `chats.jsonl`, `messages.jsonl`, `queued-messages.jsonl`, `turns.jsonl` | Project, conversation, queue, and execution events. |
| `snapshot.json` | Compacted application-state snapshot. |
| `transcripts/` | Per-conversation transcripts. |
| `settings.json` | Application settings. |
| `install-id` | Locally generated installation identifier. |
| `experiments/events.jsonl` | Memory and interface usage events. |

Usage events record proposals and decisions, selection, injection, citations, transfers, interruptions, audits, and memory-interface interactions. Transcripts are stored separately. The application does not automatically publish local usage logs. Deleting an export does not disable logging while the application runs.

## Export

```bash
bun run export-data
bun run export-data --full
bun run export-data --out DIRECTORY
```

The default export contains usage events, the memory library and projections, settings, and the installation identifier. `--full` also includes session logs and transcripts. The resulting `memosync-export-*.tar.gz` archive is ignored by Git.

Exports can contain reviewer prompts, project information, memory content, paths, and identifiers. They are not part of the anonymous source artifact.

## Local analysis

```bash
bun run scripts/analyze-experiment.ts EVENTS_JSONL_PATH --csv output.csv
```

Supply the path of a generated usage log. Analysis output remains local unless separately shared.
