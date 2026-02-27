# Contributing to Brain CLI

Thank you for your interest in contributing to Brain CLI! This guide will help you get started.

## Development Setup

```bash
# Clone the repository
git clone https://github.com/ernham1/brain-cli.git
cd brain-cli

# Install dependencies
cd src/brain-cli
npm install

# Run tests
npm test

# Run linter
npm run lint
```

## Project Structure

```
src/brain-cli/
  src/
    index.js        CLI entry point (commander.js)
    bwt.js          BWT 9-step transaction engine
    schemas.js      Record schema (14 fields) + Intent validation
    validate.js     Index integrity verification
    boot.js         4-stage boot sequence
    search.js       6-stage optimized search
    init.js         Brain directory initialization (idempotent)
    lifecycle.js    Status transitions, delete gate, contamination detection
    kpi.js          K1-K4 KPI metrics
    setup.js        Interactive persona setup
    persona.js      Persona schema and generation
    utils.js        Shared utilities (hash, recordId, JSONL I/O)
  test/
    *.test.js       Test files (one per module)
  scripts/
    postinstall.js  Post-install hook (init + CLAUDE.md injection)
```

## Coding Conventions

- **Runtime**: Node.js >= 20 (use built-in `node:test`, `node:fs`, `node:path`)
- **Module system**: CommonJS (`require` / `module.exports`)
- **Test framework**: `node:test` + `node:assert` (no external test runner)
- **Linter**: ESLint 9 flat config
- **No TypeScript** — plain JavaScript with JSDoc comments where helpful
- **No external dependencies** in core modules — only `commander` and `@inquirer/prompts` for CLI

## How to Contribute

### Bug Reports

1. Search [existing issues](https://github.com/ernham1/brain-cli/issues) first
2. Include: Node.js version, OS, steps to reproduce, expected vs actual behavior
3. If possible, include the error output from the CLI

### Feature Requests

1. Open an issue with the `enhancement` label
2. Describe the use case and why it would be valuable
3. If you have a design in mind, sketch the API or CLI interface

### Pull Requests

1. Fork the repo and create a feature branch from `main`
2. Write tests for new functionality (`test/<module>.test.js`)
3. Ensure all tests pass: `npm test`
4. Ensure linting passes: `npm run lint`
5. Keep commits focused — one logical change per commit
6. Write a clear PR description explaining the "why"

### Code Style

- Keep functions small and focused
- Prefer early returns over deep nesting
- Error messages should be actionable — tell the user what to do
- BWT steps must maintain the backup/rollback contract

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
