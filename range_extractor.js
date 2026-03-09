function mergeRanges(ranges) {
  if (!ranges.length) return [];
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.from <= last.to) {
      last.to = Math.max(last.to, current.to);
    } else {
      merged.push(current);
    }
  }
  return merged;
}

function invertRanges(totalLength, blocked) {
  if (totalLength <= 0) return [];
  if (!blocked.length) return [{ from: 0, to: totalLength }];
  const ranges = [];
  let cursor = 0;
  for (const item of blocked) {
    if (item.from > cursor) ranges.push({ from: cursor, to: item.from });
    cursor = Math.max(cursor, item.to);
  }
  if (cursor < totalLength) ranges.push({ from: cursor, to: totalLength });
  return ranges.filter((item) => item.to > item.from);
}

function collectRegexRanges(text, regex, into) {
  let match = regex.exec(text);
  while (match) {
    const from = match.index;
    const to = match.index + match[0].length;
    if (to > from) into.push({ from, to });
    match = regex.exec(text);
  }
}

function collectBlockedRanges(text) {
  const blocked = [];
  const frontmatter = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  if (frontmatter) blocked.push({ from: 0, to: frontmatter[0].length });
  collectRegexRanges(text, /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2[^\n]*(?=\n|$)/g, blocked);
  collectRegexRanges(text, /`[^`\n]+`/g, blocked);
  collectRegexRanges(text, /\$\$[\s\S]*?\$\$/g, blocked);
  collectRegexRanges(text, /\$[^$\n]+\$/g, blocked);
  collectRegexRanges(text, /https?:\/\/[^\s)\]]+/g, blocked);
  collectRegexRanges(text, /\]\([^)\n]+\)/g, blocked);
  return mergeRanges(blocked);
}

function extractDetectableRanges(text) {
  return invertRanges(String(text || "").length, collectBlockedRanges(String(text || "")));
}

module.exports = {
  extractDetectableRanges,
  collectBlockedRanges
};
