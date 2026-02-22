export const GRAMMAR_PATTERNS = [
  {
    id: "node",
    name: "ので",
    explanationZh: "表示原因，语气较客观（因为……）。",
    regex: /ので/gu,
    weight: 3
  },
  {
    id: "noni",
    name: "のに",
    explanationZh: "表示转折或意外（明明……却……）。",
    regex: /のに/gu,
    weight: 4
  },
  {
    id: "kedo",
    name: "けど/けれど",
    explanationZh: "转折连接（但是……）。",
    regex: /けれども|けれど|けど/gu,
    weight: 3
  },
  {
    id: "ga-contrast",
    name: "が (逆接)",
    explanationZh: "句中转折连接（但是……）。",
    regex: /が、|が。|が\\s/gu,
    weight: 2
  },
  {
    id: "temoii",
    name: "てもいい",
    explanationZh: "表示许可（可以……）。",
    regex: /てもいい|てもよい/gu,
    weight: 4
  },
  {
    id: "tewaikenai",
    name: "てはいけない",
    explanationZh: "表示禁止（不可以……）。",
    regex: /てはいけない|てはならない/gu,
    weight: 5
  },
  {
    id: "tekudasai",
    name: "てください",
    explanationZh: "礼貌请求（请……）。",
    regex: /てください/gu,
    weight: 4
  },
  {
    id: "teiru",
    name: "ている",
    explanationZh: "表示进行或状态持续。",
    regex: /ている|でいる/gu,
    weight: 3
  },
  {
    id: "teshimau",
    name: "てしまう",
    explanationZh: "表示完成或遗憾（不小心……）。",
    regex: /てしまう|でしまう|ちゃう|じゃう/gu,
    weight: 4
  },
  {
    id: "youda",
    name: "ようだ",
    explanationZh: "表示比况或推测（好像……）。",
    regex: /ようだ|ようです/gu,
    weight: 4
  },
  {
    id: "rashii",
    name: "らしい",
    explanationZh: "表示传闻或典型特征（听说/像……）。",
    regex: /らしい/gu,
    weight: 4
  },
  {
    id: "souda",
    name: "そうだ",
    explanationZh: "表示传闻或样态（听说/看起来……）。",
    regex: /そうだ/gu,
    weight: 3
  },
  {
    id: "nakerebanaranai",
    name: "なければならない",
    explanationZh: "表示义务（必须……）。",
    regex: /なければならない|なければいけない|なくてはならない|なくてはいけない/gu,
    weight: 5
  },
  {
    id: "nakutemoii",
    name: "なくてもいい",
    explanationZh: "表示不必要（不……也可以）。",
    regex: /なくてもいい|なくてもよい/gu,
    weight: 5
  },
  {
    id: "kotogaaru",
    name: "ことがある",
    explanationZh: "表示有时会……或经历。",
    regex: /ことがある/gu,
    weight: 3
  },
  {
    id: "kotoninaru",
    name: "ことになる",
    explanationZh: "表示结果决定为……。",
    regex: /ことになる|ことになっている/gu,
    weight: 4
  },
  {
    id: "tameni",
    name: "ために",
    explanationZh: "表示目的或原因（为了……）。",
    regex: /ために/gu,
    weight: 3
  },
  {
    id: "bakari",
    name: "ばかり",
    explanationZh: "表示大约/净是/刚刚。",
    regex: /ばかり/gu,
    weight: 3
  },
  {
    id: "temiru",
    name: "てみる",
    explanationZh: "表示尝试做某事。",
    regex: /てみる|でみる/gu,
    weight: 4
  },
  {
    id: "okagede",
    name: "おかげで",
    explanationZh: "托……的福，多用于好结果。",
    regex: /おかげで/gu,
    weight: 4
  },
  {
    id: "nichigainai",
    name: "に違いない",
    explanationZh: "表示强推测（一定……）。",
    regex: /に違いない/gu,
    weight: 5
  },
  {
    id: "shikanai",
    name: "しか〜ない",
    explanationZh: "表示限定（只……）。",
    regex: /しか[^。！？\n]{0,20}ない/gu,
    weight: 4
  },
  {
    id: "kamoshirenai",
    name: "かもしれない",
    explanationZh: "表示不确定推测（也许……）。",
    regex: /かもしれない/gu,
    weight: 4
  }
];

function toPatternResult(pattern, matchCount, firstMatch) {
  return {
    id: pattern.id,
    name: pattern.name,
    explanationZh: pattern.explanationZh,
    count: matchCount,
    score: pattern.weight + Math.min(matchCount, 3),
    matchText: firstMatch?.[0] ?? "",
    start: firstMatch?.index ?? -1
  };
}

export function detectGrammarPatterns(text, options = {}) {
  const topK = options.topK ?? 3;
  const results = [];

  for (const pattern of GRAMMAR_PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    const matches = [...text.matchAll(regex)];
    if (!matches.length) {
      continue;
    }
    results.push(toPatternResult(pattern, matches.length, matches[0]));
  }

  results.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    return a.start - b.start;
  });

  return results.slice(0, topK);
}
