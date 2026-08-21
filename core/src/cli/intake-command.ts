const LEGACY_COMMANDS = ['init', 'check', 'status', 'new', 'eval', 'dev', 'help'] as const;
const LIGHTWEIGHT_COMMANDS = ['ask', 'do', 'plan', 'swarm'] as const;

export type LegacyCommandName = (typeof LEGACY_COMMANDS)[number];
export type LightweightCommandName = (typeof LIGHTWEIGHT_COMMANDS)[number];

export interface LegacyCommand {
  kind: 'legacy';
  command: LegacyCommandName;
  args: string[];
}

export interface IntakeCommand {
  kind: 'intake';
  command: LightweightCommandName | 'auto';
  instruction: string;
  args: string[];
}

export interface IntakeCommandParseError {
  kind: 'error';
  code: 'empty-input' | 'missing-instruction';
  message: string;
}

export type IntakeCommandValue = LegacyCommand | IntakeCommand;

export interface IntakeCommandParseSuccess {
  ok: true;
  value: IntakeCommandValue;
}

export interface IntakeCommandParseFailure {
  ok: false;
  error: IntakeCommandParseError;
}

export type IntakeCommandParseResult = IntakeCommandParseSuccess | IntakeCommandParseFailure;

export function parseIntakeCommand(argv: readonly string[]): IntakeCommandParseResult {
  const tokens = normalizeTokens(argv);
  if (!tokens.length) {
    return parseFailure('empty-input', 'Expected a Swarm command or instruction.');
  }

  const [head, ...tail] = tokens;
  if (isLegacyCommand(head)) {
    return parseSuccess({
      kind: 'legacy',
      command: head,
      args: tail,
    });
  }

  if (isLightweightCommand(head)) {
    const instruction = joinInstruction(tail);
    if (!instruction) {
      return parseFailure('missing-instruction', `Usage: swarm ${head} "<instruction>"`);
    }
    return parseSuccess({
      kind: 'intake',
      command: head,
      instruction,
      args: tail,
    });
  }

  const instruction = joinInstruction(tokens);
  if (!instruction) {
    return parseFailure('empty-input', 'Expected a Swarm command or instruction.');
  }
  return parseSuccess({
    kind: 'intake',
    command: 'auto',
    instruction,
    args: tokens,
  });
}

function normalizeTokens(argv: readonly string[]): string[] {
  return argv.map((token) => token.trim()).filter((token) => token.length > 0);
}

function joinInstruction(tokens: readonly string[]): string {
  return tokens.join(' ').trim();
}

function isLegacyCommand(token: string): token is LegacyCommandName {
  return LEGACY_COMMANDS.includes(token as LegacyCommandName);
}

function isLightweightCommand(token: string): token is LightweightCommandName {
  return LIGHTWEIGHT_COMMANDS.includes(token as LightweightCommandName);
}

function parseSuccess(value: IntakeCommandValue): IntakeCommandParseSuccess {
  return {
    ok: true,
    value,
  };
}

function parseFailure(
  code: IntakeCommandParseError['code'],
  message: string,
): IntakeCommandParseFailure {
  return {
    ok: false,
    error: {
      kind: 'error',
      code,
      message,
    },
  };
}
