# Training Monitor — Design System & UI Specification (Phase 3)

Training Monitor adopts a unified, bilingual (**zh-CN / en-US**) telemetry workstation design system built around two cohesive palettes — **Atelier Precision Light** and **Obsidian Telemetry Studio** — sharing one single structural layout across light and dark themes.

---

## 1. Typography & Local Offline Fonts

- **UI Sans**: `Inter` (`400 / 500 / 600 / 700`), locally bundled WOFF2 in `src/renderer/assets/fonts/` (`@font-face` in `src/renderer/styles/tokens.css`), falling back cleanly to `'PingFang SC'`, `'Microsoft YaHei UI'`, `'Noto Sans CJK SC'`, system sans.
- **Technical Monospace**: `JetBrains Mono` (`400 / 500 / 600`), locally bundled WOFF2 in `src/renderer/assets/fonts/`, applied strictly to logs, numeric readouts, PIDs, step counters, file paths, regex inputs, and tmux commands.
- **100% Offline CSP Compliance**: Zero external Google Fonts or CDN links; `index.html` enforces `default-src 'self'; font-src 'self'`.
- **Tabular Numerals**: All dynamic numeric KPIs, percentages, clocks, VRAM counters, and log timestamps use `font-variant-numeric: tabular-nums` to prevent horizontal jitter during live updates.

### Type Scale (5 Levels)

| Role | Size | Weight | Font |
| :--- | :---: | :---: | :--- |
| Page / Task Title | `18px` (`16px` ≤ 1024px) | `600` | Inter |
| KPI Hero Figure | `20px` (`18px` ≤ 1024px) | `600` | JetBrains Mono (`tabular-nums`) |
| Section Heading | `12px` | `600` | Inter (`letter-spacing: 0.02em`) |
| Body / Controls | `13px` | `400 / 500` | Inter |
| Technical / Log Stream | `12px` (`1.6` line-height) | `400` | JetBrains Mono |

---

## 2. Color Palette & Three-Layer Surface Depth

Light and Dark themes use strictly matching 3-layer elevation tokens (`--bg-canvas` / `--bg-surface` / `--bg-elevated`), recessed `--bg-inset` log wells, and high-contrast `--accent-ink` on primary fills (WCAG AAA ≥ 7:1).

| Token | Atelier Light (`data-theme="light"`) | Obsidian Dark (`data-theme="dark"`) | Usage |
| :--- | :--- | :--- | :--- |
| `--bg-canvas` | `#F4F5F7` | `#0E1014` | App shell background & main canvas |
| `--bg-sidebar` | `#ECEEF2` | `#12151B` | Left fleet tree sidebar |
| `--bg-surface` | `#FFFFFF` | `#161A22` | Telemetry cards, GPU cards, modals |
| `--bg-elevated` | `#FFFFFF` | `#1E232E` | Popovers, menus, floating jump pill |
| `--bg-inset` | `#F8FAFC` | `#0A0C10` | Recessed terminal log stream well & chart plot |
| `--bg-hover` | `#F1F3F6` | `#1F2430` | Interactive hover backgrounds |
| `--border-subtle` | `#E4E7EC` | `#232836` | Card hairlines and panel dividers |
| `--border-strong` | `#CBD2DC` | `#333B4D` | Inputs, buttons, active outlines |
| `--text-primary` | `#0F172A` | `#F1F5F9` | Primary headings & values |
| `--text-secondary` | `#475569` | `#94A3B8` | Labels, metadata, secondary copy |
| `--text-muted` | `#64748B` | `#64748B` | Timestamps, placeholders, captions |
| `--accent` | `#2563EB` | `#60A5FA` | Primary actions, active selections, focus rings |
| `--accent-ink` | `#FFFFFF` | `#0B1120` | Foreground text on `--accent` backgrounds |
| `--status-running` | `#059669` | `#34D399` | Active training, connected host |
| `--status-warning` | `#D97706` | `#FBBF24` | Queued, stale, countdown, high load |
| `--status-danger` | `#DC2626` | `#F87171` | Disconnected, OOM/crash, error logs |

### 4-Tier GPU Load Color Scale

