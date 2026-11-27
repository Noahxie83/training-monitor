import type { HostTarget } from '../shared/contracts';
import { isSafeRemotePythonPath, validateHostTarget } from '../shared/validate';

export interface CommandSpec {
  command: string;
  args: string[];
  fallbackCommands?: { command: string; args: string[] }[];
}

/**
 * Tiny zero-backslash, zero-single-quote bootstrap that enforces Python >= 3.7,
 * reads exact `<byte_length>\n<source>` bytes from stdin, and execs the probe
 * in persistent `--serve` mode (reading TMF1-framed JSON-RPC over the same stdin).
 */
export const SERVE_BOOTSTRAP_PY =
  'import sys; sys.exit(126) if sys.version_info<(3,7) else None; ' +
  'r=sys.stdin.buffer; n=int(r.readline()); b=r.read(n); ' +
  'sys.exit(2) if len(b)!=n else None; ' +
  'exec(compile(b,sys.argv[2],sys.argv[3]),{sys.argv[4]:sys.argv[5]})';

const VERSION_CHECK_PY = 'import sys; sys.exit(0 if sys.version_info>=(3,7) else 1)';

function assertSafePythonPath(pythonPath: string): void {
  if (!isSafeRemotePythonPath(pythonPath)) {
    throw new Error('HOST_TARGET_INVALID');
  }
}

/**
 * Builds a POSIX `sh -c` snippet safe across sh, bash, zsh, dash, csh, tcsh, and fish
 * (no backslashes or nested single quotes inside the single-quoted argument).
 */
export function buildRemotePythonShellCommand(options: { pythonPath?: string; serve: boolean }): string {
  const execTail = options.serve
    ? `exec "$P" -I -S -B -c "${SERVE_BOOTSTRAP_PY}" --serve probe exec __name__ __main__`
    : 'exec "$P" -I -S -B -';

  if (options.pythonPath) {
    assertSafePythonPath(options.pythonPath);
    return (
      `sh -c 'P="$1"; ` +
      `(command -v "$P" >/dev/null 2>&1 || [ -x "$P" ]) || { echo "TM_ERR:REMOTE_PYTHON_UNAVAILABLE:not_found" >&2; exit 127; }; ` +
      `"$P" -c "${VERSION_CHECK_PY}" >/dev/null 2>&1 || { echo "TM_ERR:REMOTE_PYTHON_UNAVAILABLE:version" >&2; exit 126; }; ` +
      `${execTail}' _ '${options.pythonPath}'`
    );
  }

  return (
    `sh -c 'P=""; ` +
    `for c in python3 python /usr/bin/python3 /usr/local/bin/python3; do ` +
    `if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then ` +
    `if "$c" -c "${VERSION_CHECK_PY}" >/dev/null 2>&1; then P="$c"; break; fi; ` +
    `fi; done; ` +
    `[ -n "$P" ] || { echo "TM_ERR:REMOTE_PYTHON_UNAVAILABLE:not_found" >&2; exit 127; }; ` +
    `${execTail}'`
  );
}

function buildRemoteShArgv(options: { pythonPath?: string; serve: boolean }): string[] {
  const execTail = options.serve
    ? `exec "$P" -I -S -B -c "${SERVE_BOOTSTRAP_PY}" --serve probe exec __name__ __main__`
    : 'exec "$P" -I -S -B -';

  if (options.pythonPath) {
    assertSafePythonPath(options.pythonPath);
    return [
      'sh',
      '-c',
      `P="$1"; ` +
        `(command -v "$P" >/dev/null 2>&1 || [ -x "$P" ]) || { echo "TM_ERR:REMOTE_PYTHON_UNAVAILABLE:not_found" >&2; exit 127; }; ` +
        `"$P" -c "${VERSION_CHECK_PY}" >/dev/null 2>&1 || { echo "TM_ERR:REMOTE_PYTHON_UNAVAILABLE:version" >&2; exit 126; }; ` +
        execTail,
      '_',
      options.pythonPath,
    ];
  }

  return [
    'sh',
    '-c',
    `P=""; ` +
      `for c in python3 python /usr/bin/python3 /usr/local/bin/python3; do ` +
      `if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then ` +
      `if "$c" -c "${VERSION_CHECK_PY}" >/dev/null 2>&1; then P="$c"; break; fi; ` +
      `fi; done; ` +
      `[ -n "$P" ] || { echo "TM_ERR:REMOTE_PYTHON_UNAVAILABLE:not_found" >&2; exit 127; }; ` +
      execTail,
  ];
}

export function buildSshArgs(target: Extract<HostTarget, { kind: 'ssh' }>, remoteCommand: string): string[] {
  validateHostTarget(target, 'HOST_TARGET_INVALID');
  const destination = target.alias ?? target.hostname;
  if (!destination) throw new Error('HOST_TARGET_INVALID');

  const args: string[] = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
  ];

  if (target.alias && target.hostname) {
    args.push('-o', `HostName=${target.hostname}`);
  }
  if (target.user) {
    args.push('-l', target.user);
  }
  if (target.port !== undefined) {
    args.push('-p', String(target.port));
  }
  if (target.identityFile) {
    args.push('-i', target.identityFile, '-o', 'IdentitiesOnly=yes');
  }
  if (target.proxyJump) {
    args.push('-J', target.proxyJump);
  }
  args.push('--', destination, remoteCommand);
  return args;
}

export function commandSpecFor(
  target: HostTarget,
  options: { serve?: boolean; platform?: NodeJS.Platform } = {},
): CommandSpec {
  const validated = validateHostTarget(target, 'HOST_TARGET_INVALID');
  const serve = options.serve ?? true;
  const platform = options.platform ?? process.platform;

  if (validated.kind === 'ssh') {
    const remoteCommand = buildRemotePythonShellCommand({ pythonPath: validated.pythonPath, serve });
    return {
      command: 'ssh',
      args: buildSshArgs(validated, remoteCommand),
    };
  }

  if (validated.kind === 'wsl') {
    const shArgv = buildRemoteShArgv({ pythonPath: validated.pythonPath, serve });
    return {
      command: 'wsl.exe',
      args: ['--distribution', validated.distribution, '--exec', ...shArgv],
    };
  }

  // Local host target: spawn local Python directly with shell: false.
  const pythonArgs = serve
    ? ['-I', '-S', '-B', '-c', SERVE_BOOTSTRAP_PY, '--serve', 'probe', 'exec', '__name__', '__main__']
    : ['-I', '-S', '-B', '-'];

  if (validated.pythonPath) {
    return { command: validated.pythonPath, args: pythonArgs };
  }

  if (platform === 'win32') {
    return {
      command: 'python',
      args: pythonArgs,
      fallbackCommands: [
        { command: 'py', args: ['-3', ...pythonArgs] },
        { command: 'python3', args: pythonArgs },
      ],
    };
  }

  return {
    command: 'python3',
    args: pythonArgs,
    fallbackCommands: [
      { command: 'python', args: pythonArgs },
    ],
  };
}

export function safeArgsFor(target: HostTarget, options: { serve?: boolean } = {}): string[] {
  return commandSpecFor(target, { serve: options.serve ?? false }).args;
}

export function stoppedWslListArgs(): string[] { return ['--list', '--running', '--quiet']; }
export function allWslListArgs(): string[] { return ['--list', '--quiet']; }
