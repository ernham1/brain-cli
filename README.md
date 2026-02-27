# Open Brain

**Persistent long-term memory for AI agents**

[![npm version](https://img.shields.io/npm/v/@ernham/brain-cli)](https://www.npmjs.com/package/@ernham/brain-cli)
[![license](https://img.shields.io/npm/l/@ernham/brain-cli)](LICENSE)
[![node](https://img.shields.io/node/v/@ernham/brain-cli)](package.json)

Open Brain gives AI agents a durable, structured memory that survives across sessions, projects, and context windows. Write once, recall anywhere — with transactional safety.

## Why Open Brain?

| Problem | Open Brain |
|---------|-----------|
| Context window resets every session | Persistent `~/Brain/` store on disk |
| Memories are unstructured text blobs | 14-field typed records with scope, tags, and lifecycle |
| Writes can corrupt state on crash | 9-step BWT transaction with atomic rename and auto-rollback |
| Search requires loading everything | 6-stage optimized search via digest + index |
| Tied to one framework or provider | Framework-agnostic CLI — works with Claude Code, Cursor, or any agent |

## Quick Start

```bash
# Install globally
npm install -g @ernham/brain-cli

# Set up agent persona (interactive, one-time)
brain-cli setup

# Recall at session start
brain-cli recall -b -g "project keywords"

# Store a memory
brain-cli write '{
  "action": "create",
  "sourceRef": "30_topics/debugging/fix-hydration.md",
  "content": "# Hydration Fix\n\nUse dynamic import instead of suppressHydrationWarning.",
  "record": {
    "scopeType": "topic",
    "scopeId": "debugging",
    "type": "note",
    "title": "React Hydration Fix",
    "summary": "dynamic import solves SSR mismatch",
    "tags": ["domain/ui", "intent/debug"],
    "sourceType": "candidate"
  }
}'
```

## Architecture

### Directory Structure

```
~/Brain/
  00_user/        User preferences and global rules
  10_projects/    Per-project memories
  20_agents/      Agent configurations (persona, personality)
  30_topics/      General topics (auto-created on write)
  90_index/       Index files (records.jsonl, manifest.json, digest)
  99_policy/      Brain operation policies
```

### BWT — Brain Write Transaction

Every write goes through a **9-step transaction** to guarantee data integrity:

```
Step 1   Intent validation          (schema + action check)
Step 2   .bak backup creation       (index files snapshot)
Step 3   Directory creation         (ensure target folder exists)
Step 4   Document .tmp write        (content to temporary file)
Step 5   Index .tmp update          (records.jsonl append)
Step 6   Manifest .tmp update       (manifest.json rebuild)
Step 7   Digest .tmp update         (records_digest.txt rebuild)
Step 8   Validate integrity         (cross-check all .tmp files)
Step 9   Atomic rename              (all .tmp → final, or full rollback)
```

If any step fails, all `.tmp` files are removed and `.bak` files restore the previous state.

## Record Schema

Each memory is stored as a 14-field JSONL record:

| # | Field | Type | Description |
|---|-------|------|-------------|
| 1 | `recordId` | string | Unique ID — `rec_{scope}_{id}_{YYYYMMDD}_{NNNN}` |
| 2 | `scopeType` | enum | `project` · `agent` · `user` · `topic` |
| 3 | `scopeId` | string | Scope identifier (e.g., `"brain-cli"`, `"debugging"`) |
| 4 | `type` | enum | `note` · `rule` · `decision` · `reminder` · `profile` · `log` · `ref` · `candidate` · `project_state` |
| 5 | `title` | string | Human-readable title |
| 6 | `summary` | string | One-line summary for digest search |
| 7 | `tags` | string[] | Two-axis tags: `domain/*` + `intent/*` |
| 8 | `sourceType` | enum | `user_confirmed` · `candidate` · `chat_log` · `external_doc` · `inference` |
| 9 | `sourceRef` | string | File path within `~/Brain/` |
| 10 | `status` | enum | `active` · `deprecated` · `archived` |
| 11 | `replacedBy` | string? | Record ID of replacement, or `"obsolete"` |
| 12 | `deprecationReason` | string? | Required when `replacedBy` = `"obsolete"` |
| 13 | `updatedAt` | string | ISO 8601 timestamp |
| 14 | `contentHash` | string | `sha256:` prefixed hash of the document file |

## Commands

| Command | Description |
|---------|-------------|
| `brain-cli setup` | Interactive persona setup — agent personality, emotional sensitivity, user info |
| `brain-cli recall -b -g "keyword"` | Boot sequence + memory search (brief output) |
| `brain-cli write '<Intent JSON>'` | Store memory via 9-step BWT transaction |
| `brain-cli search -g "keyword"` | Search memories by keyword |
| `brain-cli search -t <type>` | Search by record type (note, decision, rule, etc.) |
| `brain-cli validate` | Verify index integrity (record count, hash, manifest) |
| `brain-cli validate --full` | Extended validation (B08 cross-checks) |
| `brain-cli init` | Initialize `~/Brain/` directory structure (idempotent) |
| `brain-cli boot` | Run 4-stage boot sequence |

## How It Compares

| | Open Brain | Letta (MemGPT) | Mem0 |
|---|-----------|-----------------|------|
| **Architecture** | CLI-first, local files | Server-based, REST API | Cloud/self-hosted API |
| **Storage** | JSONL + Markdown on disk | PostgreSQL + vector DB | Vector DB + graph |
| **Transaction safety** | 9-step BWT with rollback | No transaction guarantees | No transaction guarantees |
| **Setup** | `npm install -g` — zero config | Docker + server setup | API key + SDK setup |
| **Framework lock-in** | None — any agent can shell out | Python SDK required | Python/JS SDK required |
| **Persona system** | Built-in interactive setup | Manual configuration | Not included |
| **Cost** | Free (local) | Free (self-hosted) / paid | Free tier / paid |

Open Brain is designed for **individual developers and small teams** who want their AI agent to remember things without running infrastructure.

## Integration with Claude Code

Open Brain is designed to work seamlessly with [Claude Code](https://claude.ai/claude-code):

1. **On install**, Open Brain appends usage instructions to `~/.claude/CLAUDE.md`
2. **On session start**, the agent runs `brain-cli recall` to load relevant memories
3. **During work**, the agent stores discoveries via `brain-cli write`
4. **Persona** settings are reflected in Claude Code's behavior automatically

Works with any Claude Code project — no MCP server or plugin required. Just a global npm install.

## Requirements

- **Node.js** >= 20.0.0
- **OS**: macOS, Linux, Windows (WSL or native)
- **Recommended**: [Claude Code](https://claude.ai/claude-code) (Anthropic CLI)

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding conventions, and how to submit pull requests.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history.

## License

[MIT](LICENSE) — **NeuralFlux**

---

<p align="center">Built with care by <a href="https://github.com/ernham1">NeuralFlux</a></p>
