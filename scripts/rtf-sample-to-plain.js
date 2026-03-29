/**
 * 将 TextEdit 等保存的 RTF（内含 # 元数据与 \u 转义）转为纯文本 ASCII + 解析 color。
 * 用法：node scripts/rtf-sample-to-plain.js samples/sheep.txt
 */
const fs = require('fs');
const path = require('path');

/**
 * 从 TextEdit 等导出的 RTF 中定位 `# resolution` 元数据块，再解码正文 `\u` 行。
 * @param {string} rtf
 * @returns {{ meta: Record<string, string>, ascii: string, colorHex: string }}
 */
function parseRtfSample(rtf) {
  const meta = {};
  const lines = rtf.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const raw = decodeRtfControlLine(lines[i]);
    if (/# resolution/i.test(raw)) {
      start = i;
      break;
    }
  }

  let bodyStart = 0;
  if (start >= 0) {
    let j = start;
    for (; j < lines.length; j++) {
      let raw = decodeRtfControlLine(lines[j]).trim();
      raw = raw.replace(/\\+$/g, '').trim();
      if (raw.startsWith('#')) {
        const m = raw.match(/^#\s*(\w+)\s*:\s*(.*)$/);
        if (m) meta[m[1].toLowerCase()] = m[2].trim();
        continue;
      }
      break;
    }
    while (j < lines.length) {
      const blank = decodeRtfControlLine(lines[j]).replace(/\\+$/g, '').trim();
      if (blank !== '') break;
      j++;
    }
    bodyStart = j;
  }

  const bodyLines = lines.slice(bodyStart);
  const ascii = bodyLines.map(decodeRtfControlLine).join('\n').replace(/\n{3,}/g, '\n\n').trim();

  let colorHex = '#00ff41';
  const c = (meta.color || '').toLowerCase().replace(/^#/, '');
  const map = {
    amber: '#ffd700',
    green: '#00ff41',
    white: '#ffffff',
    cyan: '#00cfff',
    red: '#ff6b6b',
    purple: '#cc99ff'
  };
  if (map[c]) colorHex = map[c];
  else if (/^#[0-9a-f]{6}$/i.test(meta.color || '')) colorHex = meta.color;

  return { meta, ascii, colorHex };
}

/**
 * 将 RTF 一行中的 \uDDDD、\'hh 转为字符，并去掉残留控制碎片。
 * @param {string} line
 * @returns {string}
 */
function decodeRtfControlLine(line) {
  let s = line;
  s = s.replace(/\\u(-?\d+)\s?/g, function (_, n) {
    let c = parseInt(n, 10);
    if (c < 0) c += 65536;
    return String.fromCharCode(c);
  });
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, function (_, hh) {
    return String.fromCharCode(parseInt(hh, 16));
  });
  s = s.replace(/\\[a-z]+\d*\s?/gi, '');
  s = s.replace(/[{}]/g, '');
  s = s.replace(/\s+/g, function (m) {
    return m.includes('\n') ? '\n' : ' ';
  });
  s = s.replace(/\\+$/g, '');
  return s.trimEnd();
}

module.exports = { parseRtfSample, decodeRtfControlLine };

if (require.main === module) {
  const inputPath = path.resolve(process.argv[2] || '');
  if (!inputPath || !fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
    console.error('Usage: node scripts/rtf-sample-to-plain.js <path-to-sample.rtf-or.txt>');
    process.exit(1);
  }
  const rtf = fs.readFileSync(inputPath, 'utf8');
  const { meta, ascii, colorHex } = parseRtfSample(rtf);
  const out = {
    file: path.basename(inputPath),
    meta,
    color: colorHex,
    ascii
  };
  console.log(JSON.stringify(out, null, 2));
}
