// Parser for Claude Code's `--output-format stream-json` NDJSON stream.
//
// With `--print --output-format stream-json --verbose`, the CLI emits one JSON
// object per line as the agent works, instead of a single buffered envelope at
// the end. Each line is a high-level SDK message; this module turns those raw
// messages into the small set of normalised events the dashboard cares about
// (thinking text, tool calls, tool results, and the final cost envelope).
//
// Kept pure and transport-free so it is trivially unit-testable: the driver owns
// spawning and emission, this module owns interpretation.

export type StreamEvent =
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { kind: 'tool_result'; id: string; isError: boolean; text: string }
  | { kind: 'result'; costUsd: number; isError: boolean };

interface RawBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface RawMessage {
  type?: string;
  message?: { content?: RawBlock[] };
  total_cost_usd?: number;
  cost_usd?: number;
  is_error?: boolean;
}

// Flatten a tool_result's `content` (string | block[] | undefined) to plain text.
function toolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map(c =>
        c && typeof c === 'object' && 'text' in c ? String((c as RawBlock).text ?? '') : '',
      )
      .join('');
  }
  return '';
}

// Turn one parsed NDJSON message into zero or more normalised stream events.
export function parseStreamMessage(raw: unknown): StreamEvent[] {
  const msg = raw as RawMessage;
  if (!msg || typeof msg !== 'object') {
    return [];
  }

  switch (msg.type) {
    case 'assistant': {
      const out: StreamEvent[] = [];
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'thinking' && block.thinking) {
          out.push({ kind: 'thinking', text: block.thinking });
        } else if (block.type === 'tool_use' && block.name) {
          out.push({
            kind: 'tool_use',
            id: block.id ?? '',
            name: block.name,
            input: block.input ?? {},
          });
        }
      }
      return out;
    }
    case 'user': {
      const out: StreamEvent[] = [];
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'tool_result') {
          out.push({
            kind: 'tool_result',
            id: block.tool_use_id ?? '',
            isError: Boolean(block.is_error),
            text: toolResultText(block.content),
          });
        }
      }
      return out;
    }
    case 'result':
      return [
        {
          kind: 'result',
          costUsd: msg.total_cost_usd ?? msg.cost_usd ?? 0,
          isError: Boolean(msg.is_error),
        },
      ];
    default:
      return [];
  }
}

// How many lines a Read tool returned. Claude Code's Read result is cat -n style
// ("   123→content"), so the highest line-number prefix is the count; fall back to
// counting newlines for any other shape. Returns null when there is nothing to count.
export function readResultLineCount(text: string): number | null {
  if (!text.trim()) {
    return null;
  }
  let max = 0;
  for (const m of text.matchAll(/(?:^|\n)\s*(\d+)→/g)) {
    const n = Number(m[1]);
    if (n > max) {
      max = n;
    }
  }
  if (max > 0) {
    return max;
  }
  return text.split('\n').filter(l => l.length > 0).length || null;
}

// Shorten a path to its last two segments so steps read cleanly in the UI.
function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || p;
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// Render a tool_use as a short human-readable activity line (presentation only).
export function describeToolUse(name: string, input: Record<string, unknown>): string {
  const file = typeof input.file_path === 'string' ? shortPath(input.file_path) : '';
  switch (name) {
    case 'Read':
      return file ? `Reading ${file}` : 'Reading a file';
    case 'Edit':
    case 'MultiEdit':
      return file ? `Editing ${file}` : 'Editing a file';
    case 'Write':
      return file ? `Writing ${file}` : 'Writing a file';
    case 'Bash': {
      const cmd = typeof input.command === 'string' ? input.command : '';
      return cmd ? `$ ${truncate(cmd, 60)}` : 'Running a command';
    }
    case 'Glob':
    case 'Grep': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : '';
      return pattern ? `Searching “${truncate(pattern, 40)}”` : 'Searching the codebase';
    }
    case 'LS': {
      const dir = typeof input.path === 'string' ? shortPath(input.path) : '';
      return dir ? `Listing ${dir}` : 'Listing files';
    }
    default:
      // MCP tools arrive as mcp__server__tool — surface the leaf name.
      return name.startsWith('mcp__') ? (name.split('__').pop() ?? name) : name;
  }
}

// Incremental newline-delimited JSON buffer. Feed it raw stdout chunks; it calls
// onMessage once per complete JSON line and tolerates partial trailing lines.
export function createNdjsonBuffer(onMessage: (msg: unknown) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buffer = '';

  const drainLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      onMessage(JSON.parse(trimmed));
    } catch {
      /* partial or non-JSON line — skip; stream-json guarantees whole lines */
    }
  };

  return {
    push(chunk: string): void {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        drainLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
    },
    flush(): void {
      drainLine(buffer);
      buffer = '';
    },
  };
}
