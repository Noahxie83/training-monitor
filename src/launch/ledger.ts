import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type LaunchRecord = {
  taskId: string;
  armId: string;
  configHash: string;
  status: 'attempted' | 'started' | 'failed';
  pid: number | null;
  startedAt: string | null;
  errorCode: string | null;
};

export type LaunchLedger = {
  get(taskId: string, armId: string): Promise<LaunchRecord | null>;
  claim(record: LaunchRecord): Promise<boolean>;
  finish(record: LaunchRecord): Promise<void>;
  release(taskId: string, armId: string, configHash: string): Promise<void>;
};

const RECORD_FIELDS = ['taskId', 'armId', 'configHash', 'status', 'pid', 'startedAt', 'errorCode'] as const;
const ENVELOPE_FIELDS = ['version', 'records'] as const;
const TASK_ID_LIMIT = 200;
const ERROR_CODE_LIMIT = 200;
const MAX_RECORDS = 10_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const directoryQueues = new Map<string, ReturnType<typeof createQueue>>();

function fail(message: string): never {
  throw new Error(`INVALID_LAUNCH_LEDGER: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === fields.length && fields.every((field) => actual.includes(field));
}

function validateTimestamp(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    fail(`invalid ${field}`);
  }
  return value;
}

function validateLaunchRecord(value: unknown): LaunchRecord {
  if (!isRecord(value) || !hasExactFields(value, RECORD_FIELDS)) fail('record fields');

  const { taskId, armId, configHash, status, pid, startedAt, errorCode } = value;
  if (typeof taskId !== 'string' || taskId.length === 0 || taskId.length > TASK_ID_LIMIT) fail('taskId');
  if (typeof armId !== 'string' || !UUID_PATTERN.test(armId)) fail('armId');
  if (typeof configHash !== 'string' || !HASH_PATTERN.test(configHash)) fail('configHash');
  if (status !== 'attempted' && status !== 'started' && status !== 'failed') fail('status');
  if (pid !== null && (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1)) fail('pid');
  validateTimestamp(startedAt, 'startedAt');
  if (errorCode !== null && (typeof errorCode !== 'string' || errorCode.length === 0 || errorCode.length > ERROR_CODE_LIMIT)) fail('errorCode');
  if (status === 'attempted' && startedAt !== null) fail('attempted startedAt');

  return structuredClone(value) as LaunchRecord;
}

function validateLedger(value: unknown): LaunchRecord[] {
  if (!isRecord(value) || !hasExactFields(value, ENVELOPE_FIELDS)) fail('envelope fields');
  if (value.version !== 1 || !Array.isArray(value.records)) fail('envelope shape');
  if (value.records.length > MAX_RECORDS) fail('record limit');
  const records = value.records.map(validateLaunchRecord);
  const keys = new Set<string>();
  for (const record of records) {
    const key = `${record.taskId}\0${record.armId}`;
    if (keys.has(key)) fail('duplicate launch');
    keys.add(key);
  }
  return records;
}

function validateKey(taskId: string, armId: string): string {
  if (typeof taskId !== 'string' || taskId.length === 0 || taskId.length > TASK_ID_LIMIT) fail('taskId');
  if (typeof armId !== 'string' || !UUID_PATTERN.test(armId)) fail('armId');
  return `${taskId}\0${armId}`;
}

function recordKey(record: LaunchRecord): string {
  return validateKey(record.taskId, record.armId);
}

function createQueue(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail = Promise.resolve();
  return (operation) => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

async function writeLedger(directory: string, path: string, records: LaunchRecord[]): Promise<void> {
  const temporaryPath = join(directory, `.${path.slice(directory.length + 1)}.${randomBytes(12).toString('hex')}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify({ version: 1, records })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const handle = await open(temporaryPath, 'r+');
    try {
      await handle.sync();
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    try {
      const directoryHandle = await open(directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function loadRecords(path: string): Promise<LaunchRecord[]> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`INVALID_LAUNCH_LEDGER: malformed JSON: ${(error as Error).message}`);
  }
  return validateLedger(parsed);
}

export function createLaunchLedger(directory: string): LaunchLedger {
  if (typeof directory !== 'string' || directory.length === 0) fail('directory');
  const queueKey = resolve(directory).toLowerCase();
  const path = join(directory, 'auto-start-ledger.json');
  let queue = directoryQueues.get(queueKey);
  if (!queue) {
    queue = createQueue();
    directoryQueues.set(queueKey, queue);
  }

  const get = (taskId: string, armId: string): Promise<LaunchRecord | null> => queue(async () => {
    const key = validateKey(taskId, armId);
    const records = await loadRecords(path);
    const found = records.find((record) => `${record.taskId}\0${record.armId}` === key);
    return found ? structuredClone(found) : null;
  });

  const claim = (record: LaunchRecord): Promise<boolean> => queue(async () => {
    const validated = validateLaunchRecord(record);
    if (validated.status !== 'attempted') fail('claim requires attempted status');
    const key = recordKey(validated);
    const records = await loadRecords(path);
    if (records.some((existing) => `${existing.taskId}\0${existing.armId}` === key)) return false;
    if (records.length >= MAX_RECORDS) fail('record limit');
    await mkdir(directory, { recursive: true });
    await writeLedger(directory, path, [...records, validated]);
    return true;
  });

  const finish = (record: LaunchRecord): Promise<void> => queue(async () => {
    const validated = validateLaunchRecord(record);
    if (validated.status === 'attempted') fail('finish requires a terminal status');
    if (validated.status === 'started' && (validated.pid === null || validated.startedAt === null)) fail('started requires pid and startedAt');
    const key = recordKey(validated);
    const records = await loadRecords(path);
    const index = records.findIndex((existing) => `${existing.taskId}\0${existing.armId}` === key);
    if (index === -1) fail('finish requires an attempted record');
    const existing = records[index]!;
    if (existing.configHash !== validated.configHash) fail('configHash mismatch');
    if (existing.status === 'attempted') {
      records[index] = validated;
      await mkdir(directory, { recursive: true });
      await writeLedger(directory, path, records);
      return;
    }
    if (JSON.stringify(existing) !== JSON.stringify(validated)) fail('terminal launch already recorded');
  });

  const release = (taskId: string, armId: string, configHash: string): Promise<void> => queue(async () => {
    const key = validateKey(taskId, armId);
    if (typeof configHash !== 'string' || !HASH_PATTERN.test(configHash)) fail('configHash');
    const records = await loadRecords(path);
    const index = records.findIndex((existing) => `${existing.taskId}\0${existing.armId}` === key);
    if (index === -1) return;
    const existing = records[index]!;
    if (existing.status !== 'attempted') fail('terminal launch already recorded');
    if (existing.configHash !== configHash) fail('configHash mismatch');
    records.splice(index, 1);
    await writeLedger(directory, path, records);
  });

  return { get, claim, finish, release };
}
