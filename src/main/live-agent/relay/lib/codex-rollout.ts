/**
 * Codex CLI rollout files ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl) as
 * Claude Code transcript lines, so the transcript parser shows a Codex session like a Claude one.
 * Codex has no hooks: the relay reads the rollout like a transcript (file watch and poll).
 */

/** Whether a session file is a Codex rollout */
export function isCodexRollout(filePath: string): boolean {
  return /(^|[\\/])rollout-[^\\/]*\.jsonl$/.test(filePath)
}

/** The thread id at the end of a rollout's file name (its session id) */
export function codexRolloutThreadId(fileName: string): string | undefined {
  return /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(fileName)?.[1]
}

type Item = Record<string, unknown>

const assistant = (uuid: string, content: unknown[]) =>
  JSON.stringify({ type: 'assistant', uuid, message: { role: 'assistant', content } })
const user = (uuid: string, content: unknown) =>
  JSON.stringify({ type: 'user', uuid, message: { role: 'user', content } })

/** The tool calls an item stands for: [tool_use id, tool name] */
function toolCalls(item: Item): Array<[string, string]> {
  const id = String(item.id)
  switch (item.type) {
    case 'CommandExecution':
      return [[id, 'Bash']]
    case 'McpToolCall':
      return [[id, `mcp__${String(item.server)}__${String(item.tool)}`]]
    case 'FileChange': {
      const changes = item.changes && typeof item.changes === 'object' ? Object.values(item.changes) : []
      return changes.map((change, i) =>
        [`${id}:${i}`, (change as { type?: string } | null)?.type === 'add' ? 'Write' : 'Edit'])
    }
    case 'Extension':
      return item.kind === 'web.search' ? [[id, 'WebSearch']] : []
    default:
      return []
  }
}

/**
 * One rollout line as the transcript lines the parser reads (none for lines it has no use for).
 * An item's tool_use is written when it starts and again with its result when it completes (the
 * parser skips a tool_use it has seen): current Codex writes only `item_completed`.
 */
export function codexRolloutLineToTranscript(line: string): string[] {
  let entry: { type?: unknown; payload?: Item }
  try {
    entry = JSON.parse(line.trim()) as typeof entry
  } catch {
    return []
  }
  const payload = entry?.payload
  if (entry?.type !== 'event_msg' || !payload) return []
  switch (payload.type) {
    // An empty user message opens the turn without showing anything
    case 'task_started':
      return [user(`turn:${String(payload.turn_id)}`, '')]
    case 'task_complete':
    case 'turn_aborted':
      return [JSON.stringify({ type: 'system', subtype: 'turn_duration' })]
    case 'item_started':
    case 'item_completed':
      break
    default:
      return []
  }

  const item = payload.item as Item | undefined
  if (!item || typeof item !== 'object') return []
  const done = payload.type === 'item_completed'
  if (item.type === 'AgentMessage') {
    if (!done) return []
    const content = Array.isArray(item.content) ? item.content as Array<{ text?: unknown }> : []
    const text = content.map(part => typeof part?.text === 'string' ? part.text : '').join('\n')
    return [assistant(String(item.id), [{ type: 'text', text }])]
  }
  const calls = toolCalls(item)
  if (calls.length === 0) return []
  const lines = [assistant(`${String(item.id)}:use`, calls.map(([id, name]) => ({ type: 'tool_use', id, name })))]
  if (done) {
    const isError = item.status === 'failed'
    lines.push(user(`${String(item.id)}:result`, calls.map(([id]) => ({
      type: 'tool_result', tool_use_id: id, ...(isError ? { is_error: true } : {}),
    }))))
  }
  return lines
}
