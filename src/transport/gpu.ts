import type { ProcessKey, ResourceMetric, TaskRegistration } from '../shared/contracts';
import type { HostGpuObservation, ProcessGpuObservation, TaskProcessObservation } from './types';
import { areProcessKeysEqual, isRegisteredProcessEntry, processEntry, isStrongProcessKey } from '../domain/identity';

const MEBIBYTE = 1024 * 1024;
const MISSING_GPU_VALUE_RE = /^(?:\[?\s*(?:n\/a|na|not supported|unknown)\s*\]?|-)$/i;
const GPU_OR_MIG_UUID_RE = /^(?:GPU|MIG)-[A-Za-z0-9._:/-]+$/;

export function isMissingGpuValue(value: string): boolean {
  const trimmed = value.trim();
  return !trimmed || MISSING_GPU_VALUE_RE.test(trimmed);
}

export function isValidGpuUuid(uuid: string | undefined): uuid is string {
  return typeof uuid === 'string' && uuid.length <= 256 && !uuid.includes('..') && GPU_OR_MIG_UUID_RE.test(uuid);
}

export function isRegisteredGpuProcess(task: TaskRegistration, process: TaskProcessObservation): boolean {
  return process.evidenceComplete && !!processEntry(process) && isRegisteredProcessEntry(task, process) &&
    (process.roleEvidence === 'exact_script_entry' || process.roleEvidence === 'exact_entry_and_direct_writer_fd');
}

export function parseGpuNumeric(value: string, maximum = Number.POSITIVE_INFINITY): number | null {
  const trimmed = value.trim();
  if (isMissingGpuValue(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= maximum ? parsed : null;
}

export function gpuDeviceMap(csv: string): { uuid: string; index: number }[] {
  const result: { uuid: string; index: number }[] = [];
  if (typeof csv !== 'string' || csv.length > 16_384) return result;
  for (const line of csv.split(/\r?\n/).slice(0, 64)) {
    const [indexText, uuid] = line.split(',').map(part => part.trim());
    const index = Number(indexText);
    if (
      !/^\d+$/.test(indexText ?? '') ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index > 1023 ||
      !isValidGpuUuid(uuid) ||
      result.some(item => item.index === index || item.uuid === uuid)
    ) continue;
    result.push({ index, uuid });
  }
  return result;
}

/** Only samples of this task's stable process instances can become process metrics. */
export function projectProcessGpu(value: unknown, allowedKeys: ProcessKey[], devices: { index: number; uuid: string }[], receivedAt: string): ProcessGpuObservation {
  const unavailable = (code: string | null): ProcessGpuObservation => ({ observedAt: null, state: 'unavailable', errorCode: code, metrics: [], processKeys: [] });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable('PROCESS_GPU_UNAVAILABLE');
  const data = value as Record<string, unknown>;
  if (data.status === 'none') return unavailable(null);
  if (data.status !== 'ok') return unavailable(typeof data.errorCode === 'string' && /^[A-Z0-9_]{1,80}$/.test(data.errorCode) ? data.errorCode : 'PROCESS_GPU_UNAVAILABLE');
  if (!Array.isArray(data.samples) || data.samples.length > 512 || !Array.isArray(data.processKeys) || data.processKeys.length > 64) return unavailable('PROCESS_GPU_RESPONSE_INVALID');
  const processKeys = data.processKeys.filter((key): key is ProcessKey => isStrongProcessKey(key as ProcessKey) && allowedKeys.some(allowed => areProcessKeysEqual(allowed, key as ProcessKey)));
  const metrics: ResourceMetric[] = [];
  const seen = new Set<string>();
  for (const item of data.samples) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const sample = item as Record<string, unknown>;
    const key = sample.processKey as ProcessKey;
    if (!isStrongProcessKey(key) || !isStrongProcessKey(sample.keyBeforeSample as ProcessKey) || !isStrongProcessKey(sample.keyAfterSample as ProcessKey) ||
      !areProcessKeysEqual(key, sample.keyBeforeSample as ProcessKey) || !areProcessKeysEqual(key, sample.keyAfterSample as ProcessKey) ||
      !processKeys.some(allowed => areProcessKeysEqual(allowed, key)) || !devices.some(device => sample.deviceId === `GPU ${device.index}`)) continue;
    const unique = `${key.hostBootId}:${key.pid}:${key.startTicks}:${sample.deviceId}`;
    if (seen.has(unique)) continue;
    seen.add(unique);
    const boundedNum = (v: unknown, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
    const base = { observedAt: receivedAt, freshness: 'fresh' as const, scope: 'process' as const, deviceId: sample.deviceId as string, processKey: key };
    metrics.push({ ...base, source: 'nvidia-smi:process', name: 'gpu_memory_used', unit: 'bytes', value: boundedNum(sample.memoryBytes, Number.MAX_SAFE_INTEGER) });
    metrics.push({ ...base, source: 'nvml:process', name: 'gpu_utilization', unit: 'percent_device', value: boundedNum(sample.utilizationPercent, 100) });
  }
  return { observedAt: receivedAt, state: 'available', errorCode: null, processKeys, metrics };
}

/** Parse the fixed, process-free nvidia-smi CSV query shared by SSH, local, and Windows. */
export function projectGpuCsv(csv: string, observedAt: string): HostGpuObservation {
  if (typeof csv !== 'string' || csv.length > 16_384 || !Number.isFinite(Date.parse(observedAt))) {
    return { observedAt: null, state: 'unavailable', acceleratorAvailability: 'unavailable', errorCode: 'GPU_RESPONSE_INVALID', metrics: [] };
  }

  const metrics: ResourceMetric[] = [];
  const seen = new Set<string>();
  for (const line of csv.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 64)) {
    const columns = line.split(',').map((item) => item.trim());
    if (columns.length < 5 || !/^\d+$/.test(columns[0]!)) continue;
    const index = Number(columns[0]);
    if (!Number.isSafeInteger(index) || index < 0) continue;
    const deviceId = `GPU ${index}`;
    if (seen.has(deviceId)) continue;
    seen.add(deviceId);
    const utilization = parseGpuNumeric(columns[2]!, 100);
    const usedMiB = parseGpuNumeric(columns[3]!);
    const totalMiB = parseGpuNumeric(columns[4]!);
    const add = (name: ResourceMetric['name'], unit: ResourceMetric['unit'], value: number | null) => {
      metrics.push({
        observedAt,
        freshness: 'fresh',
        source: 'nvidia-smi',
        name,
        unit,
        value,
        scope: 'device',
        deviceId,
        processKey: null,
      });
    };
    add('gpu_utilization', 'percent_device', utilization);
    add('gpu_memory_used', 'bytes', usedMiB === null ? null : usedMiB * MEBIBYTE);
    add('gpu_memory_total', 'bytes', totalMiB === null ? null : totalMiB * MEBIBYTE);
  }

  return metrics.length > 0
    ? { observedAt, state: 'available', acceleratorAvailability: 'available', errorCode: null, metrics }
    : { observedAt: null, state: 'unavailable', acceleratorAvailability: 'unavailable', errorCode: 'GPU_DATA_UNAVAILABLE', metrics: [] };
}
