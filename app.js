
"use strict";

// ========================================
// Knowledge AI - Main Engine
// Vanilla JavaScript / GitHub Pages
// ========================================

const CONFIG_URL = "./config.json";
const INDEX_URL = "./index.json";

const state = {
  config: null,
  index: null,
  cache: new Map(),
  busy: false
};

const $ = (id) => document.getElementById(id);

// ----------------------------------------
// 初期化
// ----------------------------------------

async function initialize() {
  try {
    const [configResponse, indexResponse] =
      await Promise.all([
        fetch(CONFIG_URL),
        fetch(INDEX_URL)
      ]);

    if (!configResponse.ok || !indexResponse.ok) {
      throw new Error("設定ファイルの読み込みに失敗しました");
    }

    state.config = await configResponse.json();
    state.index = await indexResponse.json();

    $("ai-name").textContent =
      state.config.ai_name || "Knowledge AI";

    $("ai-description").textContent =
      state.config.description || "AI Assistant";

    $("status").textContent = "オンライン";

  } catch (error) {
    console.error(error);
    $("status").textContent = "読み込みエラー";
    addMessage(
      "設定ファイルを読み込めませんでした。GitHub Pagesの公開設定とJSONのURLを確認してください。",
      "assistant"
    );
  }
}

// ----------------------------------------
// 文字列の正規化
// ----------------------------------------

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[、。！？,.!?「」『』（）()\[\]{}:：;]/g, " ")
    .trim();
}

// 日本語の連続文字にも対応するための簡易分割
function tokenize(text) {
  const normalized = normalize(text);

  const words = normalized
    .split(/\s+/)
    .filter(word => word.length > 0);

  const japanese = normalized.match(
    /[\u3040-\u30ff\u3400-\u9fff]+/g
  ) || [];

  const terms = [...words];

  for (const part of japanese) {
    terms.push(part);

    if (part.length >= 2) {
      for (let i = 0; i < part.length - 1; i++) {
        terms.push(part.slice(i, i + 2));
      }
    }
  }

  return [...new Set(terms)];
}

// ----------------------------------------
// 一致スコア計算
// ----------------------------------------

function calculateScore(question, knowledge) {
  const q = normalize(question);
  const questionTerms = tokenize(question);

  let score = 0;

  const fields = [
    { name: "keywords", weight: 10 },
    { name: "tags", weight: 5 },
    { name: "synonyms", weight: 7 }
  ];

  for (const field of fields) {
    const values = knowledge[field.name] || [];

    for (const value of values) {
      const term = normalize(value);

      if (!term) continue;

      // 質問文に完全な語句が含まれる
      if (q.includes(term)) {
        score += field.weight * 2;
        continue;
      }

      // 分割した語句との一致
      if (questionTerms.includes(term)) {
        score += field.weight;
      }
    }
  }

  // 質問文とタイトルの一致
  const title = normalize(knowledge.title || "");

  if (title && q.includes(title)) {
    score += 12;
  }

  return score;
}

// ----------------------------------------
// 目次から必要なJSONを選択
// ----------------------------------------

function findRelevantSources(question) {
  const sources = state.index.sources || [];

  return sources
    .map(source => {
      const routeData = {
        keywords: source.keywords || [],
        tags: source.tags || [],
        synonyms: source.synonyms || [],
        title: source.name || ""
      };

      return {
        ...source,
        score: calculateScore(question, routeData)
      };
    })
    .filter(source => source.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, state.config.max_sources || 5);
}

// ----------------------------------------
// JSONデータ取得（キャッシュ対応）
// ----------------------------------------

async function fetchKnowledge(source) {
  if (state.cache.has(source.url)) {
    return state.cache.get(source.url);
  }

  const response = await fetch(source.url);

  if (!response.ok) {
    throw new Error(
      `データ取得エラー: ${source.name}`
    );
  }

  const data = await response.json();

  if (!Array.isArray(data.knowledge)) {
    throw new Error(
      `JSON形式が不正です: ${source.name}`
    );
  }

  state.cache.set(source.url, data);

  return data;
}

