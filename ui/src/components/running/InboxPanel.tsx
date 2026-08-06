import type { PermissionRequest, Task } from '../../types';
import { resolveAgentPersona } from '../../data/personas';

// The "needs you now" queue — the attention surface the findings feed is not.
// Findings are FYI; this panel lists ONLY items that are waiting on the human:
// a pending permission ask, blocked tasks (a gate or reviewer said no), and
// failed tasks. It renders nothing at all when there is nothing to act on, so
// it adds zero noise to a healthy run. Mixing FYI with action-required in one
// stream is the top documented trust-killer in agent UIs — this is the split.

export interface InboxItem {
  key: string;
  kind: 'permission' | 'blocked' | 'failed';
  taskId?: string;
  agentId: string;
  title: string;
  hint: string;
}

// Pure: derive the action-required items from run state. Exported for tests.
export function deriveInboxItems(
  tasks: Task[],
  pendingPermission: PermissionRequest | null,
): InboxItem[] {
  const items: InboxItem[] = [];
  if (pendingPermission) {
    items.push({
      key: `perm-${pendingPermission.requestId}`,
      kind: 'permission',
      agentId: pendingPermission.agentId,
      title: `Permission: ${pendingPermission.tool}`,
      hint: 'Waiting on your approve/deny in the dialog',
    });
  }
  for (const t of tasks) {
    if (t.status === 'blocked') {
      items.push({
        key: `blocked-${t.id}`,
        kind: 'blocked',
        taskId: t.id,
        agentId: t.assignee,
        title: t.title,
        hint: 'Blocked — review findings, then steer or re-run',
      });
    } else if (t.status === 'failed') {
      items.push({
        key: `failed-${t.id}`,
        kind: 'failed',
        taskId: t.id,
        agentId: t.assignee,
        title: t.title,
        hint: 'Failed — read the finding, then steer to retry',
      });
    }
  }
  return items;
}

const KIND_META: Record<InboxItem['kind'], { glyph: string; color: string }> = {
  permission: { glyph: '⏳', color: 'var(--amber)' },
  blocked: { glyph: '⚑', color: 'var(--amber)' },
  failed: { glyph: '✗', color: 'var(--red)' },
};

export function InboxPanel({
  tasks,
  pendingPermission,
  onFocusTask,
}: {
  tasks: Task[];
  pendingPermission: PermissionRequest | null;
  onFocusTask: (taskId: string | null) => void;
}) {
  const items = deriveInboxItems(tasks, pendingPermission);
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="run-inbox">
      <div className="panel-head">
        <span>Needs you</span>
        <span className="inbox-count">{items.length}</span>
        <span className="spacer" />
      </div>
      <div className="inbox-items">
        {items.map(item => {
          const meta = KIND_META[item.kind];
          const p = resolveAgentPersona(item.agentId);
          return (
            <button
              key={item.key}
              className="inbox-item"
              onMouseEnter={() => item.taskId && onFocusTask(item.taskId)}
              onMouseLeave={() => onFocusTask(null)}
              title={item.hint}
            >
              <span className="inbox-glyph" style={{ color: meta.color }}>
                {meta.glyph}
              </span>
              <span className="inbox-body">
                <span className="inbox-title">
                  {item.taskId && <span className="inbox-tid">{item.taskId}</span>}
                  {item.title}
                </span>
                <span className="inbox-hint">
                  <span className="pdot" style={{ background: p?.color }} />
                  {p?.name} · {item.hint}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
