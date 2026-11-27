# Training Monitor — Design System & UI Specification

Training Monitor adopts a unified, bilingual (**zh-CN / en-US**) telemetry workstation design system built around two cohesive palettes — **Atelier Precision Light** and **Obsidian Telemetry Studio Dark** — sharing one single structural layout across light and dark themes.

---

## 1. Typography & Local Offline Fonts

- **UI Sans (`--font-sans`)**: `'Inter'` (`400 / 500 / 600 / 700`), locally bundled WOFF2 in `src/renderer/assets/fonts/` (`@font-face` in `src/renderer/styles/tokens.css`), falling back cleanly to `'PingFang SC'`, `'Noto Sans SC'`, `'Microsoft YaHei UI'`, `system-ui`, `-apple-system`, `sans-serif`.
- **Technical Monospace (`--font-mono`)**: `'JetBrains Mono'` (`400 / 500 / 600`), locally bundled WOFF2 in `src/renderer/assets/fonts/`, applied strictly to logs, numeric readouts, PIDs, step counters, file paths, regex inputs, and tmux commands.
- **100% Offline CSP Compliance**: Zero external Google Fonts or CDN links; `index.html` enforces `default-src 'self'; font-src 'self'`.
- **Tabular Numerals**: All dynamic numeric KPIs, percentages, clocks, VRAM counters, and log timestamps use `font-variant-numeric: tabular-nums` to prevent horizontal jitter during live updates.

### Type Scale (Tokens in `src/renderer/styles/tokens.css`)

| Role | Token | Size | Weight | Font |
| :--- | :--- | :---: | :---: | :--- |
| Page / Task Title | `--text-page-title` | `20px` (`16px` ≤ 1050px) | `600` | Inter |
| KPI Hero Figure | `--text-hero-kpi` | `22px` (`17px` cockpit / `14px` ≤ 1050px) | `600` | JetBrains Mono (`tabular-nums`) |
| Section Heading | `--text-section` | `14px` | `600` | Inter |
| Body / Controls | `--text-body` | `13px` | `400 / 500` | Inter |
| Meta / Log Stream | `--text-meta` | `12px` (`22px` log line-height) | `400 / 500` | Inter / JetBrains Mono |
| Log Timestamps / Dense Meta | `--text-log-meta` | `11.5px` | `400 / 500` | JetBrains Mono (`tabular-nums`) |

---

## 2. Color Palette & Surface Depth

Light and Dark themes use strictly matching surface tokens (`--bg-canvas`, `--bg-sidebar`, `--bg-surface`, `--bg-surface-hover`, `--bg-surface-active`, `--bg-inset`, `--bg-header`), recessed `--bg-inset` log wells, and high-contrast ink tokens (`--accent-ink`, `--danger-ink`) on solid accent/danger fills (WCAG AAA ≥ 7:1).

| Token | Atelier Light (`data-theme="light"`) | Obsidian Dark (`data-theme="dark"`) | Usage |
| :--- | :--- | :--- | :--- |
| `--bg-canvas` | `#F4F5F7` | `#0E1014` | App shell background & main canvas |
| `--bg-sidebar` | `#ECEEF2` | `#12151B` | Left fleet tree sidebar & GPU host tabs |
| `--bg-surface` | `#FFFFFF` | `#161A22` | Telemetry cards, GPU cards, popovers, modals |
| `--bg-surface-hover` | `#F8F9FB` | `#1D222D` | Interactive hover backgrounds |
| `--bg-surface-active` | `#E4E8F0` | `#232A38` | Selected/pressed host & control states |
| `--bg-inset` | `#F1F3F6` | `#0B0D11` | Recessed terminal log stream well, inputs, chart plot |
| `--bg-header` | `#FFFFFF` | `#161A22` | 44px integrated titlebar & GPU toolbar |
| `--border-subtle` | `rgba(15, 23, 42, 0.08)` | `rgba(255, 255, 255, 0.08)` | Card hairlines and panel dividers |
| `--border-strong` | `rgba(15, 23, 42, 0.16)` | `rgba(255, 255, 255, 0.15)` | Inputs, buttons, modal borders, active outlines |
| `--text-primary` | `#111827` | `#F1F5F9` | Primary headings & values |
| `--text-secondary` | `#4B5563` | `#94A3B8` | Labels, metadata, secondary copy |
| `--text-muted` | `#6B7280` | `#64748B` | Timestamps, placeholders, captions |
| `--accent-primary` | `#2563EB` | `#60A5FA` | Primary actions, active selections, focus rings |
| `--accent-primary-hover` | `#1D4ED8` | `#93C5FD` | Primary button hover fill |
| `--accent-ink` | `#FFFFFF` | `#0B1120` | Foreground text on `--accent-primary` fills |
| `--status-running` | `#059669` | `#34D399` | Active training, connected host |
| `--status-warning` | `#D97706` | `#FBBF24` | Queued, stale, countdown, high load |
| `--status-danger` | `#DC2626` | `#F87171` | Disconnected, OOM/crash, error logs, danger actions |
| `--danger-ink` | `#FFFFFF` | `#0B1120` | Foreground text on solid `--status-danger` fills (hover danger buttons, alert badge) |
| `--status-info` | `#2563EB` | `#60A5FA` | Confirmed attribution & informational notices |
| `--status-neutral` | `#6B7280` | `#94A3B8` | Stopped / ready / unobserved neutral states |

