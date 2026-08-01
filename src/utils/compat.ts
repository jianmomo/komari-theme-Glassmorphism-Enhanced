/**
 * Komari 跨版本数据兼容层。
 *
 * Komari 1.2.5 正处于 REST 到 RPC2 的迁移期。新版优先使用 RPC2；
 * RPC2 不可用或返回结构异常时，自动回退到官方保留的 REST 接口。
 */
import type { PingRecord as ApiPingRecord, PingTask as ApiPingTask } from '@/utils/api'
import type { Client, NodeStatus, PingRecord } from '@/utils/rpc'
import { getSharedApi } from '@/utils/api'
import { getSharedRpc } from '@/utils/rpc'

export interface CompatiblePingTask extends ApiPingTask {
  type?: string
  default_on?: boolean
}

export interface CompatiblePingRecordsResponse {
  records: PingRecord[]
  tasks: CompatiblePingTask[]
}

export interface CompatibleNodesSnapshot {
  clients: Record<string, Client>
  statuses: Record<string, NodeStatus>
}

const RPC_RETRY_INTERVAL_MS = 60_000
let nodeRpcRetryAt = 0
let pingRpcRetryAt = 0

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function toClientMap(nodes: Client[]): Record<string, Client> {
  return Object.fromEntries(nodes.filter(node => Boolean(node?.uuid)).map(node => [node.uuid, node]))
}

function normalizeLegacyStatus(uuid: string, record?: Partial<NodeStatus>): NodeStatus {
  const timestamp = record?.time ? new Date(record.time).getTime() : 0
  const online = Number.isFinite(timestamp) && timestamp > 0 && Date.now() - timestamp < 90_000

  return {
    client: record?.client || uuid,
    time: record?.time || '',
    cpu: finite(record?.cpu),
    gpu: finite(record?.gpu),
    ram: finite(record?.ram),
    ram_total: finite(record?.ram_total),
    swap: finite(record?.swap),
    swap_total: finite(record?.swap_total),
    load: finite(record?.load),
    load5: finite(record?.load5),
    load15: finite(record?.load15),
    temp: finite(record?.temp),
    disk: finite(record?.disk),
    disk_total: finite(record?.disk_total),
    net_in: finite(record?.net_in),
    net_out: finite(record?.net_out),
    net_total_up: finite(record?.net_total_up),
    net_total_down: finite(record?.net_total_down),
    process: finite(record?.process),
    connections: finite(record?.connections),
    connections_udp: finite(record?.connections_udp),
    online,
    uptime: finite(record?.uptime),
    ping: record?.ping,
  }
}

async function getRestNodesSnapshot(): Promise<CompatibleNodesSnapshot> {
  const api = getSharedApi()
  const nodeList = await api.getNodes()
  const clients = toClientMap(nodeList)
  const statuses: Record<string, NodeStatus> = {}

  const recentResults = await Promise.allSettled(
    nodeList.map(async (node) => {
      const records = await api.getNodeRecentStatus(node.uuid)
      const latest = records.at(-1)
      return [node.uuid, normalizeLegacyStatus(node.uuid, latest)] as const
    }),
  )

  for (const result of recentResults) {
    if (result.status === 'fulfilled')
      statuses[result.value[0]] = result.value[1]
  }

  return { clients, statuses }
}

/** 使用最通用的纯文本接口检查后端，避免初始化依赖特定 RPC2 版本。 */
export async function checkKomariHealth(timeout = 5000): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch('/ping', { signal: controller.signal })
    if (!response.ok || (await response.text()).trim() !== 'pong')
      throw new Error(`Unexpected health response: ${response.status}`)
  }
  finally {
    clearTimeout(timer)
  }
}

/** 获取节点元数据和最新状态，RPC2 失败时回退 REST。 */
export async function getCompatibleNodesSnapshot(): Promise<CompatibleNodesSnapshot> {
  if (Date.now() >= nodeRpcRetryAt) {
    try {
      const rpc = getSharedRpc()
      const [clients, statuses] = await Promise.all([
        rpc.getNodes(),
        rpc.getNodesLatestStatus(),
      ])
      nodeRpcRetryAt = 0
      return { clients, statuses }
    }
    catch (error) {
      nodeRpcRetryAt = Date.now() + RPC_RETRY_INTERVAL_MS
      console.warn('[KomariCompat] RPC2 节点接口不可用，已回退 REST。', error)
    }
  }

  return getRestNodesSnapshot()
}

function normalizeRestPingRecord(uuid: string, record: ApiPingRecord): PingRecord {
  return {
    client: record.client || uuid,
    task_id: record.task_id,
    time: record.time,
    value: record.value,
  }
}

async function getRestPingRecords(uuid: string | undefined, hours: number): Promise<CompatiblePingRecordsResponse> {
  const api = getSharedApi()
  const nodeIds = uuid ? [uuid] : (await api.getNodes()).map(node => node.uuid)
  const results = await Promise.allSettled(
    nodeIds.map(async nodeId => ({ nodeId, response: await api.getPingRecords(nodeId, hours) })),
  )
  const records: PingRecord[] = []
  const tasks = new Map<number, CompatiblePingTask>()

  for (const result of results) {
    if (result.status !== 'fulfilled')
      continue

    const { nodeId, response } = result.value
    records.push(...(response.records || []).map(record => normalizeRestPingRecord(nodeId, record)))
    for (const task of response.tasks || [])
      tasks.set(task.id, task)
  }

  return { records, tasks: [...tasks.values()] }
}

/** 获取 Ping 历史；旧版 REST 全局查询会自动合并各节点结果。 */
export async function getCompatiblePingRecords(
  uuid: string | undefined,
  hours: number,
): Promise<CompatiblePingRecordsResponse> {
  if (Date.now() >= pingRpcRetryAt) {
    try {
      const result = await getSharedRpc().getClient().call<CompatiblePingRecordsResponse>(
        'common:getRecords',
        { type: 'ping', uuid, hours },
      )
      pingRpcRetryAt = 0
      return {
        records: result?.records ?? [],
        tasks: result?.tasks ?? [],
      }
    }
    catch (error) {
      pingRpcRetryAt = Date.now() + RPC_RETRY_INTERVAL_MS
      console.warn('[KomariCompat] RPC2 Ping 接口不可用，已回退 REST。', error)
    }
  }

  return getRestPingRecords(uuid, hours)
}
