// Delivery-rules evaluator — shared by inbound.ts (apply at delivery) and
// rules.ts (validation). Missing-table tolerant: fetchActiveRules returns []
// until migrations/email-rules.sql has been applied. Mail delivery must
// never fail because of a rule.

import { Env, supabaseQuery } from "./_shared";

export type RuleField = "from" | "to" | "subject";
export type RuleOp = "contains" | "equals" | "ends_with";
export type RuleActionType = "move_folder" | "mark_read" | "flag" | "junk" | "trash";

export interface RuleCondition {
  field: RuleField;
  op: RuleOp;
  value: string;
}

export interface RuleAction {
  type: RuleActionType;
  folder?: "inbox" | "archive";
}

export interface EmailRule {
  id: string;
  name: string;
  is_active: boolean;
  priority: number;
  match_type: "all" | "any";
  conditions: RuleCondition[];
  actions: RuleAction[];
  domain_id: string | null;
}

// The mutable delivery state a rules pass operates on. Field semantics
// mirror how the app's PATCH endpoint moves messages: archive/trash are
// flags, junk = is_spam + folder "spam", inbox rescue clears all three.
export interface DeliveryState {
  folder: string;
  is_read: boolean;
  is_starred: boolean;
  is_spam: boolean;
  is_trash: boolean;
  is_archived: boolean;
}

export async function fetchActiveRules(env: Env): Promise<EmailRule[]> {
  try {
    const res = await supabaseQuery(
      env,
      "/email_rules?is_active=eq.true&order=priority.asc,created_at.asc"
    );
    if (!res.ok || !Array.isArray(res.data)) return [];
    return res.data as EmailRule[];
  } catch {
    return [];
  }
}

export interface RuleMessage {
  from: string; // lowercased from_address
  to: string[]; // lowercased recipients
  subject: string;
}

function testCondition(cond: RuleCondition, msg: RuleMessage): boolean {
  const value = (cond.value || "").toLowerCase().trim();
  if (!value) return false;
  const test = (target: string) => {
    switch (cond.op) {
      case "contains":
        return target.includes(value);
      case "equals":
        return target === value;
      case "ends_with":
        return target.endsWith(value);
      default:
        return false;
    }
  };
  switch (cond.field) {
    case "from":
      return test(msg.from);
    case "to":
      return msg.to.some(test);
    case "subject":
      return test(msg.subject.toLowerCase());
    default:
      return false;
  }
}

export function evaluateRule(rule: EmailRule, msg: RuleMessage): boolean {
  const conds = Array.isArray(rule.conditions) ? rule.conditions : [];
  if (conds.length === 0) return false; // empty conditions never match
  return rule.match_type === "any" ? conds.some((c) => testCondition(c, msg)) : conds.every((c) => testCondition(c, msg));
}

function applyAction(action: RuleAction, state: DeliveryState) {
  switch (action.type) {
    case "move_folder":
      if (action.folder === "inbox") {
        // Explicit inbox rule rescues from the spam verdict too
        state.folder = "inbox";
        state.is_spam = false;
        state.is_archived = false;
        state.is_trash = false;
      } else if (action.folder === "archive") {
        state.is_archived = true; // archive is a flag; folder untouched
      }
      break;
    case "mark_read":
      state.is_read = true;
      break;
    case "flag":
      state.is_starred = true;
      break;
    case "junk":
      state.is_spam = true;
      state.folder = "spam";
      break;
    case "trash":
      state.is_trash = true; // trash is a flag; folder untouched
      break;
  }
}

/** Apply every matching rule in priority order — later rules win on
 *  conflicts (sequential mutation gives last-writer-wins for free). */
export function applyRuleActions(rules: EmailRule[], msg: RuleMessage, state: DeliveryState): string[] {
  const firedRules: string[] = [];
  for (const rule of rules) {
    try {
      if (!evaluateRule(rule, msg)) continue;
      firedRules.push(rule.name);
      const actions = Array.isArray(rule.actions) ? rule.actions : [];
      for (const action of actions) applyAction(action, state);
    } catch {
      // A malformed rule must never break delivery
    }
  }
  return firedRules;
}
