```javascript
"use strict";

// ==========================================
// Knowledge AI v2.2
// Improved Knowledge Search
// JSON + JSONL Edition
// ==========================================

const CONFIG_URL = "./config.json";
const INDEX_URL = "./index.json";

const state = {
  config: null,
  index: null,
  cache: new Map(),
  busy: false
};

const $ = id => document.getElementById(id);

// ==========================================
// 1. JSON取得
// ==========================================

async function fetchJSON(url) {
  const config = state.config || {};
  const timeout = config.request_timeout || 10000;
  const retries = config.retry_count ?? 2;

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      timeout
    );

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { "Accept": "application/json" },
        cache: "no-cache",
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${url}`);
      }

      const data = await response.json();

      if (
        data === null ||
        typeof data !== "object" ||
        Array.isArray(data)
      ) {
        throw new Error("JSON形式が不正です: " + url);
      }

      return data;

    } catch (error) {
      lastError = error;

      if (attempt < retries) {
        await new Promise(resolve =>
          setTimeout(resolve, 500 * (attempt + 1))
        );
      }

    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

// ==========================================
// 2. 初期化
// ==========================================

async function initialize() {
  try {
    const [config, index] = await Promise.all([
      fetchJSON(CONFIG_URL),
      fetchJSON(INDEX_URL)
    ]);

    if (!Array.isArray(index.sources)) {
      throw new Error("index.jsonのsourcesが不正です");
    }

    state.config = config;
    state.index = index;

    $("ai-name").textContent =
      config.ai_name || "Knowledge AI";

    $("ai-description").textContent =
      config.description || "知識ベースAI";

    $("status").textContent = "オンライン";
    $("status").classList.remove("error");

  } catch (error) {
    console.error("初期化エラー:", error);

    $("status").textContent = "接続エラー";
    $("status").classList.add("error");

    addMessage(
      "設定ファイルまたは目次を読み込めませんでした。\n" +
      error.message,
      "assistant"
    );
  }
}

// ==========================================
// 3. 日本語文字列処理
// ==========================================

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[、。！？,.!?「」『』（）()\[\]{}:：;]/g, " ")
    .trim();
}

function tokenize(text) {
  const normalized = normalize(text);

  const terms = normalized
    .split(/\s+/)
    .filter(Boolean);

  const japanese = normalized.match(
    /[\u3040-\u30ff\u3400-\u9fff]+/g
  ) || [];

  for (const part of japanese) {
    terms.push(part);

    for (let i = 0; i < part.length - 1; i++) {
      terms.push(part.slice(i, i + 2));
    }
  }

  return [...new Set(terms)];
}

// ==========================================
// 4. 検索用テキストの作成
// ==========================================

function getSearchText(item) {
  const values = [
    item.title,
    item.content,
    ...(item.keywords || []),
    ...(item.synonyms || []),
    ...(item.tags || [])
  ];

  for (const fact of item.facts || []) {
    values.push(fact.label);

    if (Array.isArray(fact.keywords)) {
      values.push(...fact.keywords);
    }

    if (Array.isArray(fact.negativeKeywords)) {
      values.push(...fact.negativeKeywords);
    }
  }

  return normalize(values.filter(Boolean).join(" "));
}

// ==========================================
// 5. スコアリング
// ==========================================

