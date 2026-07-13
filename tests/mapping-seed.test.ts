import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedFromRepoIfEmpty } from '../src/mapping-memory';

const FILE = path.join(process.env.DATA_DIR!, 'mappings.json');

// The real corpus seed (data/mappings.json) is learned from confidential client
// filings and is NEVER committed — the flywheel legitimately starts empty in a
// fresh deploy and grows from live use. So this test exercises the seed
// MECHANISM against an injected source fixture rather than a repo-shipped file:
// it must copy a seed onto an empty data dir, and never overwrite existing data.
describe('seedFromRepoIfEmpty', () => {
  it('copies an available corpus seed onto an empty data dir, and never overwrites', () => {
    if (fs.existsSync(FILE)) fs.rmSync(FILE);

    // A source seed the operator dropped into the image/disk.
    const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taxgen-seed-'));
    const seedSrc = path.join(seedDir, 'mappings.json');
    const seedRows = [
      {
        id: 'map_seed1',
        owner: 'shared',
        clientName: 'Seed Client',
        yearOfAssessment: '2025',
        rules: [{ ledgerCode: '5000', ledgerName: 'Sales', cfrCode: 5000, sheet: 'Income' }],
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    fs.writeFileSync(seedSrc, JSON.stringify(seedRows));

    seedFromRepoIfEmpty(seedSrc);
    const seeded = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    expect(Array.isArray(seeded)).toBe(true);
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded[0].clientName).toBe('Seed Client');

    // Second boot: existing (learned-in-prod) data must be left alone.
    fs.writeFileSync(FILE, '[{"sentinel":true}]');
    seedFromRepoIfEmpty(seedSrc);
    expect(fs.readFileSync(FILE, 'utf8')).toBe('[{"sentinel":true}]');

    // A missing source is a harmless no-op (the common fresh-deploy case).
    fs.rmSync(FILE);
    seedFromRepoIfEmpty(path.join(seedDir, 'does-not-exist.json'));
    expect(fs.existsSync(FILE)).toBe(false);
  });
});
