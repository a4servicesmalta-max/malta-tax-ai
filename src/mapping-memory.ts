/**
 * Per-client mapping memory — the flywheel. Every mapping the preparer
 * CONFIRMS at generate time is persisted (ledger code + name -> CfR line).
 * Next year's upload for the same client is recognised by ledger-code overlap
 * and opens pre-mapped with the firm's own confirmed history. Deterministic:
 * replayed rules are filed fact, and template/statement filters still apply.
 *
 * ponytail: flat JSON alongside users/returns (same /data disk, same
 * single-instance sync-write model). Postgres when volume demands.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { EtbAccount, ProposedRule, CfrSheet } from './domain';

const DATA_DIR =
  process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(process.cwd(), 'data'));
const FILE = path.join(DATA_DIR, 'mappings.json');

export interface MemoryRule {
  ledgerCode: string;
  ledgerName: string;
  cfrCode: number;
  sheet: CfrSheet;
}

export interface MappingMemory {
  id: string;
  /** Account that confirmed the mapping ('shared' when auth is off). */
  owner: string;
  clientName: string;
  yearOfAssessment: string;
  rules: MemoryRule[];
  updatedAt: string;
}

/**
 * Seed the mapping memory from the repo's committed corpus learnings when the
 * data disk has none. In production DATA_DIR is the /data disk, so the 70KB of
 * corpus-learned mappings shipped in the image at <cwd>/data/mappings.json was
 * silently ignored — live uploads ran without the flywheel (found 2026-07-07:
 * live CEE upload returned recalledFrom=null while the same commit locally
 * recognised the client). Never overwrites learned production data.
 */
export function seedFromRepoIfEmpty(): void {
  try {
    if (fs.existsSync(FILE)) return;
    const repoCopy = path.join(process.cwd(), 'data', 'mappings.json');
    if (repoCopy === FILE || !fs.existsSync(repoCopy)) return;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.copyFileSync(repoCopy, FILE);
    console.info(`[mapping-memory] seeded ${load().length} corpus-learned mappings from ${repoCopy}`);
  } catch (e) {
    console.warn(`[mapping-memory] seed skipped: ${(e as Error).message}`);
  }
}

function load(): MappingMemory[] {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')) as MappingMemory[];
  } catch {
    return [];
  }
}

function save(all: MappingMemory[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
}

/** Persist the confirmed mapping for a client (replaces the owner+client entry). */
export function rememberMapping(
  owner: string,
  clientName: string,
  yearOfAssessment: string,
  rules: MemoryRule[]
): void {
  if (!rules.length) return;
  const all = load();
  const key = clientName.trim().toLowerCase();
  const idx = all.findIndex((m) => m.owner === owner && m.clientName.trim().toLowerCase() === key);
  const row: MappingMemory = {
    id: idx >= 0 ? all[idx].id : `map_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    owner,
    clientName: clientName.trim(),
    yearOfAssessment,
    rules,
    updatedAt: new Date().toISOString(),
  };
  if (idx >= 0) all[idx] = row;
  else all.push(row);
  save(all);
}

/**
 * Recognise a returning client by ledger-code overlap (no client name needed at
 * upload): the stored mapping sharing the most ledger codes with this ETB wins,
 * if at least half of its codes appear. Returns replayable proposals for the
 * accounts it knows (code must match; name drift tolerated).
 */
export function recallMapping(
  owner: string,
  accounts: EtbAccount[]
): { clientName: string; rules: ProposedRule[] } | null {
  const all = load().filter((m) => m.owner === owner);
  if (!all.length) return null;
  const codes = new Set(accounts.map((a) => a.accountCode));
  let best: { m: MappingMemory; overlap: number } | null = null;
  for (const m of all) {
    const overlap = m.rules.filter((r) => codes.has(r.ledgerCode)).length;
    if (overlap >= Math.max(3, m.rules.length / 2) && (!best || overlap > best.overlap)) {
      best = { m, overlap };
    }
  }
  if (!best) return null;
  const rules: ProposedRule[] = best.m.rules
    .filter((r) => codes.has(r.ledgerCode))
    .map((r) => ({ ledgerCode: r.ledgerCode, cfrCode: r.cfrCode, sheet: r.sheet, confidence: 0.98 }));
  return { clientName: best.m.clientName, rules };
}
