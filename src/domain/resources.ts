import type { ProcessKey, ResourceMetric } from '../shared/contracts';
import { areProcessKeysEqual, isStrongProcessKey } from './identity';
import { parseIsoMs } from './bindings';

export interface ResourceSampleInput {
  source: string;
  name: 'gpu_utilization' | 'gpu_memory_used' | 'gpu_memory_total' | 'cpu_utilization' | 'process_rss';
  unit: 'percent_device' | 'percent_one_cpu' | 'bytes';
  value: number | null;
  observedAt: string;
  scope: 'device' | 'process';
  deviceId?: string | null;
  processKey?: ProcessKey | null;
  keyBeforeSample?: ProcessKey | null;
  keyAfterSample?: ProcessKey | null;
}

export interface ProjectResourcesOptions {
  now?: string;
  ttlMs?: number;
  registeredKeys?: ProcessKey[];
}

export function projectResources(
  samples: ResourceSampleInput[],
  options?: ProjectResourcesOptions
): ResourceMetric[] {
  const result: ResourceMetric[] = [];
  if (options?.ttlMs !== undefined) {
    if (typeof options.ttlMs !== 'number' || !Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      return result;
    }
  }
  const ttlMs = options?.ttlMs ?? 30000;
  const refTime = parseIsoMs(options?.now);

  // Missing or invalid explicit now cannot default fresh; omit unusable evidence
  if (refTime === null) {
    return result;
  }

  for (const sample of samples) {
    // Value validation: reject NaN, Infinity, -Infinity
    if (sample.value !== null && (sample.value === undefined || !Number.isFinite(sample.value))) {
      continue;
    }

    const sampleTime = parseIsoMs(sample.observedAt);
    if (sampleTime === null) {
      continue;
    }

    // Future timestamp (> now) is rejected
    if (sampleTime > refTime) {
      continue;
    }

    // Compute freshness based on observation time and TTL
    let freshness: 'fresh' | 'stale' = 'fresh';
    const ageMs = refTime - sampleTime;
    if (ageMs > ttlMs) {
      freshness = 'stale';
    }

    if (sample.scope === 'device') {
      // Device metrics require a real, non-empty deviceId
      if (!sample.deviceId || sample.deviceId.trim() === '') {
        continue;
      }

      // Semantic validation for device metrics
      const isValidDeviceMetric =
        (sample.name === 'gpu_utilization' && sample.unit === 'percent_device') ||
        ((sample.name === 'gpu_memory_used' || sample.name === 'gpu_memory_total') &&
          sample.unit === 'bytes');

      if (!isValidDeviceMetric) {
        continue;
      }

      result.push({
        observedAt: sample.observedAt,
        freshness,
        source: sample.source,
        name: sample.name,
        unit: sample.unit,
        value: sample.value,
        scope: 'device',
        deviceId: sample.deviceId.trim(),
        processKey: null,
      });
    } else if (sample.scope === 'process') {
      // Process metrics require strong process key
      if (!isStrongProcessKey(sample.processKey)) {
        continue;
      }

      // Process metrics require both keyBeforeSample and keyAfterSample
      if (!sample.keyBeforeSample || !sample.keyAfterSample) {
        continue;
      }
      if (!isStrongProcessKey(sample.keyBeforeSample) || !isStrongProcessKey(sample.keyAfterSample)) {
        continue;
      }

      // Both before/after keys must equal the sample key
      if (
        !areProcessKeysEqual(sample.processKey, sample.keyBeforeSample) ||
        !areProcessKeysEqual(sample.processKey, sample.keyAfterSample)
      ) {
        continue;
      }

      // Registered keys required: empty or missing set authorizes ZERO processes
      if (
        !options?.registeredKeys ||
        options.registeredKeys.length === 0 ||
        !options.registeredKeys.some((k) => areProcessKeysEqual(k, sample.processKey!))
      ) {
        continue;
      }

      // Semantic validation for process metrics
      const isValidProcessMetric =
        (sample.name === 'cpu_utilization' && sample.unit === 'percent_one_cpu') ||
        (sample.name === 'process_rss' && sample.unit === 'bytes') ||
        (!!sample.deviceId?.trim() && (
          sample.name === 'gpu_memory_used' && sample.unit === 'bytes' && (sample.value === null || sample.value >= 0) ||
          sample.name === 'gpu_utilization' && sample.unit === 'percent_device' && (sample.value === null || sample.value >= 0 && sample.value <= 100)
        ));

      if (!isValidProcessMetric) {
        continue;
      }

      result.push({
        observedAt: sample.observedAt,
        freshness,
        source: sample.source,
        name: sample.name,
        unit: sample.unit,
        value: sample.value,
        scope: 'process',
        deviceId: sample.name === 'gpu_memory_used' || sample.name === 'gpu_utilization' ? sample.deviceId!.trim() : null,
        processKey: sample.processKey,
      });
    }
  }

  return result;
}