### 4-Tier GPU Load Color Scale

- **Idle (`0–10%`)**: `--load-idle` (`#059669` light / `#34D399` dark)
- **Active (`11–70%`)**: `--load-active` (`#2563EB` light / `#60A5FA` dark)
- **High (`71–90%`)**: `--load-high` (`#D97706` light / `#FBBF24` dark)
- **Critical (`91–100%`)**: `--load-critical` (`#DC2626` light / `#F87171` dark)
- **Unknown**: `--load-unknown` (`#94A3B8` light / `#475569` dark)

---

## 3. Optical Iconography & Chrome Integration

- **Icons**: All UI icons are rendered via `lucide-react` inside `src/renderer/components/Icon.tsx` (`strokeWidth={1.75}`, crisp `12–16px` sizing). Zero bare Unicode symbols (`↑`, `↓`, `⏳`, `✓`, `✕`, `●`, `⚙`, `▶`, `⏸`) appear in controls.
- **Electron Integrated Titlebar & Safe Area**:
  - `src/desktop/window.ts` enables frameless integrated chrome (`titleBarStyle: 'hidden'` + `titleBarOverlay` on Windows; `titleBarStyle: 'hiddenInset'` on macOS) with `-webkit-app-region: drag` on `.app-header` / `.gpu-monitor-toolbar` and `no-drag` on interactive controls.
  - Both `.app-header` and `.gpu-monitor-toolbar` (including `@media (max-width: 700px)`) preserve `env(titlebar-area-x)` / `env(titlebar-area-width)` and apply a `78px` left safe-area inset (`html.platform-darwin { --titlebar-inset-left: 78px }`) for macOS traffic-light buttons.
  - Window background color, `nativeTheme.themeSource`, and Windows `titleBarOverlay` colors synchronize automatically on startup and whenever preferences change (`syncWindowTheme`).
- **Anti-Flash Theme Switching**: Switching themes adds `.theme-switching` to `document.documentElement` for a single animation frame (`* { transition: none }`), completely eliminating white-flash transitions on dark buttons.
- **Custom Scrollbars**: Thin `6px` theme-adaptive custom scrollbars across sidebar, main scroll areas, log viewport, and modals.
- **Modular CSS Architecture**: `src/renderer/style.css` imports **10 focused modules** under `src/renderer/styles/` (`tokens.css`, `base.css`, `primitives.css`, `layout.css`, `sidebar.css`, `cockpit.css`, `gpu.css`, `logs.css`, `overlays.css`, `recovery.css`) with **zero `!important` overrides** and zero undefined class references.

---

## 4. Unified Layout & Core Views

### Unified Structural Geometry (No Light/Dark Layout Mutation)

Both Light and Dark themes share the exact same layout hierarchy:
1. **44px Deduplicated Top Header (`Header.tsx`)**: Brand + subtle `DEMO` badge (demo mode only), active host breadcrumb (`PLATFORM` badge + display name + optional task name) + inline status pill opening a diagnostic popover, and right-aligned action cluster (Process Discovery, Standalone GPU Window, Refresh with spin feedback, Alert Bell + unread badge + popover, `EN/中` Language Toggle, Theme Toggle, Settings).
2. **Collapsible Inline Host Alert Strip (`HostConnectionPanel.tsx`)**: `0px` height when the selected host is healthy and connected; automatically appears only for disconnects, disabled hosts (jumping directly to Host Settings), pending connections, or probe errors.
3. **232px Left Fleet Sidebar (`TaskFleetTree.tsx`, `210px` ≤ 1100px)**: Host groups (`role="group"` containing leaf `role="treeitem"` rows) with platform badge + display name, non-overlapping action buttons vs right summary badges, task list with pulsing running dot + algorithm subtitle + accessible portal menu, and a bottom fleet online/running status footer with quick `+ Add Host`.

### Task Cockpit (`TaskCockpit.tsx`)

