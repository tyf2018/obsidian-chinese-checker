"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TARGET_TOTAL = 3000;
const VC_PATH = path.join(ROOT, "VC词库.txt");
const IDIOM_PATH = path.join(ROOT, "rules", "chengyu_daquan.txt");
const CEDICT_INDEX_PATH = path.join(ROOT, "cedict_index.json");
const COMMON_TYPOS_PATH = path.join(ROOT, "rules", "common_typos_zh.json");
const VARIANT_FORMS_PATH = path.join(ROOT, "rules", "variant_forms_zh.json");

const FORCE_RULES = [
  { wrong: "按纳", correct: "按捺", confidence: 0.95 },
  { wrong: "保镳", correct: "保镖", confidence: 0.93 }
];

const DENY_CHAR_PAIRS = new Set([
  "说->数",
  "曲->区",
  "扇->山",
  "文->温",
  "行->性",
  "形->性",
  "劳->老",
  "厉->力",
  "吏->力",
  "忧->有",
  "雨->语",
  "省->生",
  "要->约",
  "迹->机",
  "籍->机",
  "合->格",
  "率->路",
  "正->证",
  "师->士"
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readUniqueLines(filePath, pattern = null) {
  if (!fs.existsSync(filePath)) return [];
  const seen = new Set();
  const lines = [];
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const value = String(line || "").trim();
    if (!value || seen.has(value)) continue;
    if (pattern && !pattern.test(value)) continue;
    seen.add(value);
    lines.push(value);
  }
  return lines;
}

function replaceCharAt(text, index, nextChar) {
  return `${text.slice(0, index)}${nextChar}${text.slice(index + 1)}`;
}

function compareZh(left, right) {
  return String(left).localeCompare(String(right), "zh-Hans-CN");
}

function isCjkWord(value) {
  return /^[\u4e00-\u9fff]{2,4}$/.test(String(value || ""));
}

function clampConfidence(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0.9;
  if (num < 0.5) return 0.5;
  if (num > 0.99) return 0.99;
  return Number(num.toFixed(2));
}

function normalizeRules(rawRules) {
  const seen = new Set();
  const normalized = [];
  for (const item of rawRules) {
    if (!item || typeof item !== "object") continue;
    const wrong = String(item.wrong || "").trim();
    const correct = String(item.correct || "").trim();
    if (!wrong || !correct || wrong === correct || seen.has(wrong)) continue;
    seen.add(wrong);
    normalized.push({
      wrong,
      correct,
      confidence: clampConfidence(item.confidence)
    });
  }
  return normalized;
}

function diffOneChar(wrong, correct) {
  const source = String(wrong || "");
  const target = String(correct || "");
  if (!source || !target || source.length !== target.length) return null;
  let changedIndex = -1;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === target[index]) continue;
    if (changedIndex >= 0) return null;
    changedIndex = index;
  }
  if (changedIndex < 0) return null;
  return {
    index: changedIndex,
    wrongChar: source[changedIndex],
    correctChar: target[changedIndex]
  };
}

