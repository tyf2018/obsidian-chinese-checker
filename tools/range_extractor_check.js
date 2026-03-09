const { extractDetectableRanges } = require("../range_extractor");

function findNthIndex(text, needle, nth = 1) {
  let fromIndex = 0;
  for (let i = 0; i < nth; i += 1) {
    const found = text.indexOf(needle, fromIndex);
    if (found < 0) return -1;
    if (i === nth - 1) return found;
    fromIndex = found + needle.length;
  }
  return -1;
}

function isDetectable(ranges, from, to) {
  return ranges.some((item) => from >= item.from && to <= item.to);
}

function runCase(testCase) {
  const ranges = extractDetectableRanges(testCase.text);
  const failures = [];
  for (const check of testCase.checks) {
    const anchorIndex = findNthIndex(testCase.text, check.anchor, check.nth || 1);
    if (anchorIndex < 0) {
      failures.push(`[${testCase.name}] 未找到锚点: ${check.anchor}`);
      continue;
    }
    const from = anchorIndex + (check.offset || 0);
    const length = Number(check.length) > 0 ? Number(check.length) : 1;
    const to = from + length;
    const actual = isDetectable(ranges, from, to);
    if (actual !== check.shouldDetect) {
      failures.push(
        `[${testCase.name}] 断言失败: ${check.label}，期望 ${
          check.shouldDetect ? "应检" : "不应检"
        }，实际${actual ? "应检" : "不应检"}`
      );
    }
  }
  return failures;
}

function main() {
  const testCases = [
    {
      name: "frontmatter",
      text: [
        "---",
        "title: 前言天齐",
        "language-tool-ignore: false",
        "---",
        "正文天齐可检出"
      ].join("\n"),
      checks: [
        {
          label: "frontmatter 内容应过滤",
          anchor: "前言天齐",
          offset: 2,
          length: 2,
          shouldDetect: false
        },
        {
          label: "正文应检测",
          anchor: "正文天齐可检出",
          offset: 2,
          length: 2,
          shouldDetect: true
        }
      ]
    },
    {
      name: "code-block-and-inline-code",
      text: [
        "正文错别字天齐应检出",
        "```js",
        "const x = '代码块天齐不应检';",
        "```",
        "行内 `示例天齐` 不应检。"
      ].join("\n"),
      checks: [
        {
          label: "正文应检测",
          anchor: "正文错别字天齐应检出",
          offset: 5,
          length: 2,
          shouldDetect: true
        },
        {
          label: "代码块应过滤",
          anchor: "代码块天齐不应检",
          offset: 3,
          length: 2,
          shouldDetect: false
        },
        {
          label: "行内代码应过滤",
          anchor: "示例天齐",
          offset: 2,
          length: 2,
          shouldDetect: false
        }
      ]
    },
    {
      name: "math-url-link",
      text: [
        "行内公式 $天齐$ 不应检。",
        "块公式：",
        "$$",
        "天齐",
        "$$",
        "链接 https://example.com/天齐/path 不应检。",
        "[文档](https://another.example/天齐) 地址不应检。",
        "普通正文天齐应检。"
      ].join("\n"),
      checks: [
        {
          label: "行内公式应过滤",
          anchor: "$天齐$",
          offset: 1,
          length: 2,
          shouldDetect: false
        },
        {
          label: "块公式应过滤",
          anchor: "块公式：\n$$\n天齐\n$$",
          offset: 7,
          length: 2,
          shouldDetect: false
        },
        {
          label: "URL 应过滤",
          anchor: "https://example.com/天齐/path",
          offset: 20,
          length: 2,
          shouldDetect: false
        },
        {
          label: "Markdown 链接地址应过滤",
          anchor: "https://another.example/天齐",
          offset: 24,
          length: 2,
          shouldDetect: false
        },
        {
          label: "普通正文应检测",
          anchor: "普通正文天齐应检",
          offset: 4,
          length: 2,
          shouldDetect: true
        }
      ]
    }
  ];

  const failures = [];
  for (const testCase of testCases) {
    failures.push(...runCase(testCase));
  }

  if (failures.length) {
    console.error("Range extractor check failed:");
    for (const line of failures) {
      console.error(`- ${line}`);
    }
    process.exit(1);
  }

  console.log("Range extractor check passed.");
}

main();
