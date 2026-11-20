// Document quotes are prose, not byte sequences. Model output and README
// sources legitimately differ in line endings, hard wrapping, indentation and
// inline Markdown markers, so both sides are normalized before the containment
// check. The quote must still be a contiguous span of the public document: the
// normalizer only removes formatting noise, never reorders or invents text.

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;
const BLOCK_PREFIX = /^[\t ]*(?:#{1,6}[\t ]+|>[\t ]?|[-+*][\t ]+|\d{1,9}\.[\t ]+)/;

function normalizeLine(line) {
  return line
    .replace(BLOCK_PREFIX, '')
    .replace(/[`*]/g, '')
    .replace(/[\t ]{2,}/g, ' ')
    .replace(/[\t ]+$/, '')
    .trim();
}

// Fold every paragraph's hard-wrapped lines into one line and keep paragraph
// boundaries, so a quote may span wrapped lines but not unrelated sections.
export function normalizeDocumentProse(value) {
  if (typeof value !== 'string') return '';
  const paragraphs = [];
  let current = [];
  for (const raw of value.replace(/\r\n?/g, '\n').replace(ZERO_WIDTH, '').split('\n')) {
    const line = normalizeLine(raw);
    if (!line) {
      if (current.length) {
        paragraphs.push(current.join(' '));
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length) paragraphs.push(current.join(' '));
  return paragraphs.join('\n');
}

export function documentContainsQuote(documentText, quote) {
  const needle = normalizeDocumentProse(quote);
  if (!needle) return false;
  return normalizeDocumentProse(documentText).includes(needle);
}
