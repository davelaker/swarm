// Frontend connector registry — mirrors core/src/state/connectors.ts.
// Server IDs are the human-readable prefixes used by claude -p subprocesses (e.g. 'claude_ai_Supabase').

export type ConnectorSens = 'mcp-read' | 'mcp-write';

export interface ConnectorToolDef {
  name: string;
  desc: string;
  sens: ConnectorSens;
  defaultOn: boolean;
}

export interface ConnectorDef {
  id: string;
  name: string;
  serverId: string;
  probeTool: string;
  tools: ConnectorToolDef[];
}

export const CONNECTOR_REGISTRY: ConnectorDef[] = [
  {
    id: 'supabase',
    name: 'Supabase',
    serverId: 'claude_ai_Supabase',
    probeTool: 'list_organizations',
    tools: [
      {
        name: 'list_tables',
        desc: 'List all tables in the database',
        sens: 'mcp-read',
        defaultOn: true,
      },
      {
        name: 'get_advisors',
        desc: 'Get schema performance recommendations',
        sens: 'mcp-read',
        defaultOn: true,
      },
      {
        name: 'list_extensions',
        desc: 'List installed Postgres extensions',
        sens: 'mcp-read',
        defaultOn: true,
      },
      {
        name: 'list_migrations',
        desc: 'List applied and pending migrations',
        sens: 'mcp-read',
        defaultOn: true,
      },
      {
        name: 'list_projects',
        desc: 'List all Supabase projects',
        sens: 'mcp-read',
        defaultOn: true,
      },
      {
        name: 'generate_typescript_types',
        desc: 'Generate TypeScript types from schema',
        sens: 'mcp-read',
        defaultOn: true,
      },
      {
        name: 'execute_sql',
        desc: 'Run arbitrary SQL queries',
        sens: 'mcp-write',
        defaultOn: false,
      },
      {
        name: 'apply_migration',
        desc: 'Apply a schema migration to the database',
        sens: 'mcp-write',
        defaultOn: false,
      },
    ],
  },
  {
    id: 'vercel',
    name: 'Vercel',
    serverId: 'claude_ai_Vercel',
    probeTool: 'list_teams',
    tools: [
      {
        name: 'list_projects',
        desc: 'List all Vercel projects',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'list_deployments',
        desc: 'List recent deployments',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'get_deployment',
        desc: 'Get deployment details and status',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'get_runtime_logs',
        desc: 'Fetch runtime logs from a deployment',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'get_deployment_build_logs',
        desc: 'Fetch build logs from a deployment',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'deploy_to_vercel',
        desc: 'Trigger a new deployment',
        sens: 'mcp-write',
        defaultOn: false,
      },
    ],
  },
  {
    id: 'sentry',
    name: 'Sentry',
    serverId: 'claude_ai_Sentry',
    probeTool: 'find_organizations',
    tools: [
      {
        name: 'find_organizations',
        desc: 'List Sentry organizations',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'find_projects',
        desc: 'List projects in the organization',
        sens: 'mcp-read',
        defaultOn: true,
      },
      {
        name: 'search_issues',
        desc: 'Search for errors and issues',
        sens: 'mcp-read',
        defaultOn: true,
      },
      {
        name: 'get_issue_details',
        desc: 'Get full detail and stack trace for an issue',
        sens: 'mcp-read',
        defaultOn: true,
      },
      {
        name: 'analyze_issue_with_seer',
        desc: 'AI-powered root-cause analysis of an issue',
        sens: 'mcp-read',
        defaultOn: true,
      },
      {
        name: 'search_error_events',
        desc: 'Search raw error events',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'get_trace_details',
        desc: 'Get distributed trace and performance data',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'find_releases',
        desc: 'List releases and their associated issues',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'update_issue',
        desc: 'Resolve, ignore, or assign an issue',
        sens: 'mcp-write',
        defaultOn: false,
      },
    ],
  },
  {
    id: 'github',
    name: 'GitHub',
    serverId: 'claude_ai_GitHub',
    probeTool: 'search_repositories',
    tools: [
      {
        name: 'search_repositories',
        desc: 'Search for repositories',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'get_file_contents',
        desc: 'Read file contents from a repository',
        sens: 'mcp-read',
        defaultOn: true,
      },
      {
        name: 'search_code',
        desc: 'Search code across repositories',
        sens: 'mcp-read',
        defaultOn: true,
      },
      {
        name: 'list_commits',
        desc: 'List commits for a branch or file path',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'list_issues',
        desc: 'List issues in a repository',
        sens: 'mcp-read',
        defaultOn: true,
      },
      {
        name: 'get_issue',
        desc: 'Get details and comments for an issue',
        sens: 'mcp-read',
        defaultOn: true,
      },
      {
        name: 'list_pull_requests',
        desc: 'List pull requests in a repository',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'get_pull_request',
        desc: 'Get details and diff of a pull request',
        sens: 'mcp-read',
        defaultOn: false,
      },
      { name: 'create_issue', desc: 'Open a new issue', sens: 'mcp-write', defaultOn: false },
      {
        name: 'create_pull_request',
        desc: 'Open a pull request',
        sens: 'mcp-write',
        defaultOn: false,
      },
      {
        name: 'create_review_comment',
        desc: 'Add an inline review comment to a pull request',
        sens: 'mcp-write',
        defaultOn: false,
      },
      { name: 'create_branch', desc: 'Create a new branch', sens: 'mcp-write', defaultOn: false },
    ],
  },
  {
    id: 'linear',
    name: 'Linear',
    serverId: 'claude_ai_Linear',
    probeTool: 'list_teams',
    tools: [
      { name: 'list_teams', desc: 'List all Linear teams', sens: 'mcp-read', defaultOn: false },
      {
        name: 'list_projects',
        desc: 'List projects in a team',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'list_issues',
        desc: 'List issues for a team or project',
        sens: 'mcp-read',
        defaultOn: true,
      },
      {
        name: 'get_issue',
        desc: 'Get full details of an issue',
        sens: 'mcp-read',
        defaultOn: true,
      },
      {
        name: 'search_issues',
        desc: 'Search issues by keyword or filter',
        sens: 'mcp-read',
        defaultOn: true,
      },
      { name: 'create_issue', desc: 'Create a new issue', sens: 'mcp-write', defaultOn: false },
      {
        name: 'update_issue',
        desc: 'Update issue status, assignee, or priority',
        sens: 'mcp-write',
        defaultOn: false,
      },
      {
        name: 'create_comment',
        desc: 'Add a comment to an issue',
        sens: 'mcp-write',
        defaultOn: false,
      },
    ],
  },
  {
    id: 'figma',
    name: 'Figma',
    serverId: 'claude_ai_Figma',
    probeTool: 'get_me',
    tools: [
      {
        name: 'get_me',
        desc: 'Get the authenticated user profile',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'get_file',
        desc: 'Read a Figma design file and its structure',
        sens: 'mcp-read',
        defaultOn: true,
      },
      {
        name: 'get_file_nodes',
        desc: 'Read specific nodes from a design file',
        sens: 'mcp-read',
        defaultOn: true,
      },
      { name: 'get_image', desc: 'Export a node as an image', sens: 'mcp-read', defaultOn: true },
      {
        name: 'get_comments',
        desc: 'List comments on a design file',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'get_team_components',
        desc: 'List shared components for the team',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'get_team_styles',
        desc: 'List shared styles (colors, typography)',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'post_comment',
        desc: 'Post a comment on a design file',
        sens: 'mcp-write',
        defaultOn: false,
      },
    ],
  },
  {
    id: 'slack',
    name: 'Slack',
    serverId: 'claude_ai_Slack',
    probeTool: 'list_channels',
    tools: [
      {
        name: 'list_channels',
        desc: 'List channels the integration is a member of',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'get_channel_history',
        desc: 'Read recent messages from a channel',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'search_messages',
        desc: 'Search messages across the workspace',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'get_user_profile',
        desc: 'Get a user profile by ID',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'post_message',
        desc: 'Post a message to a channel',
        sens: 'mcp-write',
        defaultOn: false,
      },
      {
        name: 'reply_to_thread',
        desc: 'Post a reply in a message thread',
        sens: 'mcp-write',
        defaultOn: false,
      },
    ],
  },
  {
    id: 'datadog',
    name: 'Datadog',
    serverId: 'claude_ai_Datadog',
    probeTool: 'list_dashboards',
    tools: [
      {
        name: 'list_dashboards',
        desc: 'List all Datadog dashboards',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'get_dashboard',
        desc: 'Get dashboard widgets and their metric queries',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'query_metrics',
        desc: 'Query time-series metric data',
        sens: 'mcp-read',
        defaultOn: true,
      },
      {
        name: 'list_monitors',
        desc: 'List alert monitors and their current status',
        sens: 'mcp-read',
        defaultOn: true,
      },
      {
        name: 'get_monitor',
        desc: 'Get monitor configuration and alert history',
        sens: 'mcp-read',
        defaultOn: true,
      },
      {
        name: 'search_logs',
        desc: 'Search application and infrastructure logs',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'list_services',
        desc: 'List APM services and their dependencies',
        sens: 'mcp-read',
        defaultOn: false,
      },
      {
        name: 'get_trace',
        desc: 'Get a distributed trace by ID',
        sens: 'mcp-read',
        defaultOn: false,
      },
    ],
  },
];

export const CONNECTOR_BY_ID: Record<string, ConnectorDef> = Object.fromEntries(
  CONNECTOR_REGISTRY.map(c => [c.id, c]),
);
