# Security Policy

## Security Architecture

Training Monitor is designed around defense-in-depth for developers monitoring sensitive ML clusters:

- **Read-Only Default**: Passive monitoring (`readonly_probe.py`) inspects `/proc`, GPU telemetry, checkpoints, and registered log files strictly read-only.
- **No Arbitrary Shell Injection**: SSH/WSL/local commands and remote auto-start invocations use validated argv arrays (`shell=False`) with strict allowlists on SSH host aliases, `ProxyJump` hops, and interpreter paths.
- **Scoped Filesystem Access**: Log reads, glob/symlink resolution, and checkpoint scans verify canonical `realpath` boundaries against each host's `allowedRoots` and each task's `allowedDirectories`.
- **Opt-In Audited Job Control**: Remote process signaling (`SIGINT`, `SIGTERM`, `SIGKILL`, `restart`) is disabled by default, requires explicit per-host opt-in (`allowJobControl: true`) plus secondary confirmation, verifies `(hostBootId, pid, startTicks, uid)` before signaling, and appends every action to `job-control-audit.jsonl`.
- **Hardened Electron Shell**: All windows enforce `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP (`default-src 'self'; object-src 'none';`), denied web permission requests, single-origin IPC sender checks, and bounded per-window IPC subscriptions.

## Reporting a Vulnerability

If you discover a security vulnerability (such as command injection, path traversal outside `allowedRoots`, IPC sandbox escape, or credential exposure), please **do not** open a public issue.

Instead, report it privately via GitHub Security Advisories on the repository (**Security → Advisories → Report a vulnerability**) with:

- A clear description of the issue and affected files/versions
- Minimal reproduction steps or proof-of-concept
- Potential impact and suggested remediation (if known)

We will acknowledge reports promptly and coordinate a fix before public disclosure.
