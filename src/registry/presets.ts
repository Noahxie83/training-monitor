import type { Registry } from '../shared/contracts';

/** Historical presets remain disabled until a person confirms their paths and sources. */
export function createDefaultRegistry(): Registry {
  return {
    version: 1,
    revision: 0,
    hosts: [
      { hostId: 'lab-campus', label: '待确认：Lab Campus (SSH)', enabled: false, allowedRoots: ['/data2/cy/xzn'], target: { kind: 'ssh', alias: 'lab-campus' } },
      { hostId: 'wsl-ubuntu', label: '待确认：WSL Ubuntu-26.04', enabled: false, allowedRoots: [], target: { kind: 'wsl', distribution: 'Ubuntu-26.04' } },
    ],
    tasks: [
      { taskId: 'flow-cifar10', hostId: 'lab-campus', label: '待确认：Flow Matching (CIFAR-10)', enabled: false, algorithm: 'flow', allowedDirectories: [], entryPaths: [], sources: [], checkpointDirectories: [] },
      { taskId: 'score-based', hostId: 'lab-campus', label: '待确认：Score-based Generative Model', enabled: false, algorithm: 'score', allowedDirectories: [], entryPaths: [], sources: [], checkpointDirectories: [] },
      { taskId: 'reflow', hostId: 'lab-campus', label: '待确认：Reflow 2-rectified Flow', enabled: false, algorithm: 'reflow', allowedDirectories: [], entryPaths: [], sources: [], checkpointDirectories: [] },
    ],
  };
}