function calculateScore(question, item) {
  const q = normalize(question);
  const terms = tokenize(question);
  const searchText = getSearchText(item);

  let score = 0;

  const fields = [
    ["keywords", 10],
    ["synonyms", 7],
    ["tags", 5]
  ];

  for (const [field, weight] of fields) {
    const values = [...(item[field] || [])];

    if (field === "keywords") {
      for (const fact of item.facts || []) {
        values.push(...(fact.keywords || []));
      }
    }

    for (const value of values) {
      const word = normalize(value);
      if (!word) continue;

      if (q.includes(word)) {
        score += weight * 2;
      } else if (terms.includes(word)) {
        score += weight;
      }
    }
  }

  const title = normalize(item.title || "");

  if (title && q.includes(title)) {
    score += 12;
  }

  // タイトル・本文・factsの語句も検索する
  const matchedTerms = terms.filter(term =>
    term.length >= 2 && searchText.includes(term)
  );

  score += matchedTerms.length * 2;

  // 日本語の短い語句にも対応
  if (score === 0) {
    const questionParts = q.match(
      /[\u3040-\u30ff\u3400-\u9fff]{2,}/g
    ) || [];

    for (const part of questionParts) {
      if (searchText.includes(part)) {
        score += 3;
      }
    }
  }

  return score;
}

// ==========================================
// 6. 知識ファイルの選択
// ==========================================

function findRelevantSources(question) {
  const sources = state.index.sources;

  const ranked = sources
    .map(source => ({
      ...source,
      score: calculateScore(question, {
        title: source.name,
        keywords: source.keywords,
        tags: source.tags,
        synonyms: source.synonyms
      })
    }))
    .sort((a, b) => b.score - a.score);

  const maxSources = state.config.max_sources || 5;

  // 一致するファイルがなくても検索を中止しない
  const selected = ranked.filter(source => source.score > 0);

  if (selected.length === 0) {
    return ranked.slice(0, maxSources);
  }

  return selected.slice(0, maxSources);
}

// ==========================================
// 7. JSON / JSONL知識ファイル取得
// ==========================================

