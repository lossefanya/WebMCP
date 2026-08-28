export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  /**
   * Audit lines: every tool call that ran, and every one that was refused.
   * Separated from `info` so a user can grep for what actually touched disk.
   */
  audit(msg: string): void;
}

export function createLogger(verbose = false): Logger {
  const stamp = () => new Date().toISOString();
  return {
    info: (m) => verbose && process.stderr.write(`[${stamp()}] ${m}\n`),
    warn: (m) => process.stderr.write(`[${stamp()}] warn: ${m}\n`),
    error: (m) => process.stderr.write(`[${stamp()}] error: ${m}\n`),
    audit: (m) => process.stdout.write(`[${stamp()}] ${m}\n`),
  };
}
