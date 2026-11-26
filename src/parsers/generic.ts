import type { CustomPatternConfig, ProgressUnit } from '../shared/contracts';
import { isSafeRegexPattern } from '../shared/validate';
import { stripAnsi } from './ansi';
import type { ParsedTrainingRecord } from './types';

const MAX_LINE_LENGTH = 4096;
const FLOAT_STR = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const NON_FINITE_LOSS_RE = /\b(?:loss|train_loss|training_loss|val_loss|eval_loss)\s*[:=]\s*(?:nan|inf|-inf|\+inf|infinity|-infinity)\b/i;

const SCALAR_KEYS: Record<string, string> = {
  loss: 'loss',
  train_loss: 'train_loss',
  training_loss: 'train_loss',
  val_loss: 'val_loss',
  eval_loss: 'eval_loss',
  validation_loss: 'val_loss',
  lr: 'lr',
  learning_rate: 'lr',
  grad_norm: 'grad_norm',
  gradient_norm: 'grad_norm',
  acc: 'acc',
  accuracy: 'acc',
  train_acc: 'train_acc',
  val_acc: 'val_acc',
  val_accuracy: 'val_acc',
  eval_acc: 'eval_acc',
  eval_accuracy: 'eval_acc',
  perplexity: 'perplexity',
  ppl: 'perplexity',
  tokens_per_sec: 'tokens_per_sec',
  tok_s: 'tokens_per_sec',
  box_loss: 'box_loss',
  cls_loss: 'cls_loss',
  dfl_loss: 'dfl_loss',
  seg_loss: 'seg_loss',
  pose_loss: 'pose_loss',
  map50: 'mAP50',
  'map50-95': 'mAP50_95',
};

const SCALAR_KV_RE = new RegExp(
  `\\b(loss|train_loss|training_loss|val_loss|eval_loss|validation_loss|learning_rate|lr|grad_norm|gradient_norm|train_acc|val_acc|val_accuracy|eval_acc|eval_accuracy|accuracy|acc|perplexity|ppl|tokens_per_sec|box_loss|cls_loss|dfl_loss|seg_loss|pose_loss)\\s*[:=]\\s*(${FLOAT_STR})(?=$|[\\s,;\\]\\)}/])`,
  'gi',
);

const TOK_PER_SEC_RE = new RegExp(`(${FLOAT_STR})\\s*(?:tok(?:ens)?\\/s|tok\\/sec)`, 'i');

function safeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function extractScalarsFromText(clean: string): { scalars: Record<string, number>; nonFiniteLoss: boolean } {
  const scalars: Record<string, number> = {};
  let nonFiniteLoss = NON_FINITE_LOSS_RE.test(clean);
  SCALAR_KV_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SCALAR_KV_RE.exec(clean)) !== null) {
    const rawKey = match[1]!.toLowerCase();
    const key = SCALAR_KEYS[rawKey] ?? rawKey;
    const numeric = Number(match[2]);
    if (Number.isFinite(numeric)) {
      scalars[key] = numeric;
    } else if (rawKey.includes('loss')) {
      nonFiniteLoss = true;
    }
  }
  const tokMatch = clean.match(TOK_PER_SEC_RE);
  if (tokMatch && scalars.tokens_per_sec === undefined) {
    const tokVal = Number(tokMatch[1]);
    if (Number.isFinite(tokVal) && tokVal >= 0) scalars.tokens_per_sec = tokVal;
  }
  return { scalars, nonFiniteLoss };
}

function extractScalarsFromRecord(record: Record<string, unknown>): { scalars: Record<string, number>; nonFiniteLoss: boolean } {
  const scalars: Record<string, number> = {};
  let nonFiniteLoss = false;
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const lower = rawKey.toLowerCase();
    const mapped = SCALAR_KEYS[lower];
    if (typeof rawValue === 'number') {
      if (!Number.isFinite(rawValue)) {
        if (lower.includes('loss')) nonFiniteLoss = true;
        continue;
      }
      if (mapped) scalars[mapped] = rawValue;
      else if (lower.endsWith('_loss') || lower.endsWith('_acc') || lower.endsWith('_lr')) {
        scalars[rawKey] = rawValue;
      }
    } else if (typeof rawValue === 'string' && lower.includes('loss')) {
      if (/^(?:nan|[-+]?inf(?:inity)?)$/i.test(rawValue.trim())) nonFiniteLoss = true;
    }
  }
  return { scalars, nonFiniteLoss };
}

