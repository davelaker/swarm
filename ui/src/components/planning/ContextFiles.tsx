import { useState } from 'react';
import type { ContextFile } from '../../hooks/useContextFiles';

interface ContextFilesProps {
  projectMd: ContextFile | null;
  contextFiles: ContextFile[];
}

export function ContextFiles({ projectMd, contextFiles }: ContextFilesProps) {
  const all: ContextFile[] = [...(projectMd ? [projectMd] : []), ...contextFiles];

  return (
    <div className="csec">
      <div className="csec-label">
        <span className="num">07</span> PM context sources
      </div>
      {all.length === 0 ? (
        <div className="empty">
          None discovered — add CLAUDE.md or CONTEXT.md files in subdirectories to give the PM
          richer context
        </div>
      ) : (
        <>
          <div className="ctx-sources-hint">
            Pre-loaded before planning · click a file to expand
          </div>
          <div className="ctx-files">
            {all.map(f => (
              <ContextRow key={f.relPath} file={f} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ContextRow({ file }: { file: ContextFile }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(file.relPath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="ctx-file">
      <div className="ctx-file-head" onClick={() => setOpen(o => !o)}>
        <span className="ctx-file-chevron">{open ? '▾' : '▸'}</span>
        <span className="ctx-file-path">{file.relPath}</span>
        <span className="ctx-file-spacer" />
        <button className="ctx-copy" onClick={handleCopy} title="Copy file path">
          {copied ? '✓' : 'copy path'}
        </button>
      </div>
      {open && <pre className="ctx-file-body">{file.content}</pre>}
    </div>
  );
}
