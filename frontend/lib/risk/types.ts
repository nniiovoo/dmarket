export type Fact = Record<string, unknown>;

export type Condition =
  | { op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; path: string; value: number | string | boolean }
  | { op: "in" | "nin"; path: string; values: Array<number | string> }
  | { op: "and" | "or"; clauses: Condition[] }
  | { op: "not"; clause: Condition };

export type RuleAction =
  | { type: "block"; reason: string }
  | { type: "require_review"; reason: string }
  | { type: "require_second_confirm"; reason: string }
  | { type: "tag"; tag: string };

export interface Rule {
  id: string;
  description: string;
  when: Condition;
  then: RuleAction;
  priority: number;
  enabled?: boolean;
}

export interface EvalResult {
  ruleId: string;
  action: RuleAction;
  priority: number;
}
