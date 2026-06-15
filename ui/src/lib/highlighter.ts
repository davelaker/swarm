import { createHighlighter, type BundledLanguage, type Highlighter, type ThemedToken } from 'shiki';

// One lazily-created Shiki highlighter for the whole app. Languages load on demand
// (only what a diff actually contains), so the first "View changes" pays a small
// async cost and subsequent files are instant. A local dev tool, so bundle size of
// the full `shiki` grammar set is acceptable.

export const DIFF_THEME = 'github-dark';

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({ themes: [DIFF_THEME], langs: [] });
  }
  return highlighterPromise;
}

// Tokenize whole-file content into per-line themed tokens, so multi-line constructs
// (template literals, JSX, block comments) highlight correctly. Returns null when
// there's nothing to highlight. Unknown/unsupported languages fall back to plain
// text rather than throwing.
export async function tokenizeFile(
  content: string | null,
  language: string,
): Promise<ThemedToken[][] | null> {
  if (content === null) {
    return null;
  }
  const hl = await getHighlighter();
  let lang = language;
  if (lang !== 'text' && !hl.getLoadedLanguages().includes(lang)) {
    try {
      await hl.loadLanguage(lang as BundledLanguage);
    } catch {
      lang = 'text';
    }
  }
  try {
    return hl.codeToTokens(content, { lang: lang as BundledLanguage, theme: DIFF_THEME }).tokens;
  } catch {
    return hl.codeToTokens(content, { lang: 'text', theme: DIFF_THEME }).tokens;
  }
}

export type { ThemedToken };
