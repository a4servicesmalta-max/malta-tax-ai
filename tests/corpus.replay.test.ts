import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { replayAccuracy } from '../scripts/replay';
import { syntheticCfrWorkbook } from './helpers/synthetic';
import { parseEtb } from '../src/etb-parser';
import { proposeMapping } from '../src/mapping';
import type { EtbAccount, MappingProfile } from '../src/domain';

describe('replayAccuracy', () => {
  it('scores how many filed code values the mapped ETB reproduces', async () => {
    const filed = await syntheticCfrWorkbook({
      bSheet: [{ row: 10, code: 2150, value: 5000 }],
      income: [{ row: 5, code: 5000, value: -80000 }],
    });
    const etb: EtbAccount[] = [
      { accountCode: '1200', accountName: 'Bank', cyBalance: 5000, pyBalance: null },
      { accountCode: '4000', accountName: 'Sales', cyBalance: -79000, pyBalance: null }, // off by 1000
    ];
    const profile: MappingProfile = {
      rules: [
        { ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet' },
        { ledgerCode: '4000', cfrCode: 5000, sheet: 'Income' },
      ],
    };
    const r = await replayAccuracy(filed, etb, profile);
    expect(r.total).toBe(2);
    expect(r.matched).toBe(1);
    expect(r.diffs).toHaveLength(1);
    expect(r.diffs[0]).toMatchObject({ cfrCode: 5000, filed: -80000, generated: -79000 });
  });
});

// --- Real corpus replay (skips without fixtures) ---
// Layout (see scripts/fetch-fixtures.md): fixtures/etb/<Client>/<year>.xlsx and
// fixtures/returns/<Client>/<filed-return>.xlsx. For each client with at least one
// ETB and one filed return, pair the first of each and replay.
const FIXTURES_ROOT = path.join(__dirname, '..', 'fixtures');
const ETB_ROOT = path.join(FIXTURES_ROOT, 'etb');
const RETURNS_ROOT = path.join(FIXTURES_ROOT, 'returns');

interface ClientPair {
  client: string;
  etbPath: string;
  returnPath: string;
}

function findClientPairs(): ClientPair[] {
  if (!fs.existsSync(ETB_ROOT) || !fs.existsSync(RETURNS_ROOT)) return [];
  const clients = fs.readdirSync(ETB_ROOT).filter((c) => fs.statSync(path.join(ETB_ROOT, c)).isDirectory());
  const pairs: ClientPair[] = [];
  for (const client of clients) {
    const etbDir = path.join(ETB_ROOT, client);
    const returnDir = path.join(RETURNS_ROOT, client);
    if (!fs.existsSync(returnDir)) continue;
    const etbFiles = fs.readdirSync(etbDir).filter((f) => /\.xlsx?$/i.test(f));
    const returnFiles = fs.readdirSync(returnDir).filter((f) => /\.xlsx?$/i.test(f));
    if (etbFiles.length === 0 || returnFiles.length === 0) continue;
    pairs.push({
      client,
      etbPath: path.join(etbDir, etbFiles[0]),
      returnPath: path.join(returnDir, returnFiles[0]),
    });
  }
  return pairs;
}

const pairs = findClientPairs();

describe.skipIf(pairs.length === 0)('replay on real corpus (ETB vs actually-filed return)', () => {
  for (const p of pairs) {
    it(`reproduces a meaningful share of ${p.client}'s filed return`, async () => {
      const etb = parseEtb(fs.readFileSync(p.etbPath));
      const proposal = proposeMapping(etb.accounts, {});
      const r = await replayAccuracy(
        fs.readFileSync(p.returnPath),
        etb.accounts,
        { rules: proposal.rules }
      );
      expect(r.total).toBeGreaterThan(0);
      // Sanity floor, not a strict accuracy gate — heuristic-only proposal, no
      // prior-year bias in this smoke test.
      expect(r.matched / r.total).toBeGreaterThan(0);
    });
  }
});
