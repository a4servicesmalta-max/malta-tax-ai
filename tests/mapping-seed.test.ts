import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { seedFromRepoIfEmpty } from '../src/mapping-memory';

const FILE = path.join(process.env.DATA_DIR!, 'mappings.json');

describe('seedFromRepoIfEmpty', () => {
  it('copies the repo corpus mappings onto an empty data dir, and never overwrites', () => {
    if (fs.existsSync(FILE)) fs.rmSync(FILE);
    seedFromRepoIfEmpty();
    // repo ships data/mappings.json (corpus learnings) — the seed must land it
    const seeded = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    expect(Array.isArray(seeded)).toBe(true);
    expect(seeded.length).toBeGreaterThan(0);

    // second boot: existing (possibly learned-in-prod) data must be left alone
    fs.writeFileSync(FILE, '[{"sentinel":true}]');
    seedFromRepoIfEmpty();
    expect(fs.readFileSync(FILE, 'utf8')).toBe('[{"sentinel":true}]');
  });
});
