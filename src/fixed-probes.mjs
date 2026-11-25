const fixedBlock = /^ {0,3}```(?:json[ \t]+)?mining-probes[ \t]*\r?\n([\s\S]*?)^ {0,3}```[ \t]*\r?$/gm;
const documentedLine = /^\s*\d+[.)]\s*(?:参数为?|argv\s*[:：])\s*`([^`]+)`[，,]\s*(?:标准输入为?|stdin\s*[:：])\s*`([^`]*)`[ \t]*(加末尾换行)?[。.]?\s*$/iu;
const declaredLine = /^\s*\d+[.)]\s*(?:参数|argv\b).*?(?:标准输入|stdin\b)/imu;
const fixedMarker = /(?:参数为|标准输入为|(?:参数|标准输入|argv|stdin)[ \t]*[:：])[ \t]*`/iu;
const invalid = () => new Error('固定探测格式不明确；请用 mining-probes JSON 代码块逐项填写 argv 数组和 stdin 字符串。未运行探测。');

export function readFixedProbes(body) {
  if (typeof body !== 'string') throw invalid();
  const blocks = [...body.matchAll(fixedBlock)];
  let rows;
  if (blocks.length || /^ {0,3}```(?:json[ \t]+)?mining-probes\b/m.test(body)) {
    if (blocks.length !== 1) throw invalid();
    try { rows = JSON.parse(blocks[0][1]); } catch { throw invalid(); }
  } else {
    rows = [];
    for (const line of body.split(/\r?\n/)) {
      if (!declaredLine.test(line) && !fixedMarker.test(line)) continue;
      const match = documentedLine.exec(line);
      // Only simple unquoted vectors can be parsed without guessing shell semantics.
      if (!match || !/^[\w./+()[\]*?{}:=-]+(?: [\w./+()[\]*?{}:=-]+)*$/u.test(match[1])) throw invalid();
      rows.push({argv: match[1].split(' '), stdin: match[2] + (match[3] ? '\n' : '')});
    }
    if (!rows.length) return [];
  }
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 5) throw invalid();
  return rows.map((row, i) => {
    if (!row || Object.keys(row).length !== 2 || !Array.isArray(row.argv) ||
        !row.argv.every(arg => typeof arg === 'string') || typeof row.stdin !== 'string') throw invalid();
    return {id: `OBS-fixed-${i + 1}`, argv: [...row.argv], stdin: row.stdin};
  });
}
