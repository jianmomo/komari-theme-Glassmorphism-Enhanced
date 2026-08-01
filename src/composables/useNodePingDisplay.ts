import type { MaybeRefOrGetter } from 'vue'
import type { PingRecord, PingTask } from '@/composables/useNodePingStats'
import { computed, toValue } from 'vue'
import { useNodePingStats } from '@/composables/useNodePingStats'
import { useAppStore } from '@/stores/app'
import { formatDateTime } from '@/utils/helper'

export type NodePingMetric = 'latency' | 'loss'
export type NetworkProtocol = 'ipv4' | 'ipv6'
export type NetworkCarrier = 'mobile' | 'unicom' | 'telecom'

export interface NodePingBar {
  key: string
  className: string
  tooltip: string
}

export interface NodeNetworkQualityRow {
  carrier: NetworkCarrier
  label: string
  dotClass: string
  taskName: string | null
  latency: number | null
  loss: number | null
  latencyDisplay: string
  lossDisplay: string
  latencyBars: NodePingBar[]
  lossBars: NodePingBar[]
  hasData: boolean
}

interface UseNodePingDisplayOptions {
  historyHours?: number
}

const HISTORY_SAMPLE_COUNT = 20
const IPV6_TASK_PATTERN = /ipv6|\bv6\b/i

const CARRIERS: Array<{
  carrier: NetworkCarrier
  label: string
  dotClass: string
  matcher: RegExp
}> = [
  { carrier: 'mobile', label: '移动', dotClass: 'bg-pink-500', matcher: /mobile|cmcc|移动/i },
  { carrier: 'unicom', label: '联通', dotClass: 'bg-blue-500', matcher: /unicom|联通/i },
  { carrier: 'telecom', label: '电信', dotClass: 'bg-emerald-500', matcher: /telecom|电信/i },
]

function getLatencyToneClass(latency: number): string {
  if (latency <= 60)
    return 'bg-emerald-500/90'
  if (latency <= 100)
    return 'bg-lime-500/90'
  if (latency <= 160)
    return 'bg-yellow-400/90'
  if (latency <= 200)
    return 'bg-orange-500/90'
  return 'bg-rose-500/90'
}

function getLossToneClass(loss: number): string {
  if (loss <= 1)
    return 'bg-emerald-500/90'
  if (loss <= 3)
    return 'bg-lime-500/90'
  if (loss <= 6)
    return 'bg-yellow-400/90'
  if (loss <= 9)
    return 'bg-orange-500/90'
  return 'bg-rose-500/90'
}

function average(values: number[]): number | null {
  if (!values.length)
    return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function getTaskProtocol(task: PingTask): NetworkProtocol {
  return IPV6_TASK_PATTERN.test(task.name) ? 'ipv6' : 'ipv4'
}

function buildEmptyBars(metric: NodePingMetric, count: number): NodePingBar[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `${metric}-empty-${index}`,
    className: 'bg-muted-foreground/15',
    tooltip: '暂无检测数据',
  }))
}