/**
 * Safely parse a HuggingFace Transformers / Python dict line such as:
 * `{'loss': 0.52, 'grad_norm': 1.2, 'learning_rate': 1e-05, 'epoch': 0.25}`
 * or `{'loss': nan, 'epoch': 1.0}` without using eval.
 */
function parsePythonDictLine(trimmed: string): Record<string, unknown> | null {
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  if (!trimmed.includes("'")) return null;
  // Convert single-quoted keys/strings and Python literals (True/False/None/nan/inf) to valid JSON.
  let jsonCandidate = trimmed
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_m, inner: string) => JSON.stringify(inner.replace(/\\'/g, "'")))
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null')
    .replace(/(:\s*)(?:nan|-?inf(?:inity)?|\+inf(?:inity)?)\b/gi, (_m, prefix: string) => `${prefix}"__NON_FINITE__"`);
  try {
    const parsed = JSON.parse(jsonCandidate);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === '__NON_FINITE__') (parsed as Record<string, unknown>)[k] = Number.NaN;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseJsonOrPythonRecord(trimmed: string): Record<string, unknown> | null {
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return parsePythonDictLine(trimmed);
  }
  return null;
}

function applyCustomPatterns(clean: string, customPatterns: CustomPatternConfig, base: ParsedTrainingRecord): ParsedTrainingRecord | null {
  const scalars: Record<string, number> = {};
  let matchedAnything = false;
  let current: number | null = null;
  let total: number | null = null;
  let stepIndex: number | null = null;
  let unit: ProgressUnit = 'step';

  if (customPatterns.jsonFields && clean.trim().startsWith('{')) {
    const record = parseJsonOrPythonRecord(clean.trim());
    if (record) {
      for (const [targetName, jsonKey] of Object.entries(customPatterns.jsonFields)) {
        const val = record[jsonKey];
        if (typeof val === 'number' && Number.isFinite(val)) {
          if (targetName === 'step' || targetName === 'current') {
            current = val;
            if (Number.isSafeInteger(val) && val >= 0) stepIndex = val;
            matchedAnything = true;
          } else if (targetName === 'total') {
            total = val;
            matchedAnything = true;
          } else {
            scalars[targetName] = val;
            matchedAnything = true;
          }
        }
      }
    }
  }

  if (customPatterns.progressRegex && isSafeRegexPattern(customPatterns.progressRegex)) {
    try {
      const re = new RegExp(customPatterns.progressRegex);
      const m = re.exec(clean);
      if (m) {
        const curRaw = m.groups?.current ?? m.groups?.step ?? m[1];
        const totRaw = m.groups?.total ?? m[2];
        if (curRaw !== undefined) {
          const curNum = Number(curRaw);
          if (Number.isFinite(curNum) && curNum >= 0) {
            current = curNum;
            if (Number.isSafeInteger(curNum)) stepIndex = curNum;
            matchedAnything = true;
          }
        }
        if (totRaw !== undefined) {
          const totNum = Number(totRaw);
          if (Number.isFinite(totNum) && totNum > 0) {
            total = totNum;
          }
        }
        if (m.groups?.unit && ['step', 'epoch', 'token', 'sample', 'percent'].includes(m.groups.unit)) {
          unit = m.groups.unit as ProgressUnit;
        }
      }
    } catch {
      // Ignore malformed custom regex
    }
  }

  if (customPatterns.metricRegexes) {
    for (const [metricName, pattern] of Object.entries(customPatterns.metricRegexes)) {
      if (!isSafeRegexPattern(pattern)) continue;
      try {
        const re = new RegExp(pattern);
        const m = re.exec(clean);
        const raw = m?.groups?.value ?? m?.[1];
        if (raw !== undefined) {
          const num = Number(raw);
          if (Number.isFinite(num)) {
            scalars[metricName] = num;
            matchedAnything = true;
          }
        }
      } catch {
        // Ignore invalid regex
      }
    }
  }

  if (!matchedAnything) return null;
  const hasBounded = current !== null && total !== null && total > 0 && Number.isSafeInteger(current) && Number.isSafeInteger(total) && current <= total;
  return {
    ...base,
    isTrainingOutput: true,
    stepIndex,
    unit,
    current,
    total,
    sessionCompletedCount: hasBounded ? current : null,
    sessionTargetCount: hasBounded ? total : null,
    ...(Object.keys(scalars).length ? { scalars } : {}),
  };
}

function parseTqdmRate(bracket: string): { rate: number | null; rateUnit: string | null } {
  const fwd = bracket.match(/([0-9]+(?:\.[0-9]+)?)\s*(it|iter|step|steps|img|imgs|tok|tokens|sample|samples|batch|batches|B|KB|MB|GB)\/s\b/i);
  if (fwd) {
    const val = Number(fwd[1]);
    return { rate: Number.isFinite(val) ? val : null, rateUnit: `${fwd[2]!.toLowerCase()}/s` };
  }
  const inv = bracket.match(/([0-9]+(?:\.[0-9]+)?)\s*s\/(it|iter|step|img|tok|sample|batch)\b/i);
  if (inv) {
    const sec = Number(inv[1]);
    return { rate: Number.isFinite(sec) && sec > 0 ? 1 / sec : null, rateUnit: `${inv[2]!.toLowerCase()}/s` };
  }
  return { rate: null, rateUnit: null };
}

/** Recognize explicit training records across common ML/DL frameworks without inventing resume offsets. */
export function parseGenericRecord(
  text: string,
  sourceId = '',
  customPatterns?: CustomPatternConfig | null,
): ParsedTrainingRecord {
  const clean = stripAnsi(text || '');
  const result: ParsedTrainingRecord = {
    algorithm: 'generic',
    sessionCompletedCount: null,
    sessionTargetCount: null,
    rate: null,
    rateUnit: null,
    rawText: text || '',
    sourceId,
    isTrainingOutput: false,
    stepIndex: null,
    unit: 'unknown',
    current: null,
    total: null,
  };
  if (!clean || clean.length > MAX_LINE_LENGTH || /[\r\n]/.test(clean.trim())) return result;

  if (customPatterns) {
    const custom = applyCustomPatterns(clean, customPatterns, result);
    if (custom) return custom;
  }

  // Always exclude pure system/lifecycle/checkpoint-saved noise.
  if (/\b(?:heartbeat|health|queued|waiting|startup|config)\b/i.test(clean)) return result;
  if (/\bcheckpoint\s+(?:saved|saving|written|loaded|restored)\b/i.test(clean)) return result;
  if (/\bresume\b/i.test(clean) && !/\b(?:loss|train_loss|epoch)\b/i.test(clean)) return result;

  const trimmed = clean.trim();

  // 1. JSONL or HuggingFace Transformers single-quoted Python dict
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const record = parseJsonOrPythonRecord(trimmed);
    if (!record) return result;
    const mode = String(record.mode ?? record.phase ?? record.event ?? '').toLowerCase();
    if (['eval', 'evaluation', 'validation', 'test', 'heartbeat', 'health'].includes(mode)) return result;

    const { scalars, nonFiniteLoss } = extractScalarsFromRecord(record);
    const hasLossOrTrain =
      mode === 'train' ||
      mode === 'training' ||
      scalars.loss !== undefined ||
      scalars.train_loss !== undefined ||
      scalars.val_loss !== undefined ||
      scalars.eval_loss !== undefined ||
      nonFiniteLoss;
    const step = safeInt(record.global_step ?? record.step ?? record.iteration);
    const totalSteps = safeInt(record.total_steps ?? record.max_steps);
    const epoch = safeFinite(record.epoch);
    const totalEpochs = safeFinite(record.total_epochs ?? record.num_train_epochs);

    if (!hasLossOrTrain) return result;

    if (step !== null) {
      return {
        ...result,
        isTrainingOutput: true,
        stepIndex: step,
        unit: 'step',
        current: step,
        total: totalSteps,
        ...(Object.keys(scalars).length ? { scalars } : {}),
        ...(nonFiniteLoss ? { nonFiniteLoss: true } : {}),
      };
    }
    if (epoch !== null && epoch >= 0) {
      return {
        ...result,
        isTrainingOutput: true,
        stepIndex: null,
        unit: 'epoch',
        current: epoch,
        total: totalEpochs !== null && totalEpochs > 0 ? totalEpochs : null,
        ...(Object.keys(scalars).length ? { scalars } : {}),
        ...(nonFiniteLoss ? { nonFiniteLoss: true } : {}),
      };
    }
    return result;
  }

  const { scalars, nonFiniteLoss } = extractScalarsFromText(clean);

  // Exclude pure evaluation/validation lines unless they ALSO carry training signals (e.g. Lightning/Keras lines with train_loss or val_loss + loss or Epoch X/Y).
  const hasExplicitValPrefix = /(?:^|\s)(?:\[val\]|evaluation|validation|testing)\b/i.test(clean);
  const hasTrainingCounterpart =
    /\b(?:train_loss|training_loss|epoch\s+\d+\s*\/\s*\d+)\b/i.test(clean) ||
    (scalars.loss !== undefined && (scalars.val_loss !== undefined || scalars.eval_loss !== undefined));
  if (hasExplicitValPrefix && !hasTrainingCounterpart) return result;
  if (/\b(?:eval|checkpoint)\b/i.test(clean) && !hasTrainingCounterpart && scalars.val_loss === undefined && scalars.eval_loss === undefined) {
    return result;
  }

  // 2. Ultralytics / YOLO tabular epoch line:
  //    e.g. `1/100   4.2G   1.234   0.567   0.890   32   640: 50%|█████| 50/100 [00:10<00:10, 5.00it/s]`
  //    or   `Epoch 1/100  3.45G  1.123  0.876  1.045  64  640`
  const yoloMatch = clean.match(
    /^\s*(?:Epoch\s+)?(\d+)\s*\/\s*(\d+)\s+\d+(?:\.\d+)?[GMK]?\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)(?:\s+\d+\s+\d+)?/i,
  );
  if (yoloMatch) {
    const curEpoch = safeInt(Number(yoloMatch[1]));
    const totEpoch = safeInt(Number(yoloMatch[2]));
    const boxLoss = Number(yoloMatch[3]);
    const clsLoss = Number(yoloMatch[4]);
    const dflLoss = Number(yoloMatch[5]);
    if (curEpoch !== null && totEpoch !== null && totEpoch > 0 && curEpoch <= totEpoch) {
      const yoloScalars: Record<string, number> = { ...scalars };
      if (Number.isFinite(boxLoss)) yoloScalars.box_loss = boxLoss;
      if (Number.isFinite(clsLoss)) yoloScalars.cls_loss = clsLoss;
      if (Number.isFinite(dflLoss)) yoloScalars.dfl_loss = dflLoss;
      // Also parse embedded tqdm bar if present
      const embeddedBar = clean.match(/(\d+)\s*\/\s*(\d+)\s*\[([^\]\r\n]+)\]/);
      const rateInfo = embeddedBar ? parseTqdmRate(embeddedBar[3]!) : { rate: null, rateUnit: null };
      return {
        ...result,
        isTrainingOutput: true,
        unit: 'epoch',
        current: curEpoch,
        total: totEpoch,
        sessionCompletedCount: curEpoch,
        sessionTargetCount: totEpoch,
        rate: rateInfo.rate,
        rateUnit: rateInfo.rateUnit,
        scalars: yoloScalars,
      };
    }
  }

  // 3. tqdm progress bar (supports arbitrary rate units: it/s, s/it, img/s, tok/s, samples/s, ?it/s)
  const bar = clean.match(
    /(?:^|[\s|])(\d+)\s*\/\s*(\d+)\s*\[([^\]\r\n]*(?:[0-9.]+\s*(?:it|iter|step|steps|img|imgs|tok|tokens|sample|samples|batch|batches)\/s|[0-9.]+\s*s\/(?:it|iter|step|img|tok|sample|batch)|\?it\/s)[^\]\r\n]*)\]/i,
  );
  if (bar) {
    const completed = safeInt(Number(bar[1]));
    const total = safeInt(Number(bar[2]));
    if (completed !== null && total !== null && total > 0 && completed <= total) {
      const { rate, rateUnit } = parseTqdmRate(bar[3]!);
      let unit: ProgressUnit = 'step';
      if (rateUnit?.startsWith('tok')) unit = 'token';
      else if (rateUnit?.startsWith('sample') || rateUnit?.startsWith('img')) unit = 'sample';
      return {
        ...result,
        isTrainingOutput: true,
        sessionCompletedCount: completed,
        sessionTargetCount: total,
        rate,
        rateUnit,
        unit,
        current: completed,
        total,
        ...(Object.keys(scalars).length ? { scalars } : {}),
        ...(nonFiniteLoss ? { nonFiniteLoss: true } : {}),
      };
    }
  }

  // 4. Epoch X/Y with training metrics (Lightning, Keras, PyTorch loops)
  const epochFraction = clean.match(/(?:^|[\s[,])epoch\s*[:=]?\s*(\d+)\s*\/\s*(\d+)(?=$|[\s,;:}\]])/i);
  if (epochFraction && (Object.keys(scalars).length > 0 || nonFiniteLoss || /\b(?:train|training)\b/i.test(clean))) {
    const curEpoch = safeInt(Number(epochFraction[1]));
    const totEpoch = safeInt(Number(epochFraction[2]));
    if (curEpoch !== null && totEpoch !== null && totEpoch > 0 && curEpoch <= totEpoch) {
      return {
        ...result,
        isTrainingOutput: true,
        unit: 'epoch',
        current: curEpoch,
        total: totEpoch,
        sessionCompletedCount: curEpoch,
        sessionTargetCount: totEpoch,
        ...(Object.keys(scalars).length ? { scalars } : {}),
        ...(nonFiniteLoss ? { nonFiniteLoss: true } : {}),
      };
    }
  }

  // 5. Bounded Step/Iter X/Y with training metrics
  const stepFraction = clean.match(/(?:^|[\s[,])(?:global_step|step|iteration|iter)\s*[:=]?\s*(\d+)\s*\/\s*(\d+)(?=$|[\s,;:}\]])/i);
  if (stepFraction && (Object.keys(scalars).length > 0 || nonFiniteLoss || /\b(?:train|training)\b/i.test(clean))) {
    const curStep = safeInt(Number(stepFraction[1]));
    const totStep = safeInt(Number(stepFraction[2]));
    if (curStep !== null && totStep !== null && totStep > 0 && curStep <= totStep) {
      return {
        ...result,
        isTrainingOutput: true,
        stepIndex: curStep,
        unit: 'step',
        current: curStep,
        total: totStep,
        ...(Object.keys(scalars).length ? { scalars } : {}),
        ...(nonFiniteLoss ? { nonFiniteLoss: true } : {}),
      };
    }
  }

  // 6. Token progress (e.g. `tokens: 1500000/10000000` or `tokens=500000 loss=2.1`)
  const tokenMatch = clean.match(/(?:^|[\s[,])tokens?\s*[:=]\s*(\d+)(?:\s*\/\s*(\d+))?(?=$|[\s,;:}\]])/i);
  if (tokenMatch && (Object.keys(scalars).length > 0 || nonFiniteLoss)) {
    const curTok = safeInt(Number(tokenMatch[1]));
    const totTok = tokenMatch[2] ? safeInt(Number(tokenMatch[2])) : null;
    if (curTok !== null) {
      return {
        ...result,
        isTrainingOutput: true,
        unit: 'token',
        current: curTok,
        total: totTok && totTok > 0 ? totTok : null,
        ...(Object.keys(scalars).length ? { scalars } : {}),
        ...(nonFiniteLoss ? { nonFiniteLoss: true } : {}),
      };
    }
  }

  // 7. Standard labelled step/iter with training/loss/grad_norm evidence
  // Exclude pure validation/eval-prefixed lines (e.g. `[val] step=42 loss=0.2`) unless explicit train_loss/train appears.
  const isPureEvalPrefixed = /^\s*\[(?:val|valid|validation|eval|test)\b[^\]]*\]/i.test(clean) &&
    !/\b(?:train|training|train_loss|training_loss)\b/i.test(clean);
  const hasTrainingSignal =
    !isPureEvalPrefixed && (
      /\b(?:train|training|train_loss|training_loss)\b/i.test(clean) ||
      scalars.loss !== undefined ||
      scalars.train_loss !== undefined ||
      scalars.grad_norm !== undefined ||
      nonFiniteLoss
    );
  const stepMatch = clean.match(/(?:^|[\s[,{])(?:global_step|step|iteration|iter)\s*[:= ]\s*(\d+)(?=$|[\s,;/}\]])/i);
  const step = stepMatch ? safeInt(Number(stepMatch[1])) : null;
  if (hasTrainingSignal && step !== null) {
    return {
      ...result,
      isTrainingOutput: true,
      stepIndex: step,
      unit: 'step',
      current: step,
      total: null,
      ...(Object.keys(scalars).length ? { scalars } : {}),
      ...(nonFiniteLoss ? { nonFiniteLoss: true } : {}),
    };
  }

  // 8. Standalone loss/val_loss line with Lightning/Epoch indicator (e.g., `Epoch 3: loss=0.45, val_loss=0.51`)
  const singleEpoch = clean.match(/(?:^|[\s[,])epoch\s*[:= ]\s*(\d+(?:\.\d+)?)(?=$|[\s,;:}\]])/i);
  if (singleEpoch && (scalars.loss !== undefined || scalars.train_loss !== undefined || scalars.val_loss !== undefined || nonFiniteLoss)) {
    const epochVal = Number(singleEpoch[1]);
    if (Number.isFinite(epochVal) && epochVal >= 0) {
      return {
        ...result,
        isTrainingOutput: true,
        unit: 'epoch',
        current: epochVal,
        total: null,
        ...(Object.keys(scalars).length ? { scalars } : {}),
        ...(nonFiniteLoss ? { nonFiniteLoss: true } : {}),
      };
    }
  }

  return result;
}