- **Idle (`0–10%`)**: `--load-idle` (`#10B981` light / `#34D399` dark)
- **Active (`11–70%`)**: `--load-active` (`#3B82F6` light / `#60A5FA` dark)
- **High (`71–90%`)**: `--load-high` (`#F59E0B` light / `#FBBF24` dark)
- **Critical (`91–100%`)**: `--load-critical` (`#EF4444` light / `#F87171` dark)

---

## 3. Optical Iconography & Chrome Integration

- **Icons**: All UI icons are rendered via `lucide-react` inside `src/renderer/components/Icon.tsx` (`strokeWidth={1.75}`, crisp `12–16px` sizing). Zero bare Unicode symbols (`↑`, `↓`, `⏳`, `✓`, `✕`, `●`, `⚙`, `▶`, `⏸`) appear in controls.
- **Electron Integrated Titlebar & Theme Sync**:
  - `src/desktop/window.ts` enables frameless integrated chrome (`titleBarStyle: 'hidden'` + `titleBarOverlay` on Windows; `titleBarStyle: 'hiddenInset'` on macOS) with `-webkit-app-region: drag` on `.app-header` and `no-drag` on interactive controls.
  - Window background color, `nativeTheme.themeSource`, and Windows `titleBarOverlay` colors synchronize automatically on startup and whenever preferences change (`syncWindowTheme`).
- **Anti-Flash Theme Switching**: Switching themes adds `.theme-switching` to `document.documentElement` for a single animation frame (`* { transition: none }`), completely eliminating white-flash transitions on dark buttons.
- **Custom Scrollbars**: Thin `6px` theme-adaptive custom scrollbars across sidebar, main scroll areas, log viewport, and modals.
- **Modular CSS Architecture**: `src/renderer/style.css` imports 9 focused modules under `src/renderer/styles/` (`tokens.css`, `base.css`, `primitives.css`, `layout.css`, `sidebar.css`, `cockpit.css`, `gpu.css`, `logs.css`, `overlays.css`) with **zero `!important` overrides** and zero missing class definitions.

---

## 4. Unified Layout & Core Views

### Unified Structural Geometry (No Light/Dark Layout Mutation)

Both Light and Dark themes share the exact same layout hierarchy:
1. **44px Deduplicated Top Header (`Header.tsx`)**: Brand + subtle `DEMO` badge (demo mode only), active host breadcrumb (`PLATFORM` badge + display name + optional task name) + inline status pill opening a diagnostic popover, and right-aligned action cluster (Process Discovery, Standalone GPU Window, Refresh with spin feedback, Alert Bell + unread badge + popover, `EN/中` Language Toggle, Theme Toggle, Settings).
2. **Collapsible Inline Host Alert Strip (`HostConnectionPanel.tsx`)**: `0px` height when the selected host is healthy and connected; automatically appears only for disconnects, disabled hosts, pending connections, or probe errors.
3. **248px Left Fleet Sidebar (`TaskFleetTree.tsx`)**: Host groups with platform badge + display name, non-overlapping action buttons vs right summary badges, task list with pulsing running dot + algorithm subtitle + accessible portal menu, and a bottom fleet online/running status footer with quick `+ Add Host`.

### Task Cockpit (`TaskCockpit.tsx`)

- **Header**: Task name, lifecycle badge, attribution confidence pill (`已确认进程` / `进程树推断` / `仅日志追踪`), algorithm badge, working directory, and action cluster (Open Terminal / SSH / tmux, Auto-Start, optional Job Control when `host.allowJobControl === true`, Copy Path, Task Details).
- **Compact Auto-Start Strip (`AutoStartPanel.tsx`)**: 2-row high-density banner with condition chips, `Continues offline` server-tmux indicator, live linear countdown bar, and collapsible copyable `tmux attach` command.
- **Unified 2-Column Telemetry Row**:
  - **Left Card**: Adaptive `DualProgressBar` (renders a single progress track unless resumed-session evidence exists) + 4-cell tabular monospace `KpiMetricsGrid` (Step, Loss / LR, 2-decimal throughput, humanized ETA) + compact Checkpoint row.
  - **Right Card**: Interactive SVG `TrainingChart` (`Loss` / `Eval Loss` / `LR` / `Throughput` with EMA smoothing & crosshair hover tooltip) and `ResourceMetrics` (process-attributed GPU cards + collapsible process tree). Displayed as segmented tabs on `< 1440px` and side-by-side split on `>= 1440px` when curve data is present.
