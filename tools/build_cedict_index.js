#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true";
    args[name] = value;
    if (value !== "true") i += 1;
  }
  return args;
}

function isAllCjk(value) {
  return /^[\u4e00-\u9fff]+$/.test(value);
}

function normalizePinyinToken(rawToken) {
  return String(rawToken || "")
    .toLowerCase()
    .replace(/[0-9]/g, "")
    .replace(/[^a-züv]/g, "")
    .replace(/v/g, "ü");
}

function buildIndex(inputPath) {
  const content = fs.readFileSync(inputPath, "utf8");
  const lines = content.split(/\r?\n/);
  const wordCount = new Map();
  const charFrequency = new Map();
  const pinyinChars = new Map();
  let entryCount = 0;

  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+\/.*\/$/);
    if (!match) continue;
    const simplified = match[2];
    const pinyinRaw = match[3];
    if (!isAllCjk(simplified)) continue;
    entryCount += 1;

    if (simplified.length >= 2 && simplified.length <= 6) {
      wordCount.set(simplified, (wordCount.get(simplified) || 0) + 1);
    }
    for (const ch of simplified) {
      charFrequency.set(ch, (charFrequency.get(ch) || 0) + 1);
    }

    if (simplified.length === 1) {
      const pinyinToken = normalizePinyinToken(String(pinyinRaw).split(/\s+/)[0] || "");
      if (pinyinToken) {
        if (!pinyinChars.has(pinyinToken)) pinyinChars.set(pinyinToken, new Set());
        pinyinChars.get(pinyinToken).add(simplified);
      }
    }
  }

  const words = [...wordCount.keys()];
  const frequentWords = [...wordCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hans-CN"))
    .slice(0, 25000)
    .map((item) => item[0]);

  const charConfusions = {};
  for (const chars of pinyinChars.values()) {
    const sorted = [...chars].sort((a, b) => (charFrequency.get(b) || 0) - (charFrequency.get(a) || 0));
    if (sorted.length < 2) continue;
    for (const current of sorted) {
      const alternatives = [];
      for (const candidate of sorted) {
        if (candidate === current) continue;
        if (!alternatives.includes(candidate)) alternatives.push(candidate);
        if (alternatives.length >= 12) break;
      }
      if (!alternatives.length) continue;
      if (!charConfusions[current]) charConfusions[current] = [];
      for (const item of alternatives) {
        if (!charConfusions[current].includes(item)) charConfusions[current].push(item);
      }
    }
  }

  return {
    version: "1.0.0",
    generated_at: new Date().toISOString(),
    source_path: inputPath,
    entry_count: entryCount,
    word_count: words.length,
    words,
    frequent_words: frequentWords,
    char_confusions: charConfusions
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input ? path.resolve(args.input) : "";
  const output = args.output ? path.resolve(args.output) : "";
  if (!input || !output) {
    console.error("Usage: node tools/build_cedict_index.js --input <cedict_ts.u8> --output <cedict_index.json>");
    process.exit(1);
  }
  if (!fs.existsSync(input)) {
    console.error(`Input not found: ${input}`);
    process.exit(2);
  }
  const index = buildIndex(input);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(index)}\n`, "utf8");
  console.log(`DONE: words=${index.word_count}, output=${output}`);
}

main();
