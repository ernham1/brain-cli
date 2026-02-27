# @ernham/brain-cli

Persistent long-term memory CLI for AI agents. Manage external memory that persists across sessions and projects.

## Install

```bash
npm install -g @ernham/brain-cli
```

On install, it automatically:
- Creates the `~/Brain/` directory and index structure
- Appends Brain usage instructions to `~/.claude/CLAUDE.md`

## Quick Start

```bash
# 1. Set up persona (one-time)
brain-cli setup

# 2. Recall memories at session start
brain-cli recall -b -g "current task keywords"

# 3. Store a memory
brain-cli write '{
  "action": "create",
  "sourceRef": "30_topics/debugging/react-hydration.md",
  "content": "# React Hydration Fix\n\n...",
  "record": {
    "scopeType": "topic",
    "scopeId": "debugging",
    "type": "note",
    "title": "React Hydration Error Fix",
    "summary": "Use dynamic import instead of suppressHydrationWarning for SSR mismatch",
    "tags": ["domain/ui", "intent/debug"],
    "sourceType": "candidate"
  }
}'
```

## Commands

| Command | Description |
|---------|-------------|
| `brain-cli setup` | Interactive persona setup (agent personality + user info) |
| `brain-cli recall -b -g "keyword"` | Boot + memory search at session start (brief output) |
| `brain-cli write '<Intent JSON>'` | Store memory via BWT transaction |
| `brain-cli search -g "keyword"` | Search memories |
| `brain-cli validate` | Verify index integrity |
| `brain-cli init` | Initialize Brain directory (idempotent) |
| `brain-cli boot` | Run boot sequence |

## Brain Directory Structure

```
~/Brain/
  00_user/        # User preferences, global rules
  10_projects/    # Per-project memories
  20_agents/      # Agent configurations
  30_topics/      # General topics (auto-created folders)
  90_index/       # Index (records.jsonl, manifest.json, etc.)
  99_policy/      # Brain operation policies
```

## Persona

Run `brain-cli setup` for an interactive setup:

- **Agent info**: Name, age, gender, role
- **Personality**: Type (6 options), core traits, values
- **Emotional sensitivity**: 7 axes — joy, trust, empathy, etc.
- **Interaction patterns**: Formality level, directness, etc.
- **User info**: Name, title, characteristics

Settings are saved to the Brain store and automatically reflected in `~/.claude/CLAUDE.md`. Re-running updates the existing configuration.

## Reminders

Store a memory with `type: "reminder"` to track deadlines. These are surfaced during `recall` at session start.

```bash
brain-cli write '{
  "action": "create",
  "sourceRef": "30_topics/reminders/pitch-deck.md",
  "content": "# Pitch Deck Prep\n\nDeadline: 2026-03-05\nTasks: ...",
  "record": {
    "scopeType": "topic",
    "scopeId": "reminders",
    "type": "reminder",
    "title": "Pitch Deck Preparation",
    "summary": "Complete pitch deck by March 5",
    "tags": ["domain/work", "intent/reminder"],
    "sourceType": "candidate"
  }
}'
```

- Write deadlines in natural language within the content body
- Query reminders: `brain-cli recall -g "reminder"` or `brain-cli search -g "reminder"`
- Mark complete with the `deprecate` action

## BWT (Brain Write Transaction)

Every write is processed through a 9-step transaction for safety:

1. Intent validation
2. `.bak` backup creation
3. Directory creation
4. Document `.tmp` write
5. Index `.tmp` update
6. Manifest `.tmp` update
7. Digest `.tmp` update
8. Validate integrity
9. Atomic rename (auto-rollback on failure)

## Requirements

- Node.js >= 20.0.0
- [Claude Code](https://claude.ai/claude-code) (Anthropic CLI) recommended

## License

MIT — [NeuralFlux](https://github.com/neuralflux)
