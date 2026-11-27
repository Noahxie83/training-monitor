# Contributing to Training Monitor

Thank you for your interest in contributing to **Training Monitor**! This guide covers local setup, architectural boundaries, and verification expectations so pull requests land smoothly.

## Development Setup

1. **Prerequisites**
   - Node.js `>= 22` (Node 24 recommended)
   - Python `>= 3.7` (Python 3.12 recommended for running probe/launcher tests)
2. **Install dependencies**
   ```bash
   npm ci
   ```
3. **Run in development mode**
   ```bash
   npm run dev
   # Or test with isolated demo data:
   npm start -- --demo
   ```

## Architecture Boundaries

- `src/shared/` — Runtime-validated contracts shared between main, preload, worker, and renderer.
- `src/transport/` & `src/probe/` — Persistent multiplexed stdio transport (`TMF1` framing) and zero-daemon Python probe. Keep remote probing read-only by default and strictly parameterize all subprocess invocations (`shell=False` / argv arrays).
- `src/domain/` & `src/parsers/` — Pure TypeScript attribution, progress, checkpoint, and log parsing logic with zero Node/DOM side effects.
- `src/store/` — SQLite v2 worker with WAL read/write separation, FTS5 search, time-series LTTB downsampling, and incremental background migration.
- `src/renderer/` — React 19 UI following [DESIGN.md](./DESIGN.md). All user-visible strings must live in both `src/renderer/i18n/zh-CN.ts` and `src/renderer/i18n/en-US.ts`; keep styles modular under `src/renderer/styles/` without `!important` overrides or hardcoded colors outside `tokens.css`.
- `src/desktop/` — Electron main process, tray, window geometry, native notifications, and strictly validated IPC channels.

## Verification Before Opening a PR

Please run the relevant checks locally (and ensure zero personal paths or host aliases enter `src/`):

```bash
npm run typecheck
npm run test:unit
npm run test:python
npm run build
npm run test:runtime
npm run test:desktop
```

- When touching UI layouts, tokens, or components, verify both **Atelier Light** and **Obsidian Dark** themes across `1440×900`, `1280×800`, and `960×650` via `npm run test:desktop`.
- Commit messages follow Conventional Commits (`feat(...)`, `fix(...)`, `docs(...)`, `test(...)`, `chore(...)`).