- **Header**: Task name, lifecycle badge, attribution confidence pill (`已确认进程` / `进程树推断` / `仅日志追踪`), algorithm badge, working directory, and action cluster (Terminal split button with dropdown to copy `SSH` / `tmux attach` / `tail -f`, Auto-Start, optional Job Control `Stop` / `Kill (SIGKILL)` / `Restart` when `host.allowJobControl === true`, Copy Path, Task Details). At `<= 1050px`, secondary labels collapse to crisp icon buttons and title/location stay single-line so the log console remains generously visible above the fold even at `960×650`.
- **Compact Auto-Start Strip (`AutoStartPanel.tsx`)**: 2-row high-density banner with condition chips, `Continues offline` server-tmux indicator, live linear countdown bar, and collapsible copyable `tmux attach` command (via Electron IPC clipboard with fallback).
- **Unified 2-Column Telemetry Row**:
  - **Left Card**: Adaptive `DualProgressBar` (renders a single progress track unless resumed-session evidence exists) + 4-cell tabular monospace `KpiMetricsGrid` (Step, Loss / LR, 2-decimal throughput, humanized ETA) + compact Checkpoint row.
  - **Right Card**: Interactive SVG `TrainingChart` (`Loss` / `Eval Loss` / `LR` / `Throughput` with EMA smoothing & crosshair hover tooltip) and `ResourceMetrics` (process-attributed GPU cards + collapsible process tree). Displayed as accessible segmented tabs (`aria-controls` / `tabpanel`) on `< 1440px` or whenever no curve data is present, and side-by-side split (`.is-wide-split`) on `>= 1440px` once curve data is available.
- **Terminal-Grade Log Console (`LogConsole.tsx`)**: Always visible above the fold (`>= 5` lines visible even at `960×650`). Recessed `--bg-inset` surface, `JetBrains Mono`, virtualized dynamic rows (`@tanstack/react-virtual`), safe ANSI 16/256/TrueColor rendering (`src/renderer/utils/ansi.ts`, zero `dangerouslySetInnerHTML`), level filter capsules (`ALL` / `ERR` / `WARN` / `INFO`), bordered search with `Aa` case & `.*` regex toggles, cross-ANSI-segment `<mark>` highlighting, match counter + prev/next navigation, readable filename source tabs, `\r` in-place redraw, wrap/lock/export (native Save dialog with silent cancel)/clear/refresh controls, centered empty states, and bottom-right floating jump-to-bottom capsule.

### Host Overview & Standalone GPU Monitor (`HostOverview.tsx`, `GpuMonitor.tsx`)

- **Fleet Summary Strip (`FleetSummaryStrip.tsx`)**: 4 KPI tiles (Idle GPUs, Total VRAM Used/Total, Average Utilization, Peak Temperature), Host CPU / RAM / Disk micro-bars, and `All / Idle Only` filter toggle.
- **Natural-Height GPU Cards (`ResourceMetrics.tsx`)**: Eliminates artificial `min-height` whitespace; displays card ID + short model name, 4-tier load badge, temperature & power draw/limit, utilization meter + restored visible VRAM meter (`.gpu-memory-meter`), 15-minute dual-line SVG `Sparkline` (anchored cleanly across valid non-null samples), and active GPU process tags with click-to-jump to monitored tasks.
- **Responsive Breakpoints**: Standalone GPU window adapts cleanly across native `maximize`, `unmaximize`, and `setContentSize` (`<= 700px`: 1 col, `701–1499px`: 2 cols, `>= 1500px`: 4 cols).

### Settings, Forms & Technical Details

- **Tabbed Settings (`SettingsModal.tsx`)**: 3 accessible tabs (`aria-controls` / `tabpanel`) — **Appearance & Language** (theme cards with palette swatches, `zh-CN / en-US` toggle with live `document.title` sync, tray/autostart behavior), **Hosts** (card-based host management with SSH/WSL discovery, `IdentityFile`/`ProxyJump` editing, `pollIntervalMs` with clean reset to 5s default, revocable opt-in `allowJobControl`, centered focused delete-host confirmation modal, and offline `HOST_UNREACHABLE_RECONCILE` → `forceLocal` confirmation modal), and **Alerts & Webhooks** (desktop notifications, rule toggles, string-draft numeric thresholds validated on save, webhook enabled toggle + label + URL editor + live test send).
- **Progressive Task Editor (`TaskEditor.tsx` & `AutoStartFields.tsx`)**: Quick-import banner from running GPU processes (`ProcessDiscoveryModal`), auto-slug `taskId`, full-width monospace path inputs with `allowedRoots` boundary validation, collapsible Advanced options (`<optgroup>` legacy formats, path mode, `allowCrossUidScan`, custom regexes), and 3-section Auto-Start configuration (`Trigger Conditions`, `Launch Command & Environment` with script/module/command switch, `Environment Modules`, & KV env editor, and `Collapsible Advanced`).
- **Streamlined Technical Details Drawer (`EvidenceDrawer.tsx`)**: Clean KV tables with one-click IPC copy chips for attribution, process tree, log cursors, checkpoint metadata, queue lock, and evidence chain.

---

## 5. Verification Matrix

All UI changes are verified via automated unit tests (`vitest`) and real Electron Playwright visual audits across **`1440×900`**, **`1280×800`**, and **`960×650`** in both **Light** and **Dark** themes covering:
1. Host Overview (8 GPUs + Fleet Summary Strip + Sparklines + Empty-task onboarding)
2. Task Cockpit (Progress + Training Chart + Process GPU + ANSI Log Console + Auto-Start Countdown)
3. Task Editor & Auto-Start Modal
4. Settings Modal (all 3 tabs) & Process Discovery Modal
5. Standalone GPU Window (normal + native maximized)
