import type { MonitorSnapshot } from './api';
import type { HostSnapshot, LogSourceSnapshot, Registry, TaskSnapshot } from './contracts';

function emptyHost(hostId: string, kind: HostSnapshot['kind']): HostSnapshot {
  return {
    version: 1,
    hostId,
    kind,
    connection: 'unobserved',
    observedAt: null,
    freshness: 'unobserved',
    lastSuccessAt: null,
    lastProbeDurationMs: null,
    scanComplete: false,
    errorCode: null,
  };
}

function emptyTask(taskId: string, hostId: string): TaskSnapshot {
  const emptyCount = {
    completedCount: null,
    targetCount: null,
    fraction: null,
    unit: 'unknown' as const,
    verified: false,
    sourceId: null,
  };
  return {
    version: 1,
    taskId,
    hostId,
    lifecycle: 'unknown',
    freshness: 'unobserved',
    statusObservedAt: null,
    confidence: 'none',
    reason: 'Registered task has not been observed',
    evidence: [],
    currentRun: null,
    processes: { main: null, queue: null, workers: [] },
    queueLock: { observedAt: null, freshness: 'unobserved', source: null, exists: null, heldByRegisteredProcess: null },
    progress: {
      observedAt: null,
      freshness: 'unobserved',
      runId: null,
      lastStepIndex: null,
      bindingIds: [],
      baselineEvidenceId: null,
      resumeCheckpointIndex: null,
      firstLoopIndex: null,
      global: { ...emptyCount },
      session: { ...emptyCount },
      configuredTarget: null,
      iterationsPerSecond: null,
      etaSeconds: null,
    },
    checkpoint: {
      observedAt: null,
      freshness: 'unobserved',
      path: null,
      fileStepIndex: null,
      stepSource: null,
      sizeBytes: null,
      mtime: null,
      evidence: 'none',
      scanComplete: false,
    },
    resources: [],
  };
}

function emptySource(sourceId: string, taskId: string): LogSourceSnapshot {
  return {
    sourceId,
    taskId,
    observedAt: null,
    freshness: 'unobserved',
    state: 'unobserved',
    generation: null,
    committedOffset: null,
    generationStartOffset: null,
    maxObservedOffset: null,
    continuityState: null,
    catchupBytesRead: null,
    catchupBytesTotal: null,
    errorCode: null,
  };
}

/** Project retained observations onto the registrations that are current now. */
export function projectRegistrySnapshot(snapshot: MonitorSnapshot, registry: Registry): MonitorSnapshot {
  const cachedHosts = new Map(snapshot.hosts.map((host) => [host.hostId, host]));
  const cachedTasks = new Map(snapshot.tasks.map((task) => [task.taskId, task]));
  const cachedSources = new Map(snapshot.sources.map((source) => [`${source.taskId}\0${source.sourceId}`, source]));
  const registeredHosts = new Map(registry.hosts.map((host) => [host.hostId, host]));
  const projectedHosts = registry.hosts.map((registration) => {
    const cached = cachedHosts.get(registration.hostId);
    return cached?.kind === registration.target.kind
      ? cached
      : emptyHost(registration.hostId, registration.target.kind);
  });
  const currentTasks = registry.tasks.filter((task) => registeredHosts.has(task.hostId));
  const projectedTasks = currentTasks.map((registration) => {
    const cachedHost = cachedHosts.get(registration.hostId);
    const cachedTask = cachedTasks.get(registration.taskId);
    const targetKind = registeredHosts.get(registration.hostId)!.target.kind;
    return cachedHost?.kind === targetKind && cachedTask?.hostId === registration.hostId
      ? cachedTask
      : emptyTask(registration.taskId, registration.hostId);
  });
  const projectedSources = currentTasks.flatMap((task) => task.sources.map((source) => {
    const cachedHost = cachedHosts.get(task.hostId);
    const cachedTask = cachedTasks.get(task.taskId);
    const currentHost = registeredHosts.get(task.hostId)!;
    const cached = cachedSources.get(`${task.taskId}\0${source.sourceId}`);
    return cachedHost?.kind === currentHost.target.kind && cachedTask?.hostId === task.hostId && cached
      ? cached
      : emptySource(source.sourceId, task.taskId);
  }));

  return {
    ...snapshot,
    hosts: projectedHosts,
    tasks: projectedTasks,
    sources: projectedSources,
  };
}
