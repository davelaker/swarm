import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { IconFolder, IconChevron } from './icons';

interface FsEntry {
  name:     string;
  path:     string;
  hasSwarm: boolean;
}

interface FsResponse {
  path:    string;
  parent:  string | null;
  entries: FsEntry[];
  error?:  string;
}

interface Props {
  currentRoot: string | null;
  onClose:     () => void;
}

// Split an absolute path into breadcrumb segments
function parseCrumbs(p: string): Array<{ label: string; path: string }> {
  const parts = p.split('/').filter(Boolean);
  return [
    { label: '/', path: '/' },
    ...parts.map((part, i) => ({
      label: part,
      path:  '/' + parts.slice(0, i + 1).join('/'),
    })),
  ];
}

export function ProjectSwitcher({ currentRoot, onClose }: Props) {
  const [browsePath,    setBrowsePath]    = useState('');
  const [parent,        setParent]        = useState<string | null>(null);
  const [entries,       setEntries]       = useState<FsEntry[]>([]);
  const [loading,       setLoading]       = useState(false);
  const [fsError,       setFsError]       = useState<string | null>(null);
  const [selectedSwarm, setSelectedSwarm] = useState(false);
  const [filter,        setFilter]        = useState('');
  const [focusIdx,      setFocusIdx]      = useState(-1);
  const [pathMode,      setPathMode]      = useState(false); // raw-input mode
  const [rawPath,       setRawPath]       = useState('');
  const [switching,     setSwitching]     = useState(false);
  const [switchErr,     setSwitchErr]     = useState<string | null>(null);

  const listRef   = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const rawRef    = useRef<HTMLInputElement>(null);

  const fetchDir = useCallback((p: string, knownHasSwarm?: boolean) => {
    setLoading(true);
    setFsError(null);
    setFilter('');
    setFocusIdx(-1);
    setPathMode(false);
    fetch(`/fs?path=${encodeURIComponent(p)}`)
      .then(r => r.json() as Promise<FsResponse>)
      .then(d => {
        setBrowsePath(d.path);
        setRawPath(d.path);
        setParent(d.parent);
        setEntries(d.entries);
        if (knownHasSwarm !== undefined) setSelectedSwarm(knownHasSwarm);
        if (d.error) setFsError(d.error);
        // Focus filter after navigation
        setTimeout(() => filterRef.current?.focus(), 60);
      })
      .catch(() => setFsError('Could not list directory'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchDir(currentRoot ?? ''); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Global keyboard handler
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (pathMode) { setPathMode(false); return; }
        onClose();
      }
    };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, [onClose, pathMode]);

  // Filtered + sorted entries
  const visible = useMemo(() => {
    const q = filter.toLowerCase();
    return q ? entries.filter(e => e.name.toLowerCase().includes(q)) : entries;
  }, [entries, filter]);

  // Keep focusIdx in bounds when filter changes
  useEffect(() => { setFocusIdx(v => (v >= visible.length ? visible.length - 1 : v)); }, [visible]);

  // Scroll focused item into view
  useEffect(() => {
    if (focusIdx < 0) return;
    const el = listRef.current?.querySelector(`[data-idx="${focusIdx}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusIdx]);

  const handleListKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocusIdx(i => Math.min(i + 1, visible.length - 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setFocusIdx(i => Math.max(i - 1, 0)); }
    if (e.key === 'Enter' && focusIdx >= 0 && visible[focusIdx]) {
      e.preventDefault();
      const entry = visible[focusIdx];
      fetchDir(entry.path, entry.hasSwarm);
    }
    if (e.key === 'Backspace' && !filter && parent) {
      e.preventDefault();
      fetchDir(parent);
    }
  };

  const handleFilterChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFilter(e.target.value);
    setFocusIdx(e.target.value ? 0 : -1);
  };

  const handleRawSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (rawPath.trim()) fetchDir(rawPath.trim());
  };

  const handleHomeClick = () => {
    // Jump to the home directory: derive from currentRoot (/Users/name/...)
    // or fall back to the parent of the current browse path.
    const base = currentRoot ?? browsePath;
    const segs  = base.split('/').filter(Boolean);
    // /Users/<name> is depth 2; anything shallower just goes to /
    const home  = segs.length >= 2 ? '/' + segs.slice(0, 2).join('/') : '/';
    fetchDir(home);
  };

  const handleSwitch = () => {
    if (!browsePath) return;
    setSwitching(true);
    setSwitchErr(null);
    fetch('/project/switch', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ path: browsePath }),
    })
      .then(r => r.json() as Promise<{ ok: boolean; error?: string }>)
      .then(d => {
        if (d.ok) { window.location.reload(); }
        else      { setSwitchErr(d.error ?? 'Switch failed'); setSwitching(false); }
      })
      .catch(() => { setSwitchErr('Network error'); setSwitching(false); });
  };

  const crumbs    = parseCrumbs(browsePath);
  const isCurrent = browsePath === currentRoot;

  return (
    <div className="ps-backdrop" onClick={onClose}>
      <div className="ps-modal" onClick={e => e.stopPropagation()}>

        {/* ── Header ── */}
        <div className="ps-head">
          <IconFolder size={14} />
          <span>Switch project folder</span>
          <button className="ps-close" onClick={onClose}>×</button>
        </div>

        {/* ── Breadcrumb bar ── */}
        <div className="ps-crumbbar">
          <div className="ps-crumbs" onDoubleClick={() => { setPathMode(true); setTimeout(() => { rawRef.current?.select(); }, 30); }}>
            {/* Home shortcut */}
            <button className="ps-home" onClick={handleHomeClick} title="Jump to home">⌂</button>
            <span className="ps-crumb-sep">/</span>

            {crumbs.slice(1).map((c, i) => (
              <span key={c.path} className="ps-crumb-group">
                {i > 0 && <span className="ps-crumb-sep">/</span>}
                {i < crumbs.length - 2 ? (
                  <button
                    className="ps-crumb"
                    onClick={() => fetchDir(c.path)}
                    title={c.path}
                  >{c.label}</button>
                ) : (
                  <span className="ps-crumb ps-crumb-current">{c.label}</span>
                )}
              </span>
            ))}

            {/* Pencil hint — "double-click to type a path" */}
            <button
              className="ps-crumb-edit"
              title="Type a path directly"
              onClick={() => { setPathMode(true); setTimeout(() => { rawRef.current?.select(); }, 30); }}
            >✎</button>
          </div>

          {/* Raw path input — shown on demand */}
          {pathMode && (
            <form className="ps-rawform" onSubmit={handleRawSubmit}>
              <input
                ref={rawRef}
                className="ps-rawinput"
                value={rawPath}
                onChange={e => setRawPath(e.target.value)}
                spellCheck={false}
                autoFocus
                onBlur={() => { if (!rawPath.trim()) setPathMode(false); }}
              />
              <button type="submit" className="ps-go" disabled={!rawPath.trim()}>Go</button>
            </form>
          )}
        </div>

        {/* ── Filter box ── */}
        <div className="ps-filterbar">
          <span className="ps-filter-icon">🔍</span>
          <input
            ref={filterRef}
            className="ps-filter"
            placeholder="Filter folders…"
            value={filter}
            onChange={handleFilterChange}
            onKeyDown={handleListKey}
            spellCheck={false}
          />
          {filter && (
            <button className="ps-filter-clear" onClick={() => { setFilter(''); setFocusIdx(-1); filterRef.current?.focus(); }}>×</button>
          )}
        </div>

        {/* ── Directory list ── */}
        <div className="ps-list" ref={listRef}>
          {loading && (
            <div className="ps-loading">
              <span className="ps-spinner" />
              Loading…
            </div>
          )}
          {!loading && fsError && <div className="ps-empty ps-empty-err">{fsError}</div>}
          {!loading && !fsError && visible.length === 0 && filter && (
            <div className="ps-empty">No folders matching <code>{filter}</code></div>
          )}
          {!loading && !fsError && visible.length === 0 && !filter && (
            <div className="ps-empty">No subdirectories</div>
          )}
          {!loading && !fsError && visible.map((e, i) => (
            <button
              key={e.path}
              data-idx={i}
              className={`ps-entry${i === focusIdx ? ' focused' : ''}${e.path === currentRoot ? ' ps-entry-current' : ''}`}
              onClick={() => fetchDir(e.path, e.hasSwarm)}
              onMouseEnter={() => setFocusIdx(i)}
            >
              <span className="ps-entry-icon">
                <IconFolder size={13} />
              </span>
              <span className="ps-entry-name">{
                // Bold the matching substring
                filter ? <Highlight text={e.name} query={filter} /> : e.name
              }</span>
              <span className="ps-entry-badges">
                {e.hasSwarm  && <span className="ps-badge-swarm">✓ swarm</span>}
                {e.path === currentRoot && <span className="ps-badge-here">here</span>}
              </span>
              <span className="ps-entry-chevron"><IconChevron /></span>
            </button>
          ))}
        </div>

        {/* ── Footer ── */}
        <div className="ps-footer">
          <div className="ps-selection">
            <div className="ps-sel-path" title={browsePath}>{browsePath || (loading ? 'Loading…' : '—')}</div>
            <div className="ps-sel-meta">
              {!browsePath ? null
                : isCurrent
                  ? <span className="ps-meta-current">● current project</span>
                  : selectedSwarm
                    ? <span className="ps-meta-ok">✓ swarm initialized</span>
                    : <span className="ps-meta-new">no swarm state — created on first run</span>
              }
            </div>
          </div>
          <div className="ps-footer-right">
            {switchErr && <span className="ps-err">{switchErr}</span>}
            <button
              className="btn primary"
              disabled={!browsePath || isCurrent || switching}
              onClick={handleSwitch}
            >
              {switching ? 'Switching…' : 'Switch here →'}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}

// Highlight matching substring in an entry name
function Highlight({ text, query }: { text: string; query: string }) {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="ps-match">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}
