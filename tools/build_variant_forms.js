#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DEFAULT_CONFIDENCE = 0.68;

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
        confidence: DEFAULT_CONFIDENCE
      });
    }
  }
  const rules = [...ruleMap.values()].sort((left, right) => left.wrong.localeCompare(right.wrong, "zh-Hans-CN"));
  return { rules, conflicts };
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
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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