- **Terminal-Grade Log Console (`LogConsole.tsx`)**: Always visible above the fold (`>= 180px` even at `960×650`). Recessed `--bg-inset` surface, `JetBrains Mono`, virtualized dynamic rows (`@tanstack/react-virtual`), safe ANSI 16/256/TrueColor rendering (`src/renderer/utils/ansi.ts`, zero `dangerouslySetInnerHTML`), level filter capsules (`ALL` / `ERR` / `WARN` / `INFO`), bordered search with `Aa` case & `.*` regex toggles, `<mark>` highlighting, match counter + prev/next navigation, readable filename source tabs, `\r` in-place redraw, wrap/lock/export/clear/refresh controls, centered empty states, and bottom-right floating jump-to-bottom capsule.

### Host Overview & Standalone GPU Monitor (`HostOverview.tsx`, `GpuMonitor.tsx`)

- **Fleet Summary Strip (`FleetSummaryStrip.tsx`)**: 4 KPI tiles (Idle GPUs, Total VRAM Used/Total, Average Utilization, Peak Temperature), Host CPU / RAM / Disk micro-bars, and `All / Idle Only` filter toggle.
- **Natural-Height GPU Cards (`ResourceMetrics.tsx`)**: Eliminates artificial `min-height` whitespace; displays card ID + short model name, 4-tier load badge, temperature & power draw/limit, utilization meter + restored visible VRAM meter (`.gpu-memory-meter`), 15-minute dual-line SVG `Sparkline`, and active GPU process tags with click-to-jump to monitored tasks.
- **Responsive Breakpoints**: Standalone GPU window adapts cleanly across native `maximize`, `unmaximize`, and `setContentSize` (`<= 700px`: 1 col, `701–1499px`: 2 cols, `>= 1500px`: 4 cols).

### Settings, Forms & Technical Details

- **Tabbed Settings (`SettingsModal.tsx`)**: 3 tabs — **Appearance & Language** (theme cards with palette swatches, `zh-CN / en-US` toggle, tray/autostart behavior), **Hosts** (card-based host management with SSH/WSL discovery, `pollIntervalMs`, opt-in `allowJobControl`, and mandatory secondary confirmation dialog when deleting hosts with tasks), and **Alerts & Webhooks** (desktop notifications, rule toggles, thresholds, webhook editor + live test send).
- **Progressive Task Editor (`TaskEditor.tsx` & `AutoStartFields.tsx`)**: Quick-import banner from running GPU processes (`ProcessDiscoveryModal`), auto-slug `taskId`, full-width monospace path inputs with inline validation, collapsible Advanced options (`<optgroup>` legacy formats, path mode, custom regexes), and 3-section Auto-Start configuration (`Trigger Conditions`, `Launch Command & Environment` with script/module/command switch & KV env editor, and `Collapsible Advanced`).
- **Streamlined Technical Details Drawer (`EvidenceDrawer.tsx`)**: Clean KV tables with one-click copy chips for attribution, process tree, log cursors, checkpoint metadata, queue lock, and evidence chain (no duplicated `<ResourceMetrics />`).

---

## 5. Verification Matrix

All UI changes are verified via automated unit tests (`vitest`) and real Electron Playwright visual audits across **`1440×900`**, **`1280×800`**, and **`960×650`** in both **Light** and **Dark** themes covering:
1. Host Overview (8 GPUs + Fleet Summary Strip + Sparklines + Empty-task onboarding)
2. Task Cockpit (Progress + Training Chart + Process GPU + ANSI Log Console + Auto-Start Countdown)
3. Task Editor & Auto-Start Modal
4. Settings Modal (all 3 tabs) & Process Discovery Modal
5. Standalone GPU Window (normal + native maximized)
