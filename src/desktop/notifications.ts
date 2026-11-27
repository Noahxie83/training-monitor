import { Notification } from 'electron';
import { spawn as nodeSpawn } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { AlertEvent, HostRegistration, JobControlAuditEntry, TaskRegistration } from '../shared/contracts';
import type { CopyCommandKind } from '../shared/api';

export type { JobControlAuditEntry };

/** Append an immutable JSONL audit record for every remote job control request. */
export async function appendJobControlAudit(userDataDir: string, entry: JobControlAuditEntry): Promise<void> {
  await mkdir(userDataDir, { recursive: true });
  const auditPath = path.join(userDataDir, 'job-control-audit.jsonl');
  await appendFile(auditPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
}

/** Show an Electron native desktop notification that focuses the target task when clicked. */
export function showDesktopAlert(
  alert: AlertEvent,
  onFocusTask: (taskId: string | null, hostId: string) => void,
): boolean {
  try {
    if (!Notification.isSupported()) return false;
    const notification = new Notification({
      title: alert.title,
      body: alert.message,
      silent: alert.severity === 'info',
    });
    notification.on('click', () => {
      onFocusTask(alert.taskId, alert.hostId);
    });
    notification.show();
    return true;
  } catch {
    return false;
  }
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sshTargetArgs(host: HostRegistration): string[] {
  if (host.target.kind !== 'ssh') return [];
  if (host.target.alias) return [host.target.alias];
  const args: string[] = [];
  if (host.target.port) args.push('-p', String(host.target.port));
  if (host.target.identityFile) args.push('-i', host.target.identityFile);
  if (host.target.proxyJump) args.push('-J', host.target.proxyJump);
  const dest = host.target.user ? `${host.target.user}@${host.target.hostname}` : host.target.hostname!;
  args.push(dest);
  return args;
}

/** Build a read-only copyable shell command for SSH login, tmux attach, or tail -f. */
export function buildHelperCommand(
  kind: CopyCommandKind,
  host: HostRegistration,
  task?: TaskRegistration,
  sourceId?: string,
  sessionName?: string | null,
): string {
  const sshArgs = sshTargetArgs(host).map((arg) => (/^[A-Za-z0-9_@.:/-]+$/.test(arg) ? arg : posixQuote(arg)));
  const sshPrefix = host.target.kind === 'ssh' ? `ssh ${sshArgs.join(' ')}` : host.target.kind === 'wsl' ? `wsl -d ${posixQuote(host.target.distribution)}` : '';

  if (kind === 'ssh') {
    return host.target.kind === 'ssh' ? `ssh -t ${sshArgs.join(' ')}` : sshPrefix || 'bash';
  }
  if (kind === 'tmux_attach') {
    const targetSession = sessionName || 'main';
    const managed = /^tm-wait-[a-f0-9]{40}$/.test(targetSession);
    const attach = 'd=/tmp/training-monitor-$(id -u); ' +
      'case "$XDG_RUNTIME_DIR" in /*) if [ "${#XDG_RUNTIME_DIR}" -lt 70 ] && ' +
      '[ -S "$XDG_RUNTIME_DIR/training-monitor/tmux.sock" ]; then d="$XDG_RUNTIME_DIR/training-monitor"; fi;; esac; ' +
      'exec tmux -S "$d/tmux.sock" attach -t "$1"';
    const remoteCmd = managed
      ? `sh -c ${posixQuote(attach)} _ ${posixQuote(targetSession)}`
      : `tmux attach -t ${posixQuote(targetSession)}`;
    if (host.target.kind === 'ssh') return `ssh -t ${sshArgs.join(' ')} ${posixQuote(remoteCmd)}`;
    if (host.target.kind === 'wsl') return `wsl -d ${posixQuote(host.target.distribution)} -- ${remoteCmd}`;
    return remoteCmd;
  }
  // tail_log
  const source = task?.sources.find((s) => (sourceId ? s.sourceId === sourceId : s.kind === 'log'));
  const logPath = source?.path ?? '/var/log/train.log';
  const tailCmd = `tail -n 100 -f ${posixQuote(logPath)}`;
  if (host.target.kind === 'ssh') return `ssh ${sshArgs.join(' ')} ${posixQuote(tailCmd)}`;
  if (host.target.kind === 'wsl') return `wsl -d ${posixQuote(host.target.distribution)} -- ${tailCmd}`;
  return tailCmd;
}

/** Open a local OS terminal running read-only SSH / WSL / local shell without shell injection. */
export async function openLocalSshTerminal(
  host: HostRegistration,
  remoteCommand?: string,
  options: { platform?: NodeJS.Platform; spawn?: typeof nodeSpawn } = {},
): Promise<{ ok: boolean; command: string; error: string | null }> {
  const platform = options.platform ?? process.platform;
  const spawnFn = options.spawn ?? nodeSpawn;

  let argv: string[];
  if (host.target.kind === 'ssh') {
    argv = ['ssh', '-t', ...sshTargetArgs(host)];
    if (remoteCommand && !/[\u0000-\u001f\u007f]/.test(remoteCommand)) {
      argv.push(remoteCommand);
    }
  } else if (host.target.kind === 'wsl') {
    argv = ['wsl.exe', '-d', host.target.distribution];
    if (remoteCommand && !/[\u0000-\u001f\u007f]/.test(remoteCommand)) argv.push('--', 'bash', '-lc', remoteCommand);
  } else {
    argv = remoteCommand && !/[\u0000-\u001f\u007f]/.test(remoteCommand) ? ['bash', '-lc', remoteCommand] : ['bash'];
  }
  const command = argv.map((arg) => (/^[A-Za-z0-9_@.:/-]+$/.test(arg) ? arg : posixQuote(arg))).join(' ');

  let terminals: [string, string[]][];
  if (platform === 'win32') {
    const quotePowerShell = (value: string) => "'" + value.replace(/'/g, "''") + "'";
    const encoded = Buffer.from('& ' + argv.map(quotePowerShell).join(' '), 'utf16le').toString('base64');
    terminals = [
      ['wt.exe', argv],
      ['powershell.exe', ['-NoProfile', '-NoExit', '-EncodedCommand', encoded]],
    ];
    if (argv.every((arg) => /^[A-Za-z0-9_@.:/\\ ,-]+$/.test(arg))) {
      terminals.push(['cmd.exe', ['/d', '/k', ...argv]]);
    }
  } else if (platform === 'darwin') {
    const cmdLine = argv.map(posixQuote).join(' ');
    terminals = [['osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(cmdLine)}`]]];
  } else {
    terminals = [
      ['x-terminal-emulator', ['-e', ...argv]],
      ['gnome-terminal', ['--', ...argv]],
      ['konsole', ['-e', ...argv]],
      ['xterm', ['-e', ...argv]],
    ];
  }

  for (const [bin, args] of terminals) {
    try {
      const child = spawnFn(bin, args, { shell: false, detached: true, stdio: 'ignore' });
      const started = await new Promise<boolean>((resolve) => {
        child.once('error', () => resolve(false));
        child.once('spawn', () => resolve(true));
      });
      if (started) {
        child.unref();
        return { ok: true, command, error: null };
      }
    } catch {
      continue;
    }
  }
  return { ok: false, command, error: 'NO_TERMINAL_EMULATOR' };
}