function buildMetricBars(records: PingRecord[], metric: NodePingMetric): NodePingBar[] {
  const samples = records
    .map(record => ({ ...record, timestamp: new Date(record.time).getTime() }))
    .filter(record => Number.isFinite(record.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-HISTORY_SAMPLE_COUNT)

  const missingCount = Math.max(0, HISTORY_SAMPLE_COUNT - samples.length)
  const bars = samples.map((record, index): NodePingBar => {
    const failed = record.value < 0
    const value = metric === 'latency' ? record.value : failed ? 100 : 0
    const formattedTime = formatDateTime(record.time, 'HH:mm:ss')

    return {
      key: `${metric}-${record.time}-${record.task_id}-${index}`,
      className: failed
        ? 'bg-rose-500/90'
        : metric === 'latency'
          ? getLatencyToneClass(value)
          : getLossToneClass(value),
      tooltip: failed
        ? `${formattedTime} 检测失败`
        : metric === 'latency'
          ? `${formattedTime} ${Math.round(value)} ms`
          : `${formattedTime} 0.0%`,
    }
  })

  return [...buildEmptyBars(metric, missingCount), ...bars]
}

function buildRow(
  carrierConfig: typeof CARRIERS[number],
  protocol: NetworkProtocol,
  tasks: PingTask[],
  records: PingRecord[],
): NodeNetworkQualityRow {
  const task = tasks.find(item => getTaskProtocol(item) === protocol && carrierConfig.matcher.test(item.name))
  const taskRecords = task ? records.filter(record => record.task_id === task.id) : []
  const successfulValues = taskRecords.filter(record => record.value >= 0).map(record => record.value)
  const latency = average(successfulValues)
  const loss = taskRecords.length
    ? (taskRecords.length - successfulValues.length) / taskRecords.length * 100
    : null

  return {
    carrier: carrierConfig.carrier,
    label: carrierConfig.label,
    dotClass: carrierConfig.dotClass,
    taskName: task?.name ?? null,
    latency,
    loss,
    latencyDisplay: latency === null ? '—' : `${Math.round(latency)} ms`,
    lossDisplay: loss === null ? '—' : `${loss.toFixed(1)}%`,
    latencyBars: buildMetricBars(taskRecords, 'latency'),
    lossBars: buildMetricBars(taskRecords, 'loss'),
    hasData: taskRecords.length > 0,
  }
}

export function useNodePingDisplay(
  uuid: MaybeRefOrGetter<string>,
  protocol: MaybeRefOrGetter<NetworkProtocol> = 'ipv4',
  options: UseNodePingDisplayOptions = {},
) {
  const appStore = useAppStore()

  const pingStatsEnabled = computed(() => appStore.publicSettings?.record_enabled !== false
    && appStore.publicSettings?.ping_record_preserve_time !== 0)

  const pingStatsHours = computed(() => {
    const preserveTime = appStore.publicSettings?.ping_record_preserve_time
    const requestedHours = options.historyHours ?? 1
    if (typeof preserveTime === 'number' && preserveTime > 0)
      return Math.min(preserveTime, requestedHours)
    return requestedHours
  })

  const pingStats = useNodePingStats(uuid, {
    hours: pingStatsHours,
    enabled: pingStatsEnabled,
  })

  const qualityRows = computed(() => CARRIERS.map(carrier => buildRow(
    carrier,
    toValue(protocol),
    pingStats.tasks.value,
    pingStats.records.value,
  )))

  // IP 字段在访客模式下可能被 Komari 隐藏，因此同时从真实记录反推协议能力。
  // 同一协议即使对应多个地址或任务，也只生成一个协议标签。
  const detectedProtocols = computed<NetworkProtocol[]>(() => {
    const taskProtocols = new Map(
      pingStats.tasks.value.map(task => [task.id, getTaskProtocol(task)]),
    )
    const protocols = new Set<NetworkProtocol>()

    for (const record of pingStats.records.value) {
      const taskProtocol = taskProtocols.get(record.task_id)
      if (taskProtocol)
        protocols.add(taskProtocol)
    }

    return (['ipv4', 'ipv6'] as const).filter(protocol => protocols.has(protocol))
  })

  const hasSelectedProtocolData = computed(() => qualityRows.value.some(row => row.hasData))

  // 列表视图继续复用原有汇总历史，不改变其紧凑展示语义。
  const latencyRenderBars = computed(() => {
    const points = pingStats.history.value.slice(-HISTORY_SAMPLE_COUNT)
    if (!points.length)
      return buildEmptyBars('latency', HISTORY_SAMPLE_COUNT)
    const bars = points.map((point, index): NodePingBar => ({
      key: `latency-${point.time}-${index}`,
      className: point.latency === null ? 'bg-rose-500/90' : getLatencyToneClass(point.latency),
      tooltip: point.latency === null
        ? `${formatDateTime(point.time, 'HH:mm:ss')} 检测失败`
        : `${formatDateTime(point.time, 'HH:mm:ss')} ${Math.round(point.latency)} ms`,
    }))
    return [...buildEmptyBars('latency', HISTORY_SAMPLE_COUNT - bars.length), ...bars]
  })

  const lossRenderBars = computed(() => {
    const points = pingStats.history.value.slice(-HISTORY_SAMPLE_COUNT)
    if (!points.length)
      return buildEmptyBars('loss', HISTORY_SAMPLE_COUNT)
    const bars = points.map((point, index): NodePingBar => ({
      key: `loss-${point.time}-${index}`,
      className: point.loss === null ? 'bg-muted-foreground/15' : getLossToneClass(point.loss),
      tooltip: point.loss === null
        ? `${formatDateTime(point.time, 'HH:mm:ss')} N/A`
        : `${formatDateTime(point.time, 'HH:mm:ss')} ${point.loss.toFixed(1)}%`,
    }))
    return [...buildEmptyBars('loss', HISTORY_SAMPLE_COUNT - bars.length), ...bars]
  })

  return {
    pingStats,
    pingStatsEnabled,
    pingStatsHours,
    qualityRows,
    detectedProtocols,
    hasSelectedProtocolData,
    latencyRenderBars,
    lossRenderBars,
  }
}
