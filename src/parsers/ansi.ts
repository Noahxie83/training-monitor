// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;

/** Strip ANSI CSI/OSC/ESC control sequences while keeping plain log text intact. */
export function stripAnsi(text: string): string {
  if (!text || !text.includes('\x1B')) return text;
  return text.replace(ANSI_PATTERN, '');
}

/** Return true when the string contains any ANSI escape sequence. */
export function hasAnsi(text: string): boolean {
  if (!text || !text.includes('\x1B')) return false;
  ANSI_PATTERN.lastIndex = 0;
  return ANSI_PATTERN.test(text);
}
