(function () {
  "use strict";

  // 知識JSONに登録された事実とルールだけを使う推論エンジン

  function normalize(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[、。！？,.!?「」『』（）()\[\]{}:：;]/g, " ")
      .trim();
  }

  function includesAny(question, words) {
    return (words || []).some(word => {
      const normalized = normalize(word);
      return normalized.length > 0 && question.includes(normalized);
    });
  }

  function collectDefinitions(results) {
    const definitions = new Map();
    const rules = [];

    for (const item of results || []) {
      for (const fact of item.facts || []) {
        if (!fact || typeof fact.id !== "string") continue;

        const existing = definitions.get(fact.id) || {
          id: fact.id,
          keywords: [],
          negativeKeywords: [],
          label: fact.label || fact.id
        };

        existing.keywords.push(...(fact.keywords || []));
        existing.negativeKeywords.push(...(fact.negativeKeywords || []));

        if (fact.label) existing.label = fact.label;

        definitions.set(fact.id, existing);
      }

      for (const rule of item.rules || []) {
        if (rule && rule.if && rule.then) {
          rules.push(rule);
        }
      }
    }

    return { definitions, rules };
  }

  function extractFacts(question, definitions) {
    const q = normalize(question);
    const facts = new Map();

    for (const [id, def] of definitions) {
      const negative = includesAny(q, def.negativeKeywords || []);
      const positive = includesAny(q, def.keywords || []);

      if (negative && !positive) {
        facts.set(id, {
          value: false,
          source: "質問文",
          label: def.label
        });
      } else if (positive && !negative) {
        facts.set(id, {
          value: true,
          source: "質問文",
          label: def.label
        });
      }
    }

    return facts;
  }

  function evaluate(condition, facts) {
    if (!condition || typeof condition !== "object") {
      return false;
    }

    if (typeof condition.fact === "string") {
      return facts.has(condition.fact) &&
        facts.get(condition.fact).value === true;
    }

    if (condition.not && typeof condition.not.fact === "string") {
      return facts.has(condition.not.fact) &&
        facts.get(condition.not.fact).value === false;
    }

    if (Array.isArray(condition.all)) {
      return condition.all.length > 0 &&
        condition.all.every(part => evaluate(part, facts));
    }

    if (Array.isArray(condition.any)) {
      return condition.any.some(part => evaluate(part, facts));
    }

    return false;
  }

  function reason(question, results, options) {
    const maxSteps = (options && options.maxSteps) || 100;

    const { definitions, rules } = collectDefinitions(results);

    const facts = extractFacts(question, definitions);

    const trace = [];
    const firedRules = new Set();

    // 前向き推論
    let changed = true;
    let steps = 0;

    while (changed && steps < maxSteps) {
      changed = false;
      steps++;

      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i];
        const ruleId = rule.id || `rule-${i + 1}`;

        if (
          firedRules.has(ruleId) ||
          !evaluate(rule.if, facts)
        ) {
          continue;
        }

        const conclusion = rule.then;

        if (!conclusion || typeof conclusion.fact !== "string") {
          continue;
        }

        const value = conclusion.value !== false;
        const existing = facts.get(conclusion.fact);

        if (!existing) {
          const def = definitions.get(conclusion.fact);

          facts.set(conclusion.fact, {
            value,
            source: ruleId,
            label:
              (def && def.label) ||
              conclusion.label ||
              conclusion.fact
          });

          trace.push({
            rule: ruleId,
            explanation: rule.explanation || "",
            fact: conclusion.fact,
            value
          });

          firedRules.add(ruleId);
          changed = true;

        } else {
          firedRules.add(ruleId);

          if (existing.value !== value) {
            trace.push({
              rule: ruleId,
              explanation: rule.explanation || "",
              fact: conclusion.fact,
              value,
              conflict: true
            });
          }
        }
      }
    }

    const conflicts = trace.filter(step => step.conflict);
    const conclusions = [];

    for (const [id, fact] of facts) {
      if (fact.source !== "質問文") {
        conclusions.push({
          id,
          label: fact.label,
          value: fact.value,
          source: fact.source
        });
      }
    }

    return {
      available: rules.length > 0,

      facts: [...facts.entries()].map(([id, fact]) => ({
        id,
        ...fact
      })),

      conclusions,
      trace,
      conflicts,
      truncated: steps >= maxSteps
    };
  }

  function format(result) {
    if (!result.available) {
      return (
        "【論理推論】\n" +
        "この質問に適用できる論理ルールが知識JSONに登録されていません。"
      );
    }

    const lines = ["【論理推論】"];

    if (result.conclusions.length === 0) {
      lines.push(
        "登録されたルールから、新しい結論は導けませんでした。"
      );
    } else {
      lines.push("導かれた結論:");

      for (const item of result.conclusions) {
        lines.push(
          `・${item.label}: ${item.value ? "成立" : "不成立"}`
        );
      }
    }

    if (result.trace.length > 0) {
      lines.push("", "推論の根拠:");

      for (const step of result.trace) {
        lines.push(
          `・ルール「${step.rule}」` +
          `${step.explanation ? `: ${step.explanation}` : ""}`
        );
      }
    }

    if (result.conflicts.length > 0) {
      lines.push(
        "",
        "注意: 登録ルール同士で矛盾する結論が検出されました。"
      );
    }

    if (result.truncated) {
      lines.push(
        "注意: 推論ステップ数の上限に達しました。"
      );
    }

    return lines.join("\n");
  }

  window.LogicReasoner = {
    reason,
    format
  };

})();