// ----------------------------------------
// 知識検索
// ----------------------------------------

async function searchKnowledge(question) {
  const sources = findRelevantSources(question);

  if (sources.length === 0) {
    return [];
  }

  const results = await Promise.allSettled(
    sources.map(source => fetchKnowledge(source))
  );

  const candidates = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];

    if (result.status !== "fulfilled") {
      console.warn(
        "データ取得失敗:",
        sources[i].name,
        result.reason
      );
      continue;
    }

    const records = result.value.knowledge;

    for (const item of records) {
      const score = calculateScore(question, item);

      if (score > 0) {
        candidates.push({
          ...item,
          score,
          sourceName: sources[i].name
        });
      }
    }
  }

  return candidates.sort(
    (a, b) => b.score - a.score
  );
}

// ----------------------------------------
// 回答生成
// ----------------------------------------

function generateAnswer(question, results) {
  const config = state.config;

  if (results.length === 0) {
    return config.fallback_message ||
      "申し訳ありません。その質問に対応する知識はまだ登録されていません。";
  }

  const threshold = config.min_score || 1;

  const matched = results.filter(
    item => item.score >= threshold
  );

  if (matched.length === 0) {
    return config.fallback_message ||
      "関連する知識が見つかりませんでした。";
  }

  const best = matched[0];

  const template =
    config.response_template ||
    "{greeting}\n\n{content}\n\n{ending}";

  return template
    .replace("{greeting}", config.greeting || "")
    .replace("{name}", best.title || "")
    .replace("{content}", best.content || "")
    .replace("{ending}", config.ending || "")
    .replace("{question}", question);
}

// ----------------------------------------
// チャット表示
// ----------------------------------------

function addMessage(text, role) {
  const chat = $("chat");

  const message = document.createElement("div");
  message.className = `message ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent =
    role === "assistant" ? "AI" : "YOU";

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  // HTMLとして解釈させず安全に文字表示
  bubble.textContent = text;

  message.appendChild(avatar);
  message.appendChild(bubble);

  chat.appendChild(message);

  chat.scrollTop = chat.scrollHeight;
}

// ----------------------------------------
// 質問処理
// ----------------------------------------

async function handleQuestion(question) {
  if (state.busy) return;

  if (!state.config || !state.index) {
    addMessage(
      "システムがまだ初期化されていません。",
      "assistant"
    );
    return;
  }

  state.busy = true;

  $("loading").hidden = false;
  $("send").disabled = true;

  try {
    const results = await searchKnowledge(question);

    const answer = generateAnswer(
      question,
      results
    );

    addMessage(answer, "assistant");

    // 検索結果の根拠を表示
    if (results.length > 0) {
      const best = results[0];

      addMessage(
        `参照知識: ${best.title}\n` +
        `データ元: ${best.sourceName}\n` +
        `一致スコア: ${best.score}`,
        "assistant"
      );
    }

  } catch (error) {
    console.error(error);

    addMessage(
      "検索中にエラーが発生しました。JSONのURLや通信設定を確認してください。",
      "assistant"
    );

  } finally {
    state.busy = false;
    $("loading").hidden = true;
    $("send").disabled = false;
    $("question").focus();
  }
}

// ----------------------------------------
// イベント設定
// ----------------------------------------

$("chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  const input = $("question");
  const question = input.value.trim();

  if (!question || state.busy) return;

  addMessage(question, "user");

  input.value = "";
  input.style.height = "auto";

  await handleQuestion(question);
});

// Enterで送信、Shift + Enterで改行
$("question").addEventListener("keydown", event => {
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing
  ) {
    event.preventDefault();
    $("chat-form").requestSubmit();
  }
});

// テキスト入力に合わせて高さ調整
$("question").addEventListener("input", event => {
  const element = event.target;
  element.style.height = "auto";
  element.style.height =
    Math.min(element.scrollHeight, 140) + "px";
});

// 起動
initialize();
