# Engram

**Your AI agent forgets everything every session. Brain fixes that.**

Brain is a persistent long-term memory system for AI coding agents. It stores memories as local Markdown files with a transactional write engine — no API calls, no cloud dependency, no vendor lock-in.

```bash
npm install -g @ernham/brain-cli
brain-cli recall -b -g "what I was working on"
# → instantly restores context from previous sessions
```

## Why Brain?

| Problem | Brain's Solution |
|---------|-----------------|
| AI loses all context when a session ends | Persistent memory that survives across sessions |
| Same bugs get re-investigated | Past fixes are recalled automatically |
| Decisions are forgotten and re-debated | Decision records with rationale are searchable |
| Multi-agent setups can't share knowledge | Shared local memory — all agents read/write the same Brain |

## Quick Start

### 1. Install

```bash
npm install -g @ernham/brain-cli
```

On install, Brain automatically:
- Creates `~/Brain/` directory with index structure
- Appends usage instructions to `~/.claude/CLAUDE.md`

### 2. Recall at session start

```bash
brain-cli recall -b -g "auth bug fix"
```

This boots the memory index and searches for relevant past memories in one command. Add this to your agent's session start routine.

### 3. Store a memory

```bash
brain-cli write '{
  "action": "create",
  "sourceRef": "30_topics/debugging/auth-fix.md",
  "content": "# Auth Token Bug\n\nSymptom: 401 on refresh\nCause: token stored before redirect\nFix: moved setToken() after OAuth callback",
  "record": {
    "scopeType": "topic",
    "scopeId": "debugging",
    "type": "note",
    "title": "Auth token refresh bug fix",
    "summary": "Move setToken() after OAuth callback to fix 401 on refresh",
    "tags": ["domain/auth", "intent/debug"],
    "sourceType": "candidate"
  }
}'
```

### 4. Search memories

```bash
brain-cli search -g "auth"          # keyword search
brain-cli search -t decision        # filter by type
brain-cli search --tags domain/ui   # filter by tag
```

That's it. Your agent now has persistent memory.

---

## Commands

### Core

| Command | Description |
|---------|-------------|
| `recall -b -g "keyword"` | Boot + search in one shot (session start) |
| `write '<Intent JSON>'` | Store memory via BWT transaction |
| `search -g "keyword"` | Search memories by keyword, type, or tag |
| `init` | Initialize Brain directory (idempotent) |
| `boot` | Run boot sequence (index load + integrity check) |
| `validate` | Verify index integrity |
| `validate --report` | Distribution report (scope counts, stale records) |

### Advanced: Self-Improving Memory

These commands let your agent learn from its own experience — tracking which thinking strategies work, connecting related memories, and building a persona.

| Command | Description |
|---------|-------------|
| `setup` | Interactive persona configuration (agent character + user info) |
| `links [recordId]` | View, add, or remove connections between memories |
| `meta-seed` | Register 5 default meta-strategies (thinking pattern templates) |
| `meta-list` | List registered meta-strategies with scores |
| `meta-feedback <type>` | Rate a strategy: positive (+0.1) or negative (-0.2) |
| `meta-learn` | Analyze feedback logs and auto-improve strategy triggers |

**Memory Graph** (`links`): Instead of flat storage, memories form a graph. When you recall one memory, related memories surface together. The `links` field in Intent JSON lets your agent specify relationships directly — the LLM decides the link type (`related`, `depends_on`, `see_also`, `replaced_by`) based on semantic understanding, not hardcoded rules.

**Meta-Learning Loop** (`meta-*`): Your agent registers thinking strategies (e.g., "break down before solving"), gets feedback on whether they helped, and automatically adjusts which strategies to use. Feedback is generated automatically — when a recall leads to a successful write, the matched strategy gets a positive score boost.

---

## How It Works

### Brain Directory

```
~/Brain/
  00_user/        # User preferences, global rules
  10_projects/    # Per-project memories
  20_agents/      # Agent configurations
  30_topics/      # General topics (auto-created)
  90_index/       # Index files (records.jsonl, manifest, digest)
  99_policy/      # Operation policies
```

### BWT (Brain Write Transaction)

Every write goes through a 9-step transaction to prevent data corruption:

1. Intent validation → 2. Backup (.bak) → 3. Directory creation → 4. Document write (.tmp) → 5. Index update (.tmp) → 6. Manifest update (.tmp) → 7. Digest update (.tmp) → 8. Integrity check → 9. Atomic rename

If any step fails, all changes roll back automatically.

### Intent JSON Format

```json
{
  "action": "create",
  "sourceRef": "<folder>/<scopeId>/<filename>.md",
  "content": "<document body>",
  "record": {
    "scopeType": "topic | project | user | agent",
    "scopeId": "<identifier>",
    "type": "note | rule | decision | reminder",
    "title": "<title>",
    "summary": "<one-line summary>",
    "tags": ["domain/<value>", "intent/<value>"],
    "sourceType": "candidate"
  },
  "links": [
    { "toId": "rec_proj_myapp_20260301_0001", "linkType": "depends_on" }
  ]
}
```

### Tags (2-axis system)

- **domain**: memory, auth, ui, infra, data, devops, ...
- **intent**: retrieval, decision, debug, onboarding, reference, ...

## Works With

- [Claude Code](https://claude.ai/claude-code) (recommended)
- Any AI agent that can run shell commands
- Framework-agnostic — no AI API calls, just local file I/O

## Requirements

- Node.js >= 20.0.0

## License

MIT — [NeuralFlux](https://github.com/neuralflux)
