# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.2.0] - 2025-02-25

### Added
- `brain-cli setup` — interactive persona configuration (agent personality, emotional sensitivity, user info)
- Persona schema with 7-axis emotional sensitivity and interaction patterns
- Auto-injection of persona settings into `~/.claude/CLAUDE.md`
- `reminder` record type for deadline tracking
- `project_state` record type for project progress snapshots
- `brain-cli recall` combines boot + search in a single command
- `-b` (brief) flag for concise recall output

### Changed
- Boot sequence now surfaces reminders with upcoming deadlines
- Search results include relevance scoring

## [1.1.0] - 2025-02-15

### Added
- `brain-cli search` with 6-stage optimized search pipeline
- Digest-first search strategy (scan summary before full record)
- Tag-based filtering (`-t` flag for record type)
- `brain-cli boot` — 4-stage boot sequence (init check, index load, digest scan, health report)
- KPI module (K1-K4 metrics: record count, coverage, freshness, integrity)
- Lifecycle management: status transitions, delete gate, contamination detection
- `--full` flag for extended validation (B08 cross-checks)

### Changed
- `brain-cli validate` now reports per-field error details

## [1.0.0] - 2025-02-10

### Added
- Initial release
- `brain-cli write` — BWT 9-step transactional write engine
- `brain-cli validate` — index integrity verification
- `brain-cli init` — Brain directory initialization (idempotent)
- 14-field record schema with scope, tags, and lifecycle
- JSONL index with manifest and digest
- Atomic rename with auto-rollback on failure
- `postinstall` hook for automatic `~/Brain/` setup
