import { useState, useEffect, useCallback } from 'react';
import { IconFolder, IconChevronLeft, IconChevron } from './icons';

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

export function ProjectSwitcher({ currentRoot, onClose }: Props) {
  const [browsePath,   setBrowsePath]   = useState<string>('');
  const [typedPath,    setTypedPath]    = useState('');
  const [entries,      setEntries]      = useState<FsEntry[]>([]);
  const [parent,       setParent]       = useState<string | null>(null);
  const [loading,      setLoading]      = useState(false);
  const [fsError,      setFsError]      = useState<string | null>(null);
  const [selectedSwarm, setSelectedSwarm] = useState(false); // hasSwarm for browsePath
  const [switching,    setSwitching]    = useState(false);
  const [switchErr,    setSwitchErr]    = useState<string | null>(null);

  const fetchDir = useCallback((p: string, parentHasSwarm?: boolean) => {
    setLoading(true);
    setFsError(null);
    fetch(`/fs?path=${encodeURIComponent(p)}`)
      .then(r => r.json() as Promise<FsResponse>)
      .then(d => {
        setBrowsePath(d.path);
        setTypedPath(d.path);
        setParent(d.parent);
        setEntries(d.entries);
        if (parentHasSwarm !== undefined) setSelectedSwarm(parentHasSwarm);
        if (d.error) setFsError(d.error);
      })
      .catch(() => setFsError('Could not list directory'))
      .finally(() => setLoading(false));
  }, []);

  // Seed from server's current root on open
  useEffect(() => { fetchDir(currentRoot ?? ''); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Close on Escape
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, [onClose]);

  const handleTypedSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (typedPath.trim()) fetchDir(typedPath.trim());
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
        if (d.ok) {
          window.location.reload();
        } else {
          setSwitchErr(d.error ?? 'Switch failed');
          setSwitching(false);
        }
      })
      .catch(() => { setSwitchErr('Network error'); setSwitching(false); });
  };

  const isCurrent = browsePath === currentRoot;

  return (
    <div className="ps-backdrop" onClick={onClose}>
      <div className="ps-modal" onClick={e => e.stopPropagation()}>

        <div className="ps-head">
          <IconFolder size={15} />
          <span>Switch project folder</span>
          <button className="ps-close" onClick={onClose}>×</button>
        </div>

        {/* Path bar */}
        <form className="ps-pathbar" onSubmit={handleTypedSubmit}>
          {parent && (
            <button
              type="button"
              className="ps-up"
              onClick={() => fetchDir(parent)}
              title="Go up one level"
            >
              <IconChevronLeft size={12} />
            </button>
          )}
          <input
            className="ps-pathinput"
            value={typedPath}
            onChange={e => setTypedPath(e.target.value)}
            spellCheck={false}
            placeholder="Enter path…"
          />
          <button type="submit" className="ps-go" disabled={!typedPath.trim() || loading}>
            Go
          </button>
        </form>

        {/* Directory listing */}
        <div className="ps-list">
          {loading && <div className="ps-loading">Loading…</div>}
          {!loading && fsError && <div className="ps-empty">{fsError}</div>}
          {!loading && !fsError && entries.length === 0 && (
            <div className="ps-empty">No subdirectories</div>
          )}
          {!loading && !fsError && entries.map(e => (
            <button
              key={e.path}
              className="ps-entry"
              onClick={() => fetchDir(e.path, e.hasSwarm)}
            >
              <span className="ps-entry-icon"><IconFolder size={13} /></span>
              <span className="ps-entry-name">{e.name}</span>
              {e.hasSwarm && <span className="ps-swarm-badge">✓ swarm</span>}
              <span className="ps-entry-chevron"><IconChevron /></span>
            </button>
          ))}
        </div>

        {/* Selected path + switch action */}
        <div className="ps-footer">
          <div className="ps-selection">
            <div className="ps-selection-path">{browsePath || '—'}</div>
            <div className="ps-selection-meta">
              {isCurrent ? (
                <span className="ps-meta-current">current project</span>
              ) : selectedSwarm ? (
                <span className="ps-meta-ok">✓ swarm initialized</span>
              ) : (
                <span className="ps-meta-new">no swarm state — will be created on first run</span>
              )}
            </div>
          </div>
          <div className="ps-footer-actions">
            {switchErr && <span className="ps-err">{switchErr}</span>}
            <button
              className="btn primary"
              disabled={!browsePath || isCurrent || switching}
              onClick={handleSwitch}
            >
              {switching ? 'Switching…' : 'Switch →'}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
