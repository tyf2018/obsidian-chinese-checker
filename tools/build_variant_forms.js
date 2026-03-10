#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DEFAULT_CONFIDENCE = 0.68;
const RULE_BASIS_OVERRIDES = Object.freeze({
  "交待->交代": "“交代”是现代汉语的规范用词，适用于绝大多数场合。“交待”是一个已经或正在被淘汰的词。",
  "帐号->账号": "在古代“贝”曾作为货币，因此“账”字本义就与金钱、财物记载有关。根据《现代汉语词典》及教育部、国家语言文字工作委员会发布的《第一批异形词整理表》，“账”是“帐”的分化字。为了区分，“账”专门用于与货币、货物出入记载、债务等相关的词语，如“账本”“报账”“银行账号”。"
});

function parseArgs(argv) {
  const options = {
    input: "",
    output: ""
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--input") options.input = String(argv[index + 1] || "");
    if (token === "--output") options.output = String(argv[index + 1] || "");
  }
  return options;
}

function sanitizeToken(rawToken) {
  const withoutNotes = String(rawToken || "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳0-9]/g, "")
    .replace(/[*＊]/g, "")
    .replace(/\s+/g, "");
  const token = withoutNotes.replace(/[^\u4e00-\u9fff]/g, "");
  return token.trim();
}

function buildRuleBasis(wrong, correct) {
  const normalizedWrong = String(wrong || "").trim();
  const normalizedCorrect = String(correct || "").trim();
  if (!normalizedWrong || !normalizedCorrect || normalizedWrong === normalizedCorrect) return "";
  const override = RULE_BASIS_OVERRIDES[`${normalizedWrong}->${normalizedCorrect}`];
  if (override) return override;
  return `“${normalizedCorrect}”是现代汉语的规范用词，适用于绝大多数场合。“${normalizedWrong}”是一个已经或正在被淘汰的词。`;
}

function extractVariantRules(rawContent) {
  const lines = String(rawContent || "").split(/\r?\n/);
  const ruleMap = new Map();
  const conflicts = [];
  let inMainTable = false;
  for (const rawLine of lines) {
    const line = String(rawLine || "").replace(/\u00a0/g, " ").trim();
    if (!line) continue;
    if (line === "A") {
      inMainTable = true;
      continue;
    }
    if (!inMainTable) continue;
    if (line.startsWith("【附录】")) break;
    if (/^[A-Z]$/.test(line)) continue;
    if (!line.includes("－")) continue;
    const separatorIndex = line.indexOf("－");
    if (separatorIndex <= 0) continue;
    const correct = sanitizeToken(line.slice(0, separatorIndex));
    if (!correct || correct.length < 2) continue;
    const wrongPart = line.slice(separatorIndex + 1);
    for (const rawWrong of wrongPart.split("、")) {
      const wrong = sanitizeToken(rawWrong);
      if (!wrong || wrong.length < 2 || wrong === correct) continue;
      const previous = ruleMap.get(wrong);
      if (previous && previous.correct !== correct) {
        conflicts.push({ wrong, previous: previous.correct, next: correct });
        continue;
      }
      ruleMap.set(wrong, {
        wrong,
        correct,
        confidence: DEFAULT_CONFIDENCE,
        basis: buildRuleBasis(wrong, correct)
      });
    }
  }
  const rules = [...ruleMap.values()].sort((left, right) => left.wrong.localeCompare(right.wrong, "zh-Hans-CN"));
  return { rules, conflicts };
}

function stringifyVariantPayload(payload) {
  const rules = Array.isArray(payload.rules) ? payload.rules : [];
  const topKeys = Object.keys(payload).filter((key) => key !== "rules");
  const lines = ["{"];
  for (const key of topKeys) {
    lines.push(`  "${key}": ${JSON.stringify(payload[key])},`);
  }
  lines.push('  "rules": [');
  for (let index = 0; index < rules.length; index += 1) {
    const item = rules[index] || {};
    const wrong = String(item.wrong || "");
    const correct = String(item.correct || "");
    const confidenceRaw = Number(item.confidence);
    const confidence = Number.isFinite(confidenceRaw) ? confidenceRaw : DEFAULT_CONFIDENCE;
    const basis = String(item.basis || "").trim() || buildRuleBasis(wrong, correct);
    const suffix = index === rules.length - 1 ? "" : ",";
    lines.push(
      `    {"wrong": ${JSON.stringify(wrong)}, "correct": ${JSON.stringify(correct)}, "confidence": ${confidence}, "basis": ${JSON.stringify(basis)}}${suffix}`
    );
  }
  lines.push("  ]");
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const scriptDir = __dirname;
  const inputPath = path.resolve(scriptDir, args.input || path.join("..", "异形词整理表.md"));
  const outputPath = path.resolve(scriptDir, args.output || path.join("..", "rules", "variant_forms_zh.json"));
  const rawContent = fs.readFileSync(inputPath, "utf8");
  const { rules, conflicts } = extractVariantRules(rawContent);
  const payload = {
    version: "1.0.0",
    generated_at: new Date().toISOString(),
    source_markdown: inputPath,
    rule_type: "variant_form",
    rule_count: rules.length,
    rules
  };
  fs.writeFileSync(outputPath, stringifyVariantPayload(payload), "utf8");
  console.log(`variant form rules written: ${outputPath}`);
  console.log(`rule count: ${rules.length}`);
  if (conflicts.length) {
    console.warn(`conflicts skipped: ${conflicts.length}`);
    for (const item of conflicts.slice(0, 20)) {
      console.warn(`${item.wrong}: ${item.previous} / ${item.next}`);
    }
  }
}

main();
