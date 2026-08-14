// Input validation for the two POST routes that feed agent dispatch (THREATS.md
// S3 amplifiers): the roster (which grants tools) and the execute task graph
// (which chooses assignees and — via task ids — file/branch/worktree names).
// The request guard stops foreign origins; this stops malformed or hostile
// payloads from any source. Pure — trivially testable.

import { CONNECTOR_BY_ID } from '../state/connectors.js';
import type { RosterEntry } from '../state/types.js';
import type { RunCharter } from '../state/types.js';

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

// ─── Roster ──────────────────────────────────────────────────────────────────

const SENS_VALUES = new Set(['read', 'write', 'shell', 'network', 'sql']);
const MODE_VALUES = new Set(['allow', 'ask']);
const SQL_CATEGORIES = new Set(['read', 'write', 'delete', 'destructive']);
const MAX_ROSTER = 50;
const MAX_TOOLS = 40;
const MAX_TEXT = 20_000;

function fail<T>(error: string): Validation<T> {
  return { ok: false, error };
}

export function validateRosterPayload(raw: unknown): Validation<RosterEntry[]> {
  if (!Array.isArray(raw)) {
    return fail('roster must be an array');
  }
  if (raw.length > MAX_ROSTER) {
    return fail(`roster too large (max ${MAX_ROSTER} entries)`);
  }
  const seen = new Set<string>();
  for (const [i, e] of raw.entries()) {
    const at = `roster[${i}]`;
    if (!e || typeof e !== 'object') {
      return fail(`${at}: not an object`);
    }
    const entry = e as Record<string, unknown>;
    if (typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.id)) {
      return fail(`${at}: invalid id`);
    }
    if (seen.has(entry.id)) {
      return fail(`${at}: duplicate id "${entry.id}"`);
    }
    seen.add(entry.id);
    for (const key of ['name', 'prompt', 'instructions', 'model', 'version'] as const) {
      const v = entry[key];
      if (v !== undefined && (typeof v !== 'string' || v.length > MAX_TEXT)) {
        return fail(`${at}.${key}: must be a string under ${MAX_TEXT} chars`);
      }
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      return fail(`${at}.enabled: must be a boolean`);
    }
    const tools = entry.grantedTools ?? [];
    if (!Array.isArray(tools) || tools.length > MAX_TOOLS) {
      return fail(`${at}.grantedTools: must be an array (max ${MAX_TOOLS})`);
    }
    for (const t of tools) {
      const tool = t as Record<string, unknown>;
      if (!tool || typeof tool.name !== 'string') {
        return fail(`${at}.grantedTools: entry missing name`);
      }
      if (typeof tool.sens !== 'string' || !SENS_VALUES.has(tool.sens)) {
        return fail(`${at}.grantedTools."${tool.name}": unknown sens "${String(tool.sens)}"`);
      }
      if (tool.mode !== undefined && !MODE_VALUES.has(String(tool.mode))) {
        return fail(`${at}.grantedTools."${tool.name}": unknown mode "${String(tool.mode)}"`);
      }
      if (tool.sqlCategory !== undefined && !SQL_CATEGORIES.has(String(tool.sqlCategory))) {
        return fail(`${at}.grantedTools."${tool.name}": unknown sqlCategory`);
      }
    }
    const connectors = entry.grantedConnectors ?? [];
    if (!Array.isArray(connectors)) {
      return fail(`${at}.grantedConnectors: must be an array`);
    }
    for (const c of connectors) {
      const grant = c as Record<string, unknown>;
      const server = typeof grant?.server === 'string' ? grant.server : '';
      const connector = CONNECTOR_BY_ID[server];
      if (!connector) {
        return fail(`${at}.grantedConnectors: unknown connector "${server}"`);
      }
      if (!connector.tools.some(t => t.name === grant.tool)) {
        return fail(`${at}.grantedConnectors: unknown tool "${String(grant.tool)}" on "${server}"`);
      }
    }
  }
  return { ok: true, value: raw as RosterEntry[] };
}

// ─── Execute task graph ──────────────────────────────────────────────────────
// Task ids flow into branch names, worktree paths, and diff file paths — the
// charset here is the containment for all three. Dependencies must form a DAG
// over known ids or the loop's runnable computation stalls forever.

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ASSIGNEE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_TASKS = 50;
const MAX_TITLE = 2_000;

export function validateTaskGraph(raw: unknown): Validation<void> {
  if (raw === undefined) {
    return { ok: true, value: undefined }; // no PM graph — classifier builds one
  }
  if (!Array.isArray(raw)) {
    return fail('taskGraph must be an array');
  }
  if (raw.length > MAX_TASKS) {
    return fail(`taskGraph too large (max ${MAX_TASKS} tasks)`);
  }
  const ids = new Set<string>();
  for (const [i, e] of raw.entries()) {
    const at = `taskGraph[${i}]`;
    const entry = e as Record<string, unknown>;
    if (!entry || typeof entry !== 'object') {
      return fail(`${at}: not an object`);
    }
    if (typeof entry.id !== 'string' || !TASK_ID.test(entry.id)) {
      return fail(`${at}: invalid id (allowed: letters, digits, _ and -, max 64)`);
    }
    if (ids.has(entry.id)) {
      return fail(`${at}: duplicate id "${entry.id}"`);
    }
    ids.add(entry.id);
    if (typeof entry.assignee !== 'string' || !ASSIGNEE.test(entry.assignee)) {
      return fail(`${at}: invalid assignee`);
    }
    if (typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > MAX_TITLE) {
      return fail(`${at}: title required (max ${MAX_TITLE} chars)`);
    }
    if (entry.depends_on !== undefined && !Array.isArray(entry.depends_on)) {
      return fail(`${at}.depends_on: must be an array`);
    }
  }
  // Second pass: dependencies reference known ids, and the graph is acyclic.
  const deps = new Map<string, string[]>();
  for (const [i, e] of raw.entries()) {
    const entry = e as { id: string; depends_on?: unknown[] };
    const list = (entry.depends_on ?? []).map(String);
    for (const d of list) {
      if (!ids.has(d)) {
        return fail(`taskGraph[${i}]: depends_on references unknown id "${d}"`);
      }
    }
    deps.set(entry.id, list);
  }
  if (hasCycle(deps)) {
    return fail('taskGraph contains a dependency cycle');
  }
  return { ok: true, value: undefined };
}

function hasCycle(deps: Map<string, string[]>): boolean {
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): boolean => {
    const s = state.get(id);
    if (s === 'visiting') {
      return true;
    }
    if (s === 'done') {
      return false;
    }
    state.set(id, 'visiting');
    for (const d of deps.get(id) ?? []) {
      if (visit(d)) {
        return true;
      }
    }
    state.set(id, 'done');
    return false;
  };
  return [...deps.keys()].some(visit);
}

export function validateCharterGraph(charter: RunCharter | undefined): Validation<void> {
  return validateTaskGraph(charter?.taskGraph);
}