async function loadKnowledge(source) {
  const url = new URL(
    source.path,
    document.baseURI
  ).href;

  if (
    state.config.cache_enabled &&
    state.cache.has(url)
  ) {
    return state.cache.get(url);
  }

  let data;

  if (source.path.toLowerCase().endsWith(".jsonl")) {
    const response = await fetch(url, {
      method: "GET",
      headers: { "Accept": "text/plain" },
      cache: "no-cache"
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${url}`);
    }

    const text = await response.text();
    const knowledge = [];
    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      let item;

      try {
        item = JSON.parse(line);
      } catch (error) {
        throw new Error(
          `JSONLの${i + 1}行目が不正です: ${error.message}`
        );
      }

      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        typeof item.title !== "string" ||
        typeof item.content !== "string"
      ) {
        throw new Error(
          `JSONLの${i + 1}行目の形式が不正です`
        );
      }

      knowledge.push(item);
    }

    data = { knowledge };

  } else {
    data = await fetchJSON(url);

    if (!Array.isArray(data.knowledge)) {
      throw new Error(
        "knowledge配列が存在しません: " + source.name
      );
    }

    for (const item of data.knowledge) {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.title !== "string" ||
        typeof item.content !== "string"
      ) {
        throw new Error(
          "知識データの形式が不正です: " + source.name
        );
      }
    }
  }

  if (state.config.cache_enabled) {
    state.cache.set(url, data);
  }

  return data;
}

// ==========================================
// 8. 知識検索
// ==========================================

async function searchKnowledge(question) {
  // 関連度の高いファイルを優先する
  // 一致しない場合もファイルを検索する
  const sources = findRelevantSources(question);

  const responses = await Promise.allSettled(
    sources.map(source => loadKnowledge(source))
  );

  const candidates = [];
  const errors = [];

  for (let i = 0; i < responses.length; i++) {
    const result = responses[i];

    if (result.status === "rejected") {
      errors.push(sources[i].name);

      console.warn(
        "知識ファイル取得失敗:",
        sources[i].name,
        result.reason
      );

      continue;
    }

    for (const item of result.value.knowledge) {
      const score = calculateScore(question, item);

      candidates.push({
        ...item,
        score,
        sourceName: sources[i].name
      });
    }
  }

  // 高得点順に並べる
  candidates.sort((a, b) => b.score - a.score);

  // 一致した知識を優先する
  const matched = candidates.filter(item => item.score > 0);

  const results = (
    matched.length > 0 ? matched : []
  ).slice(0, state.config.max_results || 10);

  return {
    results,
    errors,
    totalLoaded: candidates.length
  };
}

// ==========================================
// 9. 回答生成
// ==========================================

function generateAnswer(question, results) {
  const config = state.config;
  const threshold = config.min_score ?? 1;

  const matched = results.filter(
    item => item.score >= threshold
  );

  if (matched.length === 0) {
    return config.fallback_message ||
      "関連する知識が見つかりませんでした。";
  }

  const contents = matched.map(item =>
    `【${item.title}】\n${item.content}`
  );

  const combinedContent = contents.join("\n\n");

  const template =
    config.response_template ||
    "{greeting}\n\n{content}\n\n{ending}";

  return template
    .replace("{greeting}", config.greeting || "")
    .replace("{content}", combinedContent)
    .replace("{ending}", config.ending || "")
    .replace("{question}", question);
}

// ==========================================
// 10. チャット表示
// ==========================================

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
  bubble.textContent = text;

  message.appendChild(avatar);
  message.appendChild(bubble);

  chat.appendChild(message);
  chat.scrollTop = chat.scrollHeight;
}

// ==========================================
// 11. 質問処理・論理推論
// ==========================================

async function handleQuestion(question) {
  if (state.busy) return;

  if (!state.config || !state.index) {
    addMessage(
      "システムが初期化されていません。",
      "assistant"
    );
    return;
  }

  state.busy = true;

  $("loading").hidden = false;
  $("send").disabled = true;

  try {
    const search = await searchKnowledge(question);

    const answer = generateAnswer(
      question,
      search.results
    );

    let reasoning = null;

    if (window.LogicReasoner) {
      reasoning = window.LogicReasoner.reason(
        question,
        search.results
      );
    }

    let finalAnswer = answer;

    if (reasoning) {
      finalAnswer += "\n\n" +
        window.LogicReasoner.format(reasoning);
    }

    addMessage(finalAnswer, "assistant");

    if (search.results.length > 0) {
      const references = search.results
        .map(item =>
          `・${item.title}（${item.sourceName} / ${item.score}点）`
        )
        .join("\n");

      addMessage(
        "【検索した知識】\n" + references,
        "assistant"
      );
    }

    if (search.errors.length > 0) {
      addMessage(
        "【通信上の注意】\n" +
        "一部の知識ファイルを取得できませんでした:\n" +
        search.errors.join(", "),
        "assistant"
      );
    }

    if (
      search.results.length === 0 &&
      search.errors.length === 0
    ) {
      addMessage(
        "知識ファイルは読み込めましたが、質問に関連する知識が見つかりませんでした。",
        "assistant"
      );
    }

  } catch (error) {
    console.error("検索エラー:", error);

    addMessage(
      "検索中にエラーが発生しました。\n" +
      error.message,
      "assistant"
    );

  } finally {
    state.busy = false;
    $("loading").hidden = true;
    $("send").disabled = false;
    $("question").focus();
  }
}

// ==========================================
// 12. イベント設定
// ==========================================

$("chat-form").addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    const input = $("question");
    const question = input.value.trim();

    if (!question || state.busy) return;

    addMessage(question, "user");

    input.value = "";
    input.style.height = "auto";

    await handleQuestion(question);
  }
);

// Enterで送信 / Shift + Enterで改行

$("question").addEventListener(
  "keydown",
  event => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing
    ) {
      event.preventDefault();
      $("chat-form").requestSubmit();
    }
  }
);

// 入力欄の高さ自動調整

$("question").addEventListener(
  "input",
  event => {
    const element = event.target;

    element.style.height = "auto";
    element.style.height =
      Math.min(element.scrollHeight, 140) + "px";
  }
);

// ==========================================
// 13. 起動
// ==========================================

initialize();
```
