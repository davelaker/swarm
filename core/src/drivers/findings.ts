// Finding markdown builders — shared by both drivers.
// Conforms to DESIGN.md §6.2a finding gate contract.

import type { Task } from '../state/types.js';
import type { SecurityFinding, ReviewerFinding } from './types.js';

// Human-readable verdict labels for headings
const VERDICT_LABELS: Record<string, string> = {
  CHANGES_REQUESTED: 'Changes Requested',
  APPROVED:          'Approved',
  COMPLETE:          'Complete',
  PASS:              'Pass',
  PASS_WITH_ADVISORY:'Pass with Advisory',
  FAILED:            'Failed',
  FAIL:              'Failed',
};

// Builds the `## Verdict: Summary` heading line, avoiding degenerate
// "Changes Requested: CHANGES_REQUESTED" when summary is the same as verdict.
function verdictHeading(verdict: string, summary: string): string {
  const label     = VERDICT_LABELS[verdict.toUpperCase()] ?? verdict;
  const normSum   = summary.trim().toUpperCase().replace(/[\s_]+/g, '_');
  const normVerd  = verdict.toUpperCase().replace(/[\s_]+/g, '_');
  // Treat "COMPLETED" as a repeat of "COMPLETE", "APPROVED" of "APPROVED", etc.
  const isRepeat  = !summary.trim() || normSum === normVerd || normSum.startsWith(normVerd);
  return isRepeat ? `## ${label}\n\n` : `## ${label}: ${summary}\n\n`;
}

export function coderFinding(task: Task, summary: string, detail: string, files: string[]): string {
  const list = files.length ? files.map(f => `  - ${f}`).join('\n') : '  (none recorded)';
  return [
    '---',
    `task: ${task.id}`,
    `agent: coder`,
    `schema: coder-finding`,
    `verdict: COMPLETE`,
    `summary: "${summary.replace(/"/g, '\\"')}"`,
    '---',
    '',
    verdictHeading('COMPLETE', summary).trimEnd(),
    '',
    ...(detail ? [detail, ''] : []),
    '### Files changed',
    list,
    '',
  ].join('\n');
}

export function testerFinding(task: Task, verdict: string, summary: string, detail?: string): string {
  const bodyDetail = detail
    ? detail
    : verdict === 'PASS'
      ? 'Tests ran and passed. No failures detected.'
      : 'Tests ran but reported failures — see summary above.';
  return [
    '---',
    `task: ${task.id}`,
    `agent: tester`,
    `schema: tester-finding`,
    `verdict: ${verdict}`,
    `summary: "${summary.replace(/"/g, '\\"')}"`,
    '---',
    '',
    verdictHeading(verdict, summary).trimEnd(),
    '',
    bodyDetail,
    '',
  ].join('\n');
}

export function reviewerFinding(task: Task, verdict: string, summary: string, detail: string, items: ReviewerFinding[]): string {
  const findingsList = items.length
    ? items.map(f =>
        `  - id: ${f.id}\n    severity: ${f.severity}\n    category: ${f.category}\n    location: ${f.location}`
      ).join('\n')
    : '';

  const header = [
    '---',
    `task: ${task.id}`,
    `agent: reviewer`,
    `schema: reviewer-finding`,
    `verdict: ${verdict}`,
    `summary: "${summary.replace(/"/g, '\\"')}"`,
    ...(findingsList ? ['findings:', findingsList] : []),
    '---',
    '',
  ].join('\n');

  const body = items.length
    ? items.map(f => [
        `### ${f.id} — ${f.severity}: ${f.category}`,
        `**Location:** \`${f.location}\``,
        f.issue ? `**Issue:** ${f.issue}` : '',
        `**Fix:** ${f.fix}`,
        '',
      ].filter(l => l !== '').join('\n')).join('\n')
    : verdict === 'APPROVED'
      ? 'No significant issues found in the changed code.\n'
      : 'The reviewer flagged changes but did not produce a structured findings list.\n';

  const detailBlock = detail ? `${detail}\n\n` : '';
  return header + verdictHeading(verdict, summary) + detailBlock + body;
}

export function marketplaceFinding(
  task:      Task,
  agentId:   string,
  agentName: string,
  verdict:   string,
  summary:   string,
  detail:    string,
  findings:  Array<Record<string, unknown>>,
): string {
  const findingsList = findings.length
    ? findings.map(f => `  - id: ${String(f.id ?? '?')}`).join('\n')
    : '';

  const header = [
    '---',
    `task: ${task.id}`,
    `agent: ${agentId}`,
    `schema: marketplace-finding`,
    `verdict: ${verdict}`,
    `summary: "${summary.replace(/"/g, '\\"')}"`,
    ...(findingsList ? ['findings:', findingsList] : []),
    '---',
    '',
  ].join('\n');

  const body = findings.length
    ? findings.map(f => {
        const id   = String(f.id ?? '?');
        const rest = Object.entries(f)
          .filter(([k]) => k !== 'id')
          .map(([k, v]) => `**${k}:** ${String(v)}`)
          .join('\n');
        return `### ${id}\n${rest}\n`;
      }).join('\n')
    : ['APPROVED', 'ADVISORY', 'COMPLETE'].includes(verdict.toUpperCase())
      ? 'No issues found.\n'
      : 'Issues were identified — see summary above.\n';

  const detailBlock = detail ? `${detail}\n\n` : '';
  return header + verdictHeading(verdict, summary) + detailBlock + body;
}

export function securityFinding(task: Task, verdict: string, summary: string, detail: string, items: SecurityFinding[]): string {
  const findingsList = items.length
    ? items.map(f =>
        `  - id: ${f.id}\n    severity: ${f.severity}\n    type: ${f.type}\n    location: ${f.location}`
      ).join('\n')
    : '';

  const header = [
    '---',
    `task: ${task.id}`,
    `agent: security`,
    `schema: security-finding`,
    `verdict: ${verdict}`,
    `summary: "${summary.replace(/"/g, '\\"')}"`,
    ...(findingsList ? ['findings:', findingsList] : []),
    '---',
    '',
  ].join('\n');

  const body = items.length
    ? items.map(f => [
        `### ${f.id} — ${f.severity}: ${f.type}`,
        `**Location:** \`${f.location}\``,
        f.attack_path ? `**Attack path:** ${f.attack_path}` : '',
        `**Fix:** ${f.fix}`,
        '',
      ].filter(l => l !== '').join('\n')).join('\n')
    : verdict === 'APPROVED'
      ? 'No security issues found.\n'
      : 'The security reviewer flagged issues but did not produce a structured findings list.\n';

  const detailBlock = detail ? `${detail}\n\n` : '';
  return header + verdictHeading(verdict, summary) + detailBlock + body;
}
