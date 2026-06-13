import type { PermissionRequest } from '../../types';
import { resolveAgentPersona } from '../../data/personas';

// ─── Tool display helpers ─────────────────────────────────────────────────────

function ToolIcon({ tool }: { tool: string }) {
  const icons: Record<string, string> = {
    write_file: '✎',
    edit_file:  '✎',
    bash:       '$',
    run_tests:  '▶',
  };
  return <span style={{
    fontFamily:  'var(--mono)',
    fontSize:    13,
    background:  'var(--bg-2)',
    border:      '1px solid var(--border)',
    borderRadius: 4,
    padding:     '2px 6px',
    color:       'var(--tx-2)',
    flexShrink:  0,
  }}>{icons[tool] ?? '⚙'} {tool}</span>;
}

function InputDisplay({ tool, input }: { tool: string; input: Record<string, unknown> }) {
  if (tool === 'bash' || tool === 'run_tests') {
    const cmd = String(input.command ?? '');
    return (
      <pre style={{
        margin: 0, padding: '10px 14px',
        background: 'var(--bg-0)', border: '1px solid var(--border)',
        borderRadius: 6, fontFamily: 'var(--mono)', fontSize: 12,
        color: 'var(--tx-1)', overflowX: 'auto', maxHeight: 120, overflowY: 'auto',
        whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      }}>
        {cmd}
      </pre>
    );
  }

  if (tool === 'write_file' || tool === 'edit_file') {
    const filePath = String(input.file_path ?? input.path ?? '');
    const content  = String(input.content ?? input.new_string ?? '');
    const preview  = content.length > 600 ? content.slice(0, 600) + '\n…' : content;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--tx-2)' }}>
          {filePath}
        </span>
        {preview && (
          <pre style={{
            margin: 0, padding: '10px 14px',
            background: 'var(--bg-0)', border: '1px solid var(--border)',
            borderRadius: 6, fontFamily: 'var(--mono)', fontSize: 11,
            color: 'var(--tx-2)', overflowX: 'auto', maxHeight: 200, overflowY: 'auto',
            whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          }}>
            {preview}
          </pre>
        )}
      </div>
    );
  }

  // Fallback: JSON dump of input
  return (
    <pre style={{
      margin: 0, padding: '10px 14px',
      background: 'var(--bg-0)', border: '1px solid var(--border)',
      borderRadius: 6, fontFamily: 'var(--mono)', fontSize: 11,
      color: 'var(--tx-2)', overflowX: 'auto', maxHeight: 160, overflowY: 'auto',
      whiteSpace: 'pre-wrap',
    }}>
      {JSON.stringify(input, null, 2)}
    </pre>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function PermissionGate({
  request,
  onResolve,
}: {
  request:   PermissionRequest;
  onResolve: (requestId: string, decision: 'allow' | 'deny') => void;
}) {
  const persona = resolveAgentPersona(request.agentId);

  const toolLabel: Record<string, string> = {
    write_file: 'write a file',
    edit_file:  'edit a file',
    bash:       'run a command',
    run_tests:  'run the test suite',
  };

  return (
    <div style={{
      position:     'fixed',
      bottom:       24,
      left:         '50%',
      transform:    'translateX(-50%)',
      zIndex:       2000,
      width:        'min(640px, calc(100vw - 48px)',
      background:   'var(--bg-1)',
      border:       '1px solid var(--border)',
      borderRadius: 12,
      boxShadow:    '0 8px 40px rgba(0,0,0,0.55)',
      animation:    'slideTop 0.18s ease',
    }}>
      {/* Header */}
      <div style={{
        display:      'flex',
        alignItems:   'center',
        gap:          10,
        padding:      '12px 16px',
        borderBottom: '1px solid var(--border)',
      }}>
        <span style={{
          width: 9, height: 9, borderRadius: '50%',
          background: persona?.color ?? 'var(--tx-3)',
          flexShrink: 0,
        }} />
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--tx-1)' }}>
          {persona?.name ?? request.agentId}
        </span>
        <span style={{ fontSize: 12, color: 'var(--tx-3)' }}>
          wants to {toolLabel[request.tool] ?? request.tool}
        </span>
        <span style={{ flex: 1 }} />
        <ToolIcon tool={request.tool} />
      </div>

      {/* Content */}
      <div style={{ padding: '12px 16px' }}>
        <InputDisplay tool={request.tool} input={request.input} />
      </div>

      {/* Actions */}
      <div style={{
        display:     'flex',
        gap:         8,
        padding:     '10px 16px 14px',
        justifyContent: 'flex-end',
      }}>
        <button
          className="btn"
          onClick={() => onResolve(request.requestId, 'deny')}
          style={{
            background: 'var(--bg-2)',
            border:     '1px solid var(--border)',
            color:      'var(--tx-2)',
            fontSize:   13,
            padding:    '6px 18px',
          }}
        >
          Deny
        </button>
        <button
          className="btn primary"
          onClick={() => onResolve(request.requestId, 'allow')}
          style={{ fontSize: 13, padding: '6px 18px' }}
          autoFocus
        >
          Allow
        </button>
      </div>
    </div>
  );
}
