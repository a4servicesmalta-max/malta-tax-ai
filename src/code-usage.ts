/**
 * Real-world CfR code-usage prior, mined from filed returns (scripts/learn-corpus.ts,
 * data in code-usage-data.ts). Used only to NUDGE the mapper toward lines preparers
 * actually populate — it never decides a mapping alone and never touches a figure.
 */
import { CODE_USAGE } from './code-usage-data';

/** `sheet:code` keys populated on at least `min` filed returns — the "commonly used" lines. */
export function commonCodeKeys(min = 3): Set<string> {
  return new Set(CODE_USAGE.filter((r) => r.count >= min).map((r) => `${r.sheet}:${r.code}`));
}