function buildSingleCharSeedPairs(existingRules) {
  const counts = new Map();
  for (const item of existingRules) {
    if (Number(item.confidence || 0) < 0.9) continue;
    const diff = diffOneChar(item.wrong, item.correct);
    if (!diff) continue;
    const key = `${diff.wrongChar}->${diff.correctChar}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function collectIdiomDerivedRules(idiomWords, existingRules, variantWrongs, variantPairs) {
  if (!idiomWords.length) return [];
  const seedCounts = buildSingleCharSeedPairs(existingRules);
  const reverseSeedMap = new Map();
  for (const [pairKey, count] of seedCounts.entries()) {
    if (count < 5) continue;
    const [wrongChar, correctChar] = pairKey.split("->");
    if (!reverseSeedMap.has(correctChar)) reverseSeedMap.set(correctChar, []);
    reverseSeedMap.get(correctChar).push({ wrongChar, pairKey, count });
  }

  const idiomSet = new Set(idiomWords);
  const wrongToTargets = new Map();
  for (const correct of idiomWords) {
    for (let index = 0; index < correct.length; index += 1) {
      const seedItems = reverseSeedMap.get(correct[index]) || [];
      for (const seed of seedItems) {
        const wrong = replaceCharAt(correct, index, seed.wrongChar);
        if (wrong === correct || idiomSet.has(wrong)) continue;
        if (variantWrongs.has(wrong) || variantPairs.has(`${wrong}->${correct}`)) continue;
        if (!wrongToTargets.has(wrong)) wrongToTargets.set(wrong, []);
        wrongToTargets.get(wrong).push({
          correct,
          pairKey: seed.pairKey,
          seedCount: seed.count
        });
      }
    }
  }

  const idiomRules = [];
  for (const [wrong, targets] of wrongToTargets.entries()) {
    if (targets.length !== 1) continue;
    const target = targets[0];
    const confidence =
      target.seedCount >= 10 ? 0.95 :
      target.seedCount >= 7 ? 0.94 :
      0.93;
    idiomRules.push({
      wrong,
      correct: target.correct,
      confidence,
      seedCount: target.seedCount,
      pairKey: target.pairKey
    });
  }

  idiomRules.sort((left, right) => {
    if (right.seedCount !== left.seedCount) return right.seedCount - left.seedCount;
    if (right.confidence !== left.confidence) return right.confidence - left.confidence;
    return compareZh(left.wrong, right.wrong);
  });
  return idiomRules;
}

function collectVcCandidates(vcWords, wordsSet, frequentWords, confusions, variantWrongs, variantPairs) {
  const candidates = [];
  for (const token of vcWords) {
    if (!isCjkWord(token)) continue;
    const deduped = new Map();
    const tokenInWords = wordsSet.has(token);
    for (let index = 0; index < token.length; index += 1) {
      const sourceChar = token[index];
      const alternatives = Array.isArray(confusions[sourceChar]) ? confusions[sourceChar].slice(0, 12) : [];
      for (let rank = 0; rank < alternatives.length; rank += 1) {
        const nextChar = alternatives[rank];
        const correct = replaceCharAt(token, index, nextChar);
        if (correct === token || !wordsSet.has(correct) || deduped.has(correct)) continue;
        deduped.set(correct, {
          wrong: token,
          correct,
          len: token.length,
          rank,
          fromChar: sourceChar,
          toChar: nextChar,
          tokenInWords,
          correctFrequent: frequentWords.has(correct),
          pairKey: `${sourceChar}->${nextChar}`
        });
      }
    }
    const uniqueCandidates = [...deduped.values()];
    if (uniqueCandidates.length !== 1) continue;
    const candidate = uniqueCandidates[0];
    if (candidate.tokenInWords) continue;
    if (variantWrongs.has(candidate.wrong) || variantPairs.has(`${candidate.wrong}->${candidate.correct}`)) continue;
    if (DENY_CHAR_PAIRS.has(candidate.pairKey)) continue;
    candidates.push(candidate);
  }
  return candidates;
}

function buildPairStats(candidates) {
  const len4 = new Map();
  const len3 = new Map();
  const total = new Map();
  for (const item of candidates) {
    total.set(item.pairKey, (total.get(item.pairKey) || 0) + 1);
    if (item.len === 4) len4.set(item.pairKey, (len4.get(item.pairKey) || 0) + 1);
    if (item.len === 3) len3.set(item.pairKey, (len3.get(item.pairKey) || 0) + 1);
  }
  return { len4, len3, total };
}

function scoreVcCandidate(item, stats) {
  const len4Support = stats.len4.get(item.pairKey) || 0;
  const len3Support = stats.len3.get(item.pairKey) || 0;
  const totalSupport = stats.total.get(item.pairKey) || 0;
  let score = 0;
  score += item.len === 4 ? 90 : item.len === 3 ? 55 : 10;
  score += item.correctFrequent ? 22 : 0;
  score += Math.min(len4Support, 10) * 6;
  score += Math.min(len3Support, 8) * 4;
  score += Math.min(totalSupport, 20);
  score -= item.rank * 2;
  if (item.len === 2) score -= 18;
  return score;
}

function confidenceByVcScore(item, score, stats) {
  const len4Support = stats.len4.get(item.pairKey) || 0;
  const len3Support = stats.len3.get(item.pairKey) || 0;
  if (item.len === 4 && (len4Support >= 2 || score >= 145)) return 0.95;
  if (score >= 150) return 0.94;
  if (score >= 130) return 0.92;
  if (score >= 115) return 0.9;
  if (score >= 100) return 0.88;
  if (score >= 85) return 0.84;
  if (score >= 70) return 0.8;
  if (len4Support >= 1 || len3Support >= 1) return 0.79;
  return 0.76;
}

function main() {
  const cedictIndex = readJson(CEDICT_INDEX_PATH);
  const commonTypoJson = readJson(COMMON_TYPOS_PATH);
  const variantFormsJson = readJson(VARIANT_FORMS_PATH);

  const existingRules = normalizeRules(Array.isArray(commonTypoJson.rules) ? commonTypoJson.rules : []);
  const forcedRules = normalizeRules(FORCE_RULES);
  const variantRules = normalizeRules(Array.isArray(variantFormsJson.rules) ? variantFormsJson.rules : []);
  const variantWrongs = new Set(variantRules.map((item) => item.wrong));
  const variantPairs = new Set(variantRules.map((item) => `${item.wrong}->${item.correct}`));

  const idiomWords = readUniqueLines(IDIOM_PATH, /^[\u4e00-\u9fff]{4}$/);
  const idiomRules = collectIdiomDerivedRules(idiomWords, existingRules, variantWrongs, variantPairs);

  const activeExistingRules = existingRules.filter((item) => Number(item.confidence || 0) >= 0.8);
  const parkedExistingRules = existingRules.filter((item) => Number(item.confidence || 0) < 0.8);

  let vcRules = [];
  if (fs.existsSync(VC_PATH)) {
    const vcWords = readUniqueLines(VC_PATH);
    const wordsSet = new Set(Array.isArray(cedictIndex.words) ? cedictIndex.words : []);
    const frequentWords = new Set(Array.isArray(cedictIndex.frequent_words) ? cedictIndex.frequent_words : []);
    const confusions = cedictIndex.char_confusions && typeof cedictIndex.char_confusions === "object"
      ? cedictIndex.char_confusions
      : {};
    const generatedCandidates = collectVcCandidates(vcWords, wordsSet, frequentWords, confusions, variantWrongs, variantPairs);
    const stats = buildPairStats(generatedCandidates);
    vcRules = generatedCandidates
      .map((item) => {
        const score = scoreVcCandidate(item, stats);
        return {
          wrong: item.wrong,
          correct: item.correct,
          confidence: confidenceByVcScore(item, score, stats),
          score,
          len: item.len
        };
      })
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        if (right.confidence !== left.confidence) return right.confidence - left.confidence;
        if (right.len !== left.len) return right.len - left.len;
        return compareZh(left.wrong, right.wrong);
      });
  }

  const keep = [];
  const seen = new Set();
  for (const rule of [...activeExistingRules, ...forcedRules, ...idiomRules, ...vcRules, ...parkedExistingRules]) {
    if (keep.length >= TARGET_TOTAL) break;
    if (seen.has(rule.wrong)) continue;
    seen.add(rule.wrong);
    keep.push({
      wrong: rule.wrong,
      correct: rule.correct,
      confidence: clampConfidence(rule.confidence)
    });
  }

  const finalRules = normalizeRules(keep);
  const output = {
    version: "1.2.0",
    rules: finalRules
  };

  fs.writeFileSync(COMMON_TYPOS_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  const activeCount = finalRules.filter((item) => Number(item.confidence) >= 0.8).length;
  console.log(
    JSON.stringify(
      {
        target_total: TARGET_TOTAL,
        final_total: finalRules.length,
        active_count_ge_0_8: activeCount,
        parked_count_lt_0_8: finalRules.length - activeCount,
        idiom_source_exists: fs.existsSync(IDIOM_PATH),
        idiom_rule_count: idiomRules.length,
        vc_source_exists: fs.existsSync(VC_PATH),
        vc_rule_count: vcRules.length
      },
      null,
      2
    )
  );
}

main();
