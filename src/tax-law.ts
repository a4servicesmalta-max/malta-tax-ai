/**
 * Cached Income Tax Act (Cap. 123) — the full consolidated Act (through Act III
 * of 2026), split by article, shipped with the app (src/data-law/ita.json,
 * built by scripts/build-ita-index.ts from the official PDF).
 *
 * Used to ground the AI review and interview in the actual statute: retrieval
 * returns article excerpts for the prompt. The law text informs REVIEW POINTS
 * and legal citations only — figures remain deterministic from the ETB and the
 * preparer's confirmed answers, never derived from the model reading the law.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ItaArticle {
  art: string;
  title: string;
  text: string;
}

let ARTICLES: ItaArticle[] = [];
try {
  const raw = fs.readFileSync(path.join(__dirname, 'data-law', 'ita.json'), 'utf8');
  ARTICLES = (JSON.parse(raw).articles as ItaArticle[]) ?? [];
} catch {
  ARTICLES = []; // asset missing → features degrade to citation-only, never throw
}

export function itaLoaded(): boolean {
  return ARTICLES.length > 0;
}

export function articleByNumber(art: string): ItaArticle | null {
  return ARTICLES.find((a) => a.art === art) ?? null;
}

/**
 * Keyword retrieval: rank articles by term hits, return the top `max` as
 * prompt-sized excerpts (first `excerptChars` chars each).
 */
export function findArticles(terms: string[], max = 4, excerptChars = 1500): ItaArticle[] {
  const t = terms.map((x) => x.toLowerCase()).filter(Boolean);
  if (!t.length) return [];
  return ARTICLES.map((a) => {
    const lc = a.text.toLowerCase();
    const score = t.reduce((s, term) => s + (lc.includes(term) ? 1 : 0), 0);
    return { a, score };
  })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, max)
    .map((x) => ({ ...x.a, text: x.a.text.slice(0, excerptChars) }));
}

/**
 * The statutory context block for the reasonableness-review prompt: the core
 * computation articles (14 deductions, 12 exemptions, 56 rates) plus articles
 * matched to what actually appears in this client's accounts/answers.
 */
export function statutoryContext(extraTerms: string[] = []): string {
  if (!itaLoaded()) return '';
  const core = ['14', '12', '56']
    .map(articleByNumber)
    .filter((a): a is ItaArticle => !!a)
    .map((a) => ({ ...a, text: a.text.slice(0, 2200) }));
  const matched = findArticles(extraTerms, 3, 1200).filter((m) => !core.some((c) => c.art === m.art));
  const all = [...core, ...matched];
  return (
    'STATUTE (Income Tax Act, Cap. 123 — consolidated; excerpts):\n' +
    all.map((a) => `--- Article ${a.art} ---\n${a.text}`).join('\n')
  );
}
