import type { Persona } from '../types';

export const PERSONAS: Record<string, Persona> = {
  pm:         { id: 'pm',         name: 'Project Manager', short: 'PM', color: '#a585f5', role: 'Referee' },
  coder:      { id: 'coder',      name: 'Coder',           short: 'CO', color: '#4d8df4', role: 'Implementation' },
  tester:     { id: 'tester',     name: 'Tester',          short: 'TE', color: '#34cf8a', role: 'Verification' },
  security:   { id: 'security',   name: 'Security',        short: 'SE', color: '#e8a93a', role: 'Review' },
  negotiator: { id: 'negotiator', name: 'Negotiator',      short: 'NE', color: '#ef8043', role: 'Arbitration' },
};
