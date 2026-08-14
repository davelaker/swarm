// Lightweight marketplace catalog for the PM (planning side).
// Metadata only — id, name, role, one-line description — NOT the full system prompts
// (those live in the UI catalogue and, once hired, in .swarm/roster.json). The PM uses
// this to know which specialists EXIST and what they do, so it can route research to a
// hired one or recommend hiring one that would materially help.
//
// Keep in sync with ui/src/data/marketAgents.ts (the source of truth for the storefront).

export interface CatalogAgent {
  id: string;
  name: string;
  role: string;
  desc: string;
}

export const MARKETPLACE_CATALOG: CatalogAgent[] = [
  {
    id: 'product-researcher',
    name: 'Product Researcher',
    role: 'Research',
    desc: 'Interrogates the charter and surfaces unstated requirements and edge cases.',
  },
  {
    id: 'architect',
    name: 'Architect',
    role: 'Architecture',
    desc: 'Proposes module boundaries and a build order before a line of code is written.',
  },
  {
    id: 'ux',
    name: 'UX Researcher',
    role: 'Design',
    desc: 'Audits user-facing flows and proposes interaction improvements with evidence.',
  },
  {
    id: 'a11y',
    name: 'Accessibility Auditor',
    role: 'Quality',
    desc: 'Checks WCAG conformance and flags keyboard, contrast, and semantics issues.',
  },
  {
    id: 'perf',
    name: 'Performance Engineer',
    role: 'Quality',
    desc: 'Profiles hot paths and enforces a latency and bundle-size budget.',
  },
  {
    id: 'db',
    name: 'Database Specialist',
    role: 'Backend',
    desc: 'Reviews schema, indexes, query plans, and data-access patterns; can query a live DB if granted.',
  },
  {
    id: 'api',
    name: 'API Designer',
    role: 'Backend',
    desc: 'Designs endpoint contracts and keeps them backward compatible.',
  },
  {
    id: 'compliance',
    name: 'Compliance Reviewer',
    role: 'Security',
    desc: 'Maps changes to SOC2 / GDPR controls and flags gaps before they ship.',
  },
  {
    id: 'docs',
    name: 'Documentation Writer',
    role: 'Docs',
    desc: 'Commissioned documentation — guides, changelogs, API references. (The built-in scribe handles routine post-run doc truth-keeping.)',
  },
  {
    id: 'refactor',
    name: 'Refactoring Specialist',
    role: 'Code',
    desc: 'Untangles complex modules without changing observable behavior.',
  },
];

export const CATALOG_BY_ID: Record<string, CatalogAgent> = Object.fromEntries(
  MARKETPLACE_CATALOG.map(a => [a.id, a]),
);

// Renders the catalogue for the PM prompt, marking which agents are already hired
// for this project. `hiredIds` comes from the roster.
export function formatMarketplace(hiredIds: string[]): string {
  const hired = new Set(hiredIds);
  const lines = MARKETPLACE_CATALOG.map(
    a =>
      `  [${a.id}] ${a.name} (${a.role}) — ${a.desc}${hired.has(a.id) ? '  ✓ HIRED' : '  ○ not hired'}`,
  );
  return `Marketplace specialists (the full catalogue; ✓ HIRED = already on this project's team, available to assign):\n${lines.join('\n')}`;
}
