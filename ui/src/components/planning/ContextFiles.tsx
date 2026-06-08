import { useState } from 'react';
import type { ContextFile } from '../../hooks/useContextFiles';

interface ContextFilesProps {
  projectMd:    ContextFile | null;
  contextFiles: ContextFile[];
  onAskPm:      (message: string) => void;
}

export function ContextFiles({ projectMd, contextFiles, onAskPm }: ContextFilesProps) {
  const all: ContextFile[] = [
    ...(projectMd    ? [projectMd]    : []),
    ...contextFiles,
  ];

  return (
    <div className="csec">
      <div className="csec-label">
        <span className="num">06</span> Context files
      </div>
      {all.length === 0
        ? <div className="empty">None yet — created automatically as agents run</div>
        : <div className="ctx-files">
            {all.map(f => <ContextRow key={f.relPath} file={f} onAskPm={onAskPm} />)}
          </div>}
    </div>
  );
}

function ContextRow({ file, onAskPm }: { file: ContextFile; onAskPm: (msg: string) => void }) {
  const [open, setOpen] = useState(false);

  const handleAsk = (e: React.MouseEvent) => {
    e.stopPropagation();
    const snippet = file.content.length > 1200
      ? file.content.slice(0, 1200) + '\n…(truncated)'
      : file.content;
    onAskPm(
      `Please review \`${file.relPath}\` and suggest any updates based on our discussion.\n\nCurrent content:\n\`\`\`\n${snippet}\n\`\`\``
    );
  };

  return (
    <div className="ctx-file">
      <div className="ctx-file-head" onClick={() => setOpen(o => !o)}>
        <span className="ctx-file-chevron">{open ? '▾' : '▸'}</span>
        <span className="ctx-file-path">{file.relPath}</span>
        <span className="ctx-file-spacer" />
        <button className="ctx-ask" onClick={handleAsk}>ask PM</button>
      </div>
      {open && <pre className="ctx-file-body">{file.content}</pre>}
    </div>
  );
}
