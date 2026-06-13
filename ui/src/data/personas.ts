import type { Persona } from '../types';
import { AGENT_BY_ID } from './marketAgents';

export const PERSONAS: Record<string, Persona> = {
  pm:         { id: 'pm',         name: 'Project Manager', short: 'PM', color: '#a585f5', role: 'Referee' },
  coder:      { id: 'coder',      name: 'Coder',           short: 'CO', color: '#4d8df4', role: 'Implementation' },
  tester:     { id: 'tester',     name: 'Tester',          short: 'TE', color: '#34cf8a', role: 'Verification' },
  security:   { id: 'security',   name: 'Security',        short: 'SE', color: '#e8a93a', role: 'Review' },
  reviewer:   { id: 'reviewer',   name: 'Code Reviewer',   short: 'CR', color: '#c084fc', role: 'Quality' },
  negotiator: { id: 'negotiator', name: 'Negotiator',      short: 'NE', color: '#ef8043', role: 'Arbitration' },
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const s = (parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '');
  return s.toUpperCase() || name.slice(0, 2).toUpperCase();
}

const FALLBACK_COLORS = ['#5bb8c4', '#d97aa8', '#7c9af2', '#62c98a', '#e0a14a', '#c98ae0', '#e07a7a'];
function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

// Resolve a persona for ANY agent id — builtin OR a hired marketplace agent.
// Marketplace agents (e.g. "db") aren't in PERSONAS, so the running view used to
// render them with no colour and a blank/raw-id name. Pull name + colour from the
// market catalogue; fall back to a deterministic colour for ids not in the catalogue.
export function resolveAgentPersona(id: string): Persona {
  const builtin = PERSONAS[id];
  if (builtin) return builtin;

  const mkt = AGENT_BY_ID[id];
  if (mkt) {
    return { id, name: mkt.name, short: initials(mkt.name), color: mkt.color, role: mkt.role };
  }

  const name = id.charAt(0).toUpperCase() + id.slice(1);
  return {
    id,
    name,
    short: initials(name),
    color: FALLBACK_COLORS[hashId(id) % FALLBACK_COLORS.length],
    role: 'Specialist',
  };
}
