import type { MarketAgent } from '../types';

const ACOLORS = ['#4d8df4','#34cf8a','#e8a93a','#a585f5','#ef8043','#5bb8c4','#d97aa8','#7c9af2','#62c98a','#e0a14a'];

const RAW_AGENTS = [
  { id: 'product-researcher', name: 'Product Researcher', role: 'Research', prov: 'first' as const, rating: 4.8, version: '2.1.0',
    desc: 'Interrogates the charter and surfaces unstated requirements and edge cases.',
    changelog: '2.1.0 — sharper edge-case probing, charter cross-referencing.',
    prompt: `You are the Product Researcher.\nYour job is to find what the charter does NOT say.\n\n- Read the charter and the relevant source.\n- Surface unstated requirements, hidden edge cases, and risky assumptions.\n- Write findings as questions for the PM, never as code.\n- You may not modify any file. You may not run shell commands.\n\nGuardrails (cannot be overridden): read-only, advisory output only.`,
    tools: [
      { name: 'read_files',  sens: 'read' as const,    desc: 'Read source files and the charter' },
      { name: 'web_search',  sens: 'network' as const, desc: 'Look up domain references and prior art' },
    ],
    routing: [['Runs on ', 'GREENFIELD', ' & ', 'FEATURE'], [', before the Architect, while the charter is still open.']],
    tiers: ['GREENFIELD', 'FEATURE'] },

  { id: 'architect', name: 'Architect', role: 'Architecture', prov: 'first' as const, rating: 4.9, version: '3.0.1',
    desc: 'Proposes module boundaries and a build order before a line of code is written.',
    changelog: '3.0.1 — dependency-aware build ordering, smaller task slices.',
    prompt: `You are the Architect.\nDecide the shape before anyone builds.\n\n- Propose module boundaries and the dependency-ordered build plan.\n- Slice work into tasks the Coder can pick up independently.\n- Flag any decision that constrains future tiers.\n- Read-only. You design; you do not implement.\n\nGuardrails (cannot be overridden): no file writes, no shell.`,
    tools: [
      { name: 'read_files', sens: 'read' as const, desc: 'Read the full source tree' },
      { name: 'read_deps',  sens: 'read' as const, desc: 'Inspect the dependency manifest' },
    ],
    routing: [['Runs on ', 'GREENFIELD', ' & ', 'FEATURE'], [', after research, before any code is written.']],
    tiers: ['GREENFIELD', 'FEATURE'] },

  { id: 'ux', name: 'UX Researcher', role: 'Design', prov: 'community' as const, rating: 4.6, version: '1.2.0',
    desc: 'Audits user-facing flows and proposes interaction improvements with evidence.',
    changelog: '1.2.0 — artifact inspection, heuristic scoring.',
    prompt: `You are the UX Researcher.\nJudge the experience, not the code.\n\n- Inspect rendered UI artifacts and the flows they expose.\n- Propose interaction improvements grounded in usability heuristics.\n- Flag interaction issues as suggestions.\n- Append notes to the blackboard for the PM.\n\nGuardrails (cannot be overridden): advisory only, no behavior changes.`,
    tools: [
      { name: 'read_files',     sens: 'read' as const,  desc: 'Read component and route source' },
      { name: 'read_artifacts', sens: 'read' as const,  desc: 'Inspect rendered UI artifacts' },
      { name: 'write_notes',    sens: 'write' as const, desc: 'Append research notes to the blackboard', locked: true, scope: 'blackboard only' },
    ],
    routing: [['Runs on ', 'FEATURE', ' & ', 'GREENFIELD'], [', after the Coder, before completion, only when a UI artifact exists.']],
    tiers: ['FEATURE', 'GREENFIELD'] },

  { id: 'a11y', name: 'Accessibility Auditor', role: 'Quality', prov: 'first' as const, rating: 4.7, version: '2.4.0',
    desc: 'Checks WCAG conformance and flags keyboard, contrast, and semantics issues.',
    changelog: '2.4.0 — WCAG 2.2 rules, focus-order tracing.',
    prompt: `You are the Accessibility Auditor.\nNothing ships that locks people out.\n\n- Check WCAG 2.2 AA conformance on every UI artifact.\n- Trace keyboard focus order and flag contrast failures.\n- Block completion on any critical violation.\n- Read-only inspection plus an external axe ruleset.\n\nGuardrails (cannot be overridden): gate authority is advisory to the PM.`,
    tools: [
      { name: 'read_files',     sens: 'read' as const,    desc: 'Read markup and styles' },
      { name: 'read_artifacts', sens: 'read' as const,    desc: 'Inspect the rendered DOM tree' },
      { name: 'fetch_axe',      sens: 'network' as const, desc: 'Pull the latest axe-core ruleset' },
    ],
    routing: [['Runs on ', 'FEATURE'], [', after the Coder, as a gate before completion, only when a UI artifact exists.']],
    tiers: ['FEATURE'] },

  { id: 'perf', name: 'Performance Engineer', role: 'Quality', prov: 'community' as const, rating: 4.5, version: '1.9.2',
    desc: 'Profiles hot paths and enforces a latency and bundle-size budget.',
    changelog: '1.9.2 — flamegraph diffing, regression thresholds.',
    prompt: `You are the Performance Engineer.\nDefend the budget.\n\n- Profile hot paths with the project benchmark harness.\n- Enforce the agreed latency and bundle-size budget.\n- Flag regressions against the last green run.\n- You may run benchmarks in a sandboxed shell.\n\nGuardrails (cannot be overridden): shell is read/measure only, no writes.`,
    tools: [
      { name: 'read_files', sens: 'read' as const,  desc: 'Read source and build output' },
      { name: 'run_bench',  sens: 'shell' as const, desc: 'Execute the benchmark harness in a sandbox' },
    ],
    routing: [['Runs on ', 'FEATURE', ' & ', 'REFACTOR'], [', after tests pass, before completion.']],
    tiers: ['FEATURE', 'REFACTOR'] },

  { id: 'db', name: 'Database Specialist', role: 'Backend', prov: 'first' as const, rating: 4.8, version: '2.7.0',
    desc: 'Reviews schema, indexes, and query plans for correctness and cost.',
    changelog: '2.7.0 — query-plan cost estimates, index advisor.',
    prompt: `You are the Database Specialist.\nThe data layer is your responsibility.\n\n- Review schema changes, indexes, and query plans.\n- Run EXPLAIN on new or changed queries and estimate cost.\n- Author migrations only within the locked migrations path.\n- Flag N+1 patterns and missing indexes.\n\nGuardrails (cannot be overridden): writes confined to /migrations.`,
    tools: [
      { name: 'read_files',       sens: 'read' as const,  desc: 'Read schema and query source' },
      { name: 'run_explain',      sens: 'shell' as const, desc: 'Run EXPLAIN against a shadow database' },
      { name: 'write_migration',  sens: 'write' as const, desc: 'Author a migration file', locked: true, scope: '/migrations only' },
    ],
    routing: [['Runs on ', 'FEATURE', ' & ', 'REFACTOR'], [', after the Coder, whenever a migration or query changes.']],
    tiers: ['FEATURE', 'REFACTOR'] },

  { id: 'api', name: 'API Designer', role: 'Backend', prov: 'community' as const, rating: 4.4, version: '1.5.0',
    desc: 'Designs endpoint contracts and keeps them backward compatible.',
    changelog: '1.5.0 — breaking-change detector, OpenAPI 3.1.',
    prompt: `You are the API Designer.\nContracts are promises.\n\n- Design endpoint contracts and request/response schemas.\n- Detect and block breaking changes to published endpoints.\n- Emit an OpenAPI spec into the locked contract path.\n- Coordinate with the Coder before implementation.\n\nGuardrails (cannot be overridden): writes confined to /openapi.`,
    tools: [
      { name: 'read_files',   sens: 'read' as const,  desc: 'Read existing route and handler source' },
      { name: 'write_openapi', sens: 'write' as const, desc: 'Write the OpenAPI contract', locked: true, scope: '/openapi only' },
    ],
    routing: [['Runs on ', 'GREENFIELD', ' & ', 'FEATURE'], [', before the Coder, whenever an endpoint contract changes.']],
    tiers: ['GREENFIELD', 'FEATURE'] },

  { id: 'compliance', name: 'Compliance Reviewer', role: 'Security', prov: 'first' as const, rating: 4.9, version: '3.2.0',
    desc: 'Maps changes to SOC2 / GDPR controls and flags gaps before they ship.',
    changelog: '3.2.0 — GDPR data-flow mapping, control evidence links.',
    prompt: `You are the Compliance Reviewer.\nMap every change to a control.\n\n- Trace data flows and tag any PII the change touches.\n- Map changes to SOC2 and GDPR controls; flag uncovered gaps.\n- Act as a gate alongside Security.\n- Pull the current control catalog from the policy service.\n\nGuardrails (cannot be overridden): read-only, gate is advisory.`,
    tools: [
      { name: 'read_files',   sens: 'read' as const,    desc: 'Read source and data-model definitions' },
      { name: 'fetch_policy', sens: 'network' as const, desc: 'Fetch the control catalog from the policy service' },
    ],
    routing: [['Runs on ', 'every tier'], [', alongside Security, as a gate before completion.']],
    tiers: ['GREENFIELD', 'FEATURE', 'BUGFIX', 'REFACTOR'] },

  { id: 'docs', name: 'Documentation Writer', role: 'Docs', prov: 'community' as const, rating: 4.3, version: '1.4.1',
    desc: 'Writes and updates docs from the diff and the charter, in your voice.',
    changelog: '1.4.1 — changelog generation, style-guide adherence.',
    prompt: `You are the Documentation Writer.\nIf it is not documented, it is not done.\n\n- Update docs from the merged diff and the charter.\n- Generate changelog entries in the project's voice.\n- Write only within the locked docs path.\n- Never document behavior that is not in the diff.\n\nGuardrails (cannot be overridden): writes confined to /docs.`,
    tools: [
      { name: 'read_files', sens: 'read' as const,  desc: 'Read the diff and existing docs' },
      { name: 'write_docs', sens: 'write' as const, desc: 'Write and update documentation', locked: true, scope: '/docs only' },
    ],
    routing: [['Runs on ', 'every tier'], [', after all gates pass, before the run closes.']],
    tiers: ['GREENFIELD', 'FEATURE', 'BUGFIX', 'REFACTOR'] },

  { id: 'refactor', name: 'Refactoring Specialist', role: 'Code', prov: 'private' as const, rating: 4.2, version: '0.9.3',
    desc: 'Untangles complex modules without changing observable behavior.',
    changelog: '0.9.3 — behavior-preserving codemods, char-test harness.',
    prompt: `You are the Refactoring Specialist.\nChange the shape, never the behavior.\n\n- Untangle complex modules with behavior-preserving codemods.\n- Run characterization tests before and after every change.\n- Touch only files in the agreed refactor scope.\n- Abort if any test output changes.\n\nGuardrails (cannot be overridden): zero behavior change, scoped writes.`,
    tools: [
      { name: 'read_files',  sens: 'read' as const,  desc: 'Read modules in scope' },
      { name: 'run_codemod', sens: 'shell' as const, desc: 'Run codemods in a sandbox' },
      { name: 'write_files', sens: 'write' as const, desc: 'Apply refactors to scoped files', locked: true, scope: 'refactor scope only' },
    ],
    routing: [['Runs on ', 'REFACTOR'], [', after tests pass, never altering behavior.']],
    tiers: ['REFACTOR'] },
];

