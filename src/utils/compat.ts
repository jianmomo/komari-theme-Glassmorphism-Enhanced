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

interface CompatibleRecentRecord {
  uuid?: string
  client?: string
  time?: string
  updated_at?: string
  cpu?: number | { usage?: number }
  gpu?: number
  ram?: number | { total?: number, used?: number }
  ram_total?: number
  swap?: number | { total?: number, used?: number }
  swap_total?: number
  load?: number | { load1?: number, load5?: number, load15?: number }
  load5?: number
  load15?: number
  temp?: number
  disk?: number | { total?: number, used?: number }
  disk_total?: number
  net_in?: number
  net_out?: number
  net_total_up?: number
  net_total_down?: number
  network?: { up?: number, down?: number, totalUp?: number, totalDown?: number }
  process?: number
  connections?: number | { tcp?: number, udp?: number }
  connections_udp?: number
  online?: boolean
  uptime?: number
  ping?: NodeStatus['ping']
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function recentTimestamp(record?: CompatibleRecentRecord): number {
  const value = record?.time || record?.updated_at
  const timestamp = value ? new Date(value).getTime() : 0
  return Number.isFinite(timestamp) ? timestamp : 0
}

function latestRecentRecord(records: unknown[]): CompatibleRecentRecord | undefined {
  return records
    .filter((record): record is CompatibleRecentRecord => Boolean(record && typeof record === 'object'))
    .reduce<CompatibleRecentRecord | undefined>((latest, record) => {
      return !latest || recentTimestamp(record) >= recentTimestamp(latest) ? record : latest
    }, undefined)
}

function toClientMap(nodes: Client[]): Record<string, Client> {
  return Object.fromEntries(nodes.filter(node => Boolean(node?.uuid)).map(node => [node.uuid, node]))
}

function normalizeLegacyStatus(uuid: string, record?: CompatibleRecentRecord): NodeStatus {
  const timestamp = recentTimestamp(record)
  const online = record?.online ?? (timestamp > 0 && Date.now() - timestamp < 90_000)
  const cpu = typeof record?.cpu === 'object' ? record.cpu.usage : record?.cpu
  const ram = typeof record?.ram === 'object' ? record.ram.used : record?.ram
  const ramTotal = typeof record?.ram === 'object' ? record.ram.total : record?.ram_total
  const swap = typeof record?.swap === 'object' ? record.swap.used : record?.swap
  const swapTotal = typeof record?.swap === 'object' ? record.swap.total : record?.swap_total
  const load = typeof record?.load === 'object' ? record.load.load1 : record?.load
  const load5 = typeof record?.load === 'object' ? record.load.load5 : record?.load5
  const load15 = typeof record?.load === 'object' ? record.load.load15 : record?.load15
  const disk = typeof record?.disk === 'object' ? record.disk.used : record?.disk
  const diskTotal = typeof record?.disk === 'object' ? record.disk.total : record?.disk_total
  const connections = typeof record?.connections === 'object' ? record.connections.tcp : record?.connections
  const connectionsUdp = typeof record?.connections === 'object' ? record.connections.udp : record?.connections_udp

  return {
    client: record?.client || record?.uuid || uuid,
    time: record?.time || record?.updated_at || '',
    cpu: finite(cpu),
    gpu: finite(record?.gpu),
    ram: finite(ram),
    ram_total: finite(ramTotal),
    swap: finite(swap),
    swap_total: finite(swapTotal),
    load: finite(load),
    load5: finite(load5),
    load15: finite(load15),
    temp: finite(record?.temp),
    disk: finite(disk),
    disk_total: finite(diskTotal),
    net_in: finite(record?.network?.down ?? record?.net_in),
    net_out: finite(record?.network?.up ?? record?.net_out),
    net_total_up: finite(record?.network?.totalUp ?? record?.net_total_up),
    net_total_down: finite(record?.network?.totalDown ?? record?.net_total_down),
    process: finite(record?.process),
    connections: finite(connections),
    connections_udp: finite(connectionsUdp),
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
      const records = await api.getNodeRecentStatus(node.uuid) as unknown[]
      const latest = latestRecentRecord(records)
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
