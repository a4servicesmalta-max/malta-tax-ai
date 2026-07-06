/**
 * Build the cached Income Tax Act (Cap. 123) asset from the extracted text:
 * split into articles, emit src/data-law/ita.json { articles: [{ art, title, text }] }.
 * The Act is public law — shipping it in the repo is fine.
 *
 * Usage: npx tsx scripts/build-ita-index.ts <ita.txt>
 */
import fs from 'node:fs';
import path from 'node:path';

const raw = fs.readFileSync(process.argv[2], 'utf8');

// Articles start as "N." or "NA." at a line start (after marginal-note noise),
// optionally followed by "(1)". Capture from each anchor to the next.
const anchorRe = /\n\s*(\d{1,3}[A-Z]{0,2})\.\s*(?=\(1\)|[A-Z"])/g;
interface Hit { art: string; idx: number }
const hits: Hit[] = [];
let m: RegExpExecArray | null;
let lastNum = 0;
while ((m = anchorRe.exec(raw))) {
  const art = m[1];
  const num = parseInt(art, 10);
  // Keep anchors roughly monotonic (1..96 with letter suffixes) to skip cross-references.
  if (num >= 1 && num <= 96 && num >= lastNum - 2) {
    hits.push({ art, idx: m.index });
    lastNum = Math.max(lastNum, num);
  }
}

// Dedup consecutive same-article anchors (marginal notes repeat numbers).
const arts: Array<{ art: string; title: string; text: string }> = [];
for (let i = 0; i < hits.length; i++) {
  const h = hits[i];
  if (arts.length && arts[arts.length - 1].art === h.art) continue;
  const end = i + 1 < hits.length ? hits[i + 1].idx : raw.length;
  const text = raw
    .slice(h.idx, end)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20000); // cap pathological spans
  // Title = the marginal note just before the anchor (previous ~200 chars, last capitalised line).
  const before = raw.slice(Math.max(0, h.idx - 250), h.idx);
  const noteMatch = before.match(/([A-Z][A-Za-z ,\-()']{6,80}\.)\s*(?:Amended by:[\s\S]*)?$/);
  arts.push({ art: h.art, title: noteMatch ? noteMatch[1].trim() : '', text });
}

const outDir = path.join(__dirname, '..', 'src', 'data-law');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'ita.json'), JSON.stringify({ chapter: 'Cap. 123 Income Tax Act', articles: arts }));
console.log(`articles: ${arts.length}; total chars: ${arts.reduce((a, x) => a + x.text.length, 0)}`);
console.log('sample:', arts.slice(0, 5).map((a) => `${a.art} "${a.title.slice(0, 40)}"`).join(' | '));
const key = arts.filter((a) => ['14', '12', '56', '4', '5'].includes(a.art));
key.forEach((a) => console.log(`Art ${a.art}: ${a.text.slice(0, 100)}...`));