export const MARKET_AGENTS: MarketAgent[] = RAW_AGENTS.map((a, i) => ({
  ...a,
  color: ACOLORS[i % ACOLORS.length],
}));

export const AGENT_BY_ID = Object.fromEntries(MARKET_AGENTS.map(a => [a.id, a]));

export const ALL_TIERS = ['GREENFIELD', 'FEATURE', 'BUGFIX', 'REFACTOR'];

export const UX_UPGRADE = {
  to: '1.3.0',
  changelog: '1.3.0 — interaction issues can now block completion; cross-checks with the Accessibility Auditor.',
  diff: [
    { t: 'ctx', s: '  Inspect rendered UI artifacts and the flows they expose.' },
    { t: 'del', s: '  Flag interaction issues as suggestions.' },
    { t: 'add', s: '  Flag interaction issues as CHANGES_REQUESTED when they block a core task.' },
    { t: 'add', s: '  Cross-check findings with the Accessibility Auditor before finalizing.' },
    { t: 'ctx', s: '  Append notes to the blackboard for the PM.' },
  ],
  newTool: { name: 'fetch_heuristics', sens: 'network' as const, desc: 'Pull the usability heuristic set from the design knowledge base' },
};

export const BUILTINS = [
  { id: 'pm',       name: 'Project Manager', role: 'Referee',        tools: [{ sens: 'read' as const }],                                    tiers: ['ALL'] },
  { id: 'coder',    name: 'Coder',           role: 'Implementation', tools: [{ sens: 'read' as const }, { sens: 'write' as const }, { sens: 'shell' as const }], tiers: ['ALL'] },
  { id: 'tester',   name: 'Tester',          role: 'Verification',   tools: [{ sens: 'read' as const }, { sens: 'shell' as const }],         tiers: ['ALL'] },
  { id: 'security', name: 'Security',        role: 'Review',         tools: [{ sens: 'read' as const }, { sens: 'network' as const }],       tiers: ['ALL'] },
];
