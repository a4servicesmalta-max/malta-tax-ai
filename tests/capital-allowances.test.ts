import { describe, it, expect } from 'vitest';
import { classifyAsset, annualRate, wearAndTearGuidance } from '../src/capital-allowances';

describe('capital allowances (Malta wear-and-tear rates)', () => {
  it('classifies assets to the correct statutory period', () => {
    expect(classifyAsset('Computer equipment at cost')?.years).toBe(4);
    expect(classifyAsset('Software licence')?.years).toBe(4);
    expect(classifyAsset('Motor vehicle - Ford')?.years).toBe(5);
    expect(classifyAsset('Office furniture and fittings')?.years).toBe(10);
    expect(classifyAsset('Plant and machinery')?.years).toBe(5);
    expect(classifyAsset('Trade debtors')).toBeNull();
  });

  it('separates "other machinery" (5yr/20%) from "other plant" (10yr/10%) — not a shared 5yr bucket', () => {
    expect(classifyAsset('Factory machinery')?.years).toBe(5);
    expect(classifyAsset('Bottling plant')?.category).toBe('Other plant');
    expect(classifyAsset('Bottling plant')?.years).toBe(10);
  });

  it('software matches before generic computer (order matters)', () => {
    expect(classifyAsset('Computer software')?.category).toBe('Computer software');
  });

  it('implies the straight-line rate from the period', () => {
    expect(annualRate(4)).toBe(25);
    expect(annualRate(5)).toBe(20);
    expect(annualRate(10)).toBe(10);
  });

  it('builds one guidance line per distinct asset category present', () => {
    const g = wearAndTearGuidance([
      'Depreciation - Computer equipment',
      'Computer equipment at cost',
      'Motor vehicles at cost',
      'Trade debtors', // ignored
    ]);
    expect(g.some((l) => l.includes('Computers and electronic equipment') && l.includes('4 years'))).toBe(true);
    expect(g.some((l) => l.includes('Motor vehicles') && l.includes('5 years'))).toBe(true);
    expect(g.some((l) => l.includes('debtor'))).toBe(false);
  });

  it('flags the industrial buildings 2% + 10% initial allowance when a building is present', () => {
    const g = wearAndTearGuidance(['Industrial building at cost']);
    expect(g.some((l) => l.includes('2% per annum') && l.includes('10% initial'))).toBe(true);
  });

  it('caps the motor vehicles line at €14,000 for non-commercial cars', () => {
    const g = wearAndTearGuidance(['Motor vehicles at cost']);
    expect(g.some((l) => l.includes('Motor vehicles') && l.includes('€14,000'))).toBe(true);
  });
});
