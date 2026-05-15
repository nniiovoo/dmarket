import type { Condition, EvalResult, Fact, Rule } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getByPath(obj: unknown, path: string): any {
  const segments = path.split(".");
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function evalCondition(facts: Fact, cond: Condition): boolean {
  switch (cond.op) {
    case "and": {
      for (const clause of cond.clauses) {
        if (!evalCondition(facts, clause)) return false; // short-circuit
      }
      return true;
    }
    case "or": {
      for (const clause of cond.clauses) {
        if (evalCondition(facts, clause)) return true; // short-circuit
      }
      return false;
    }
    case "not":
      return !evalCondition(facts, cond.clause);
    case "in": {
      const v = getByPath(facts, cond.path);
      return cond.values.includes(v as number | string);
    }
    case "nin": {
      const v = getByPath(facts, cond.path);
      return !cond.values.includes(v as number | string);
    }
    default: {
      const val = getByPath(facts, cond.path);
      if (val === undefined || val === null) return false;
      switch (cond.op) {
        case "eq":  return val === cond.value;
        case "ne":  return val !== cond.value;
        case "gt":  return (val as number) > (cond.value as number);
        case "gte": return (val as number) >= (cond.value as number);
        case "lt":  return (val as number) < (cond.value as number);
        case "lte": return (val as number) <= (cond.value as number);
      }
    }
  }
}

export function evaluate(facts: Fact, rules: Rule[]): EvalResult[] {
  const results: EvalResult[] = [];
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    if (evalCondition(facts, rule.when)) {
      results.push({ ruleId: rule.id, action: rule.then, priority: rule.priority });
    }
  }
  results.sort((a, b) => b.priority - a.priority);
  return results;
}
