import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import type { ConfigRecoveryNotice } from '../shared/contracts';

export interface ConfigRecoveryOptions {
  onRecovery?: (notice: ConfigRecoveryNotice) => void;
  confirmRecovery?: (notice: ConfigRecoveryNotice) => boolean | Promise<boolean>;
  clock?: () => number;
}

export async function backUpCorruptConfig(
  filename: string,
  file: ConfigRecoveryNotice['file'],
  errorCode: string,
  clock: () => number,
): Promise<ConfigRecoveryNotice> {
  const recoveredAt = new Date(clock()).toISOString();
  const timestamp = recoveredAt.replace(/[:.]/g, '-');
  const backupPath = `${filename}.corrupt-${timestamp}-${randomUUID()}.bak`;
  await copyFile(filename, backupPath, constants.COPYFILE_EXCL);
  return {
    file,
    backupPath,
    errorCode,
    recoveredAt,
    message: `${path.basename(filename)} (${errorCode}): ${backupPath}`,
  };
}

export class ConfigRecoveryDeclined extends Error {}
