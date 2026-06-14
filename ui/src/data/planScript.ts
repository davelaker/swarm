export type PlanStep =
  | { d: number; type: 'msg'; from: string; text: string }
  | { d: number; type: 'charter'; field: string; value: string }
  | { d: number; type: 'list'; field: string; value: string }
  | { d: number; type: 'q'; value: string }
  | { d: number; type: 'resolve'; value: string }
  | { d: number; type: 'team'; value: string }
  | { d: number; type: 'enable' };

export const PLAN_SCRIPT: PlanStep[] = [
  {
    d: 500,
    type: 'msg',
    from: 'pm',
    text: 'Before I staff anything — what are you actually trying to build?',
  },
  {
    d: 1500,
    type: 'msg',
    from: 'you',
    text: 'Add a /leaderboard command to my Discord bot that ranks players by season.',
  },
  {
    d: 700,
    type: 'charter',
    field: 'goal',
    value: 'Add a /leaderboard slash command that ranks players by season.',
  },
  {
    d: 900,
    type: 'msg',
    from: 'pm',
    text: 'Where does the ranking data live — the same Postgres the bot already uses?',
  },
  { d: 1400, type: 'msg', from: 'you', text: "Yeah. There's a `matches` table I can read from." },
  {
    d: 650,
    type: 'list',
    field: 'constraints',
    value: 'Reads from the existing Postgres `matches` table',
  },
  {
    d: 850,
    type: 'msg',
    from: 'pm',
    text: 'Roughly how many players on a busy server? That decides pagination.',
  },
  { d: 1300, type: 'msg', from: 'you', text: 'A few thousand on the big ones.' },
  { d: 800, type: 'msg', from: 'pm', text: 'Then we cap to the top 100 and paginate. Noting it.' },
  { d: 600, type: 'list', field: 'constraints', value: 'Cap to top 100 results, paginated' },
  {
    d: 950,
    type: 'msg',
    from: 'security',
    text: '[Security consulted] Season filter takes raw user input — SQL injection risk on the query path.',
  },
  {
    d: 850,
    type: 'msg',
    from: 'pm',
    text: "Security's right. The season filter gets parameterized — non-negotiable, and it becomes a gate.",
  },
  {
    d: 600,
    type: 'list',
    field: 'constraints',
    value: 'Season filter must be parameterized — no string interpolation',
  },
  { d: 550, type: 'list', field: 'nongoals', value: 'No write access to match data' },
  {
    d: 550,
    type: 'list',
    field: 'nongoals',
    value: 'No new ranking math — reuse the existing Elo',
  },
  { d: 700, type: 'q', value: 'Should tied players share a rank?' },
  { d: 1300, type: 'msg', from: 'you', text: "Ties can share a rank, that's fine." },
  { d: 650, type: 'resolve', value: 'yes — tied players share a rank' },
  {
    d: 900,
    type: 'msg',
    from: 'pm',
    text: "Good. I'd staff this with a Coder, a Tester, and a Security reviewer.",
  },
  { d: 450, type: 'team', value: 'coder' },
  { d: 400, type: 'team', value: 'tester' },
  { d: 400, type: 'team', value: 'security' },
  {
    d: 650,
    type: 'msg',
    from: 'pm',
    text: "Charter's ready. Hit Execute when you want the swarm to start.",
  },
  { d: 300, type: 'enable' },
];
