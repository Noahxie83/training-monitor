import type { HostRegistration } from '../shared/contracts';

export const PYTHON_PROBE_COMMAND = '/usr/bin/python3 -I -S -B -';

export function safeArgsFor(target: HostRegistration['target'], _pathData?: string): string[] {
  if (target.kind === 'ssh') {
    if (target.alias !== 'lab-campus') throw new Error('HOST_TARGET_INVALID');
    return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '--', target.alias, PYTHON_PROBE_COMMAND];
  }
  if (target.distribution !== 'Ubuntu-26.04') throw new Error('HOST_TARGET_INVALID');
  return ['--distribution', 'Ubuntu-26.04', '--exec', '/usr/bin/python3', '-I', '-S', '-B', '-'];
}

export function stoppedWslListArgs(): string[] { return ['--list', '--running', '--quiet']; }
