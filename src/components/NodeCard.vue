<script setup lang="ts">
import type { NetworkProtocol } from '@/composables/useNodePingDisplay'
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue'
import { computed, ref, watch } from 'vue'
import { Badge } from '@/components/ui/badge'
import { CardX } from '@/components/ui/card-x'
import { ProgressThin } from '@/components/ui/progress-thin'
import { useNodePingDisplay } from '@/composables/useNodePingDisplay'
import { useAppStore } from '@/stores/app'
import { formatBytesPerSecondWithConfig, formatBytesWithConfig, formatDateTime, getStatus, getUptimeDays } from '@/utils/helper'
import { getDiskPercentage, getMemoryPercentage, getTrafficUsed, getTrafficUsedPercentage, hasTrafficLimit } from '@/utils/nodeMetricsHelper'
import { getOSImage, getOSName } from '@/utils/osImageHelper'
import { getRegionCode, getRegionDisplayName } from '@/utils/regionHelper'
import { formatCurrencyValue, formatPriceWithCycle, getDaysUntilExpired, getExpireStatus, getRemainingValue, parseTags } from '@/utils/tagHelper'

const props = defineProps<{ node: NodeData }>()
const emit = defineEmits<{ click: [] }>()
const appStore = useAppStore()

interface RemainingInfoTag {
  icon: string
  text?: string
  prefix?: string
  value?: string
  unit?: string
}

const nodeCardXSize = computed(() => appStore.nodeCardSize === 'large' ? 'large' : 'medium')
const nodeCardContentClass = computed(() => appStore.nodeCardSize === 'large' ? 'gap-4' : 'gap-3')
const nodeCardMetricGridClass = 'grid-cols-3'
const nodeCardMetricBoxClass = computed(() => appStore.nodeCardSize === 'compact'
  ? 'px-1.5 py-1.5'
  : 'px-2 py-1.5')

const formatBytes = (bytes: number) => formatBytesWithConfig(bytes, appStore.byteDecimals)
const formatBytesPerSecond = (bytes: number) => formatBytesPerSecondWithConfig(bytes, appStore.byteDecimals)
const offlineTime = computed(() => formatDateTime(props.node.time))

const cpuStatus = computed(() => getStatus(props.node.cpu ?? 0))
const memPercentage = computed(() => getMemoryPercentage(props.node))
const memStatus = computed(() => getStatus(memPercentage.value))
const diskPercentage = computed(() => getDiskPercentage(props.node))
const diskStatus = computed(() => getStatus(diskPercentage.value))

const TUNNEL_TAG_PREFIX = 'tunnel:9929:'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const parsedNodeTags = computed(() => parseTags(props.node.tags))
const tunnelSourceUuid = computed(() => {
  const tag = parsedNodeTags.value.find(item => item.text.trim().toLowerCase().startsWith(TUNNEL_TAG_PREFIX))
  const uuid = tag?.text.trim().slice(TUNNEL_TAG_PREFIX.length) ?? ''
  return UUID_PATTERN.test(uuid) ? uuid : ''
})

const selectedProtocol = ref<NetworkProtocol>('ipv4')
const {
  qualityRows,
  detectedProtocols,
  hasSelectedProtocolData,
  selectedProtocolLoading,
} = useNodePingDisplay(() => props.node.uuid, selectedProtocol, { tunnelSourceUuid })

function hasNetworkTag(tag: string): boolean {
  return parsedNodeTags.value.some(item => item.text.trim().toLowerCase() === tag)
}

function isWarpProtocol(protocol: NetworkProtocol): boolean {
  return hasNetworkTag(`warp:${protocol}`)
}

const availableProtocols = computed<NetworkProtocol[]>(() => {
  const protocols = new Set<NetworkProtocol>(
    detectedProtocols.value.filter(protocol => protocol !== 'ipv4-9929' || tunnelSourceUuid.value),
  )
  if (props.node.ipv4?.trim())
    protocols.add('ipv4')
  if (tunnelSourceUuid.value)
    protocols.add('ipv4-9929')
  if (props.node.ipv6?.trim())
    protocols.add('ipv6')
  return (['ipv4', 'ipv6', 'ipv4-9929'] as const).filter(protocol => protocols.has(protocol))
})

watch(availableProtocols, (protocols) => {
  if (!protocols.includes(selectedProtocol.value))
    selectedProtocol.value = protocols.includes('ipv4') ? 'ipv4' : 'ipv6'
}, { immediate: true })

function getProtocolTitle(protocol: NetworkProtocol): string {
  if (protocol === 'ipv4-9929')
    return 'IPv4 9929线路隧道：三网线路段与 WireGuard 隧道段的同期组合结果'
  const label = protocol === 'ipv4' ? 'IPv4' : 'IPv6'
  if (isWarpProtocol(protocol))
    return `${label} 通过 WARP 出口`
  return `${label} 网络质量`
}

const trafficUsedPercentage = computed(() => getTrafficUsedPercentage(props.node))
const trafficUsed = computed(() => getTrafficUsed(props.node))

// 流量状态颜色
const trafficStatus = computed(() => {
  if (!hasTrafficLimit(props.node))
    return 'success'
  if (trafficUsedPercentage.value >= 95)
    return 'error'
  if (trafficUsedPercentage.value >= 80)
    return 'warning'
  if (trafficUsedPercentage.value >= 60)
    return 'info'
  return 'success'
})

const trafficPercentageClass = computed(() => {
  if (!hasTrafficLimit(props.node))
    return 'text-muted-foreground'
  if (trafficUsedPercentage.value >= 95)
    return 'text-red-500'
  if (trafficUsedPercentage.value >= 80)
    return 'text-orange-500'
  if (trafficUsedPercentage.value >= 60)
    return 'text-yellow-500'
  return 'text-green-600'
})

// 是否显示金额：未登录且开启「未登录隐藏价格」时不显示价格 / 剩余价值，
// 但在线天数、剩余天数等非金额信息仍然展示
const showPrice = computed(() => appStore.isLoggedIn || !appStore.hidePriceWhenLoggedOut)

const uptimeDaysText = computed(() => {
  const days = getUptimeDays(props.node.uptime)
  return appStore.lang === 'zh-CN' ? `在线 ${days} 天` : `${days} days online`
})

const priceText = computed(() => {
  const node = props.node
  if (node.price === 0 || !showPrice.value)
    return ''
  return formatPriceWithCycle(node.price, node.billing_cycle, node.currency, appStore.lang)
})

// 第三列：剩余天数（始终） + 剩余价值（仅在允许显示金额时），带图标与相邻列对齐
const remainingInfoTags = computed<RemainingInfoTag[]>(() => {
  const node = props.node
  if (node.price === 0)
    return []
  const lang = appStore.lang
  const days = getDaysUntilExpired(node.expired_at)
  const status = getExpireStatus(node.expired_at)
  const items: RemainingInfoTag[] = []

  if (status === 'expired') {
    items.push({ icon: 'tabler:calendar-stats', text: lang === 'zh-CN' ? '已过期' : 'Expired' })
  }
  else if (status === 'long_term') {
    items.push({ icon: 'tabler:calendar-stats', text: lang === 'zh-CN' ? '长期' : 'Long-term' })
  }
  else if (lang === 'zh-CN') {
    items.push({ icon: 'tabler:calendar-stats', prefix: '剩余', value: String(days), unit: '天' })
  }
  else {
    items.push({ icon: 'tabler:calendar-stats', prefix: 'left', value: String(days), unit: 'days' })
  }

  if (showPrice.value) {
    const remainingValue = getRemainingValue(node.price, node.billing_cycle, node.expired_at)
    items.push({ icon: 'tabler:coins', text: formatCurrencyValue(remainingValue, node.currency) })
  }
  return items
})

const customTags = computed(() => parsedNodeTags.value
  .filter((tag) => {
    const normalized = tag.text.trim().toLowerCase()
    return !normalized.startsWith('warp:') && !normalized.startsWith('tunnel:')
  })
  .map(tag => tag.text))

function hasRegion(region: string | null | undefined): boolean {
  return Boolean(region?.trim())
}
</script>

<template>
  <CardX
    hoverable
    :size="nodeCardXSize"
    class="node-card w-full cursor-pointer border-none shadow-[0_0_0_3px] shadow-transparent transition-all duration-200 rounded-xl"
    :class="[!props.node.online && '!shadow-red-500/30']"
    @click="emit('click')"
  >
    <!-- 头部：在线点 + 名称 -->
    <template #header>
      <div class="flex items-center gap-2 min-w-0">
        <div class="relative size-2.5 shrink-0">
          <span
            class="size-2.5 rounded-full block"
            :class="props.node.online ? 'bg-green-500' : 'bg-red-500'"
          />
          <span
            class="animate-ping absolute inset-0 rounded-full opacity-60"
            :class="props.node.online ? 'bg-green-500' : 'bg-red-500'"
          />
        </div>
        <span class="text-sm font-bold flex-1 min-w-0 truncate">{{ props.node.name }}</span>
      </div>
    </template>

    <!-- 头部右侧：OS + 国旗 -->
    <template #header-extra>
      <div class="flex gap-1.5 items-center shrink-0">
        <img :src="getOSImage(props.node.os)" :alt="getOSName(props.node.os)" class="size-4">
        <img
          v-if="hasRegion(props.node.region)"
          :src="`/images/flags/${getRegionCode(props.node.region)}.svg`"
          :alt="getRegionDisplayName(props.node.region)"
          class="size-5 shrink-0"
        >
      </div>
    </template>

    <template #default>
      <div class="flex flex-col relative" :class="nodeCardContentClass">
        <!-- 在线天数固定展示，价格独立展示，避免不同主机卡片高度不一致 -->
        <div class="relative z-20 flex items-center gap-1.5 -mt-1 h-[19px] overflow-hidden">
          <span class="shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-slate-500/10 text-muted-foreground leading-tight">
            {{ uptimeDaysText }}
          </span>
          <span
            v-if="priceText"
            class="min-w-0 truncate text-[11px] px-2 py-0.5 rounded-full bg-slate-500/10 text-muted-foreground leading-tight"
          >
            {{ priceText }}
          </span>
        </div>

        <!-- 四项进度条 -->
        <div class="grid grid-cols-2 gap-x-4 gap-y-2.5">
          <!-- CPU -->
          <div class="flex flex-col gap-1">
            <div class="flex justify-between text-xs">
              <span class="text-muted-foreground">CPU</span>
              <span class="tabular-nums font-medium">{{ (props.node.cpu ?? 0).toFixed(1) }}%</span>
            </div>
            <ProgressThin :percentage="props.node.cpu ?? 0" :status="cpuStatus" :height="4" />
            <div class="text-[11px] text-muted-foreground truncate">
              {{ (props.node.load ?? 0).toFixed(2) }}, {{ (props.node.load5 ?? 0).toFixed(2) }}, {{ (props.node.load15 ?? 0).toFixed(2) }}
            </div>
          </div>

          <!-- 内存 -->
          <div class="flex flex-col gap-1">
            <div class="flex justify-between text-xs">
              <span class="text-muted-foreground">内存</span>
              <span class="tabular-nums font-medium">{{ memPercentage.toFixed(1) }}%</span>
            </div>
            <ProgressThin :percentage="memPercentage" :status="memStatus" :height="4" />
            <div class="text-[11px] text-muted-foreground truncate">
              {{ formatBytes(props.node.ram ?? 0) }} / {{ formatBytes(props.node.mem_total ?? 0) }}
            </div>
          </div>

          <!-- 硬盘 -->
          <div class="flex flex-col gap-1">
            <div class="flex justify-between text-xs">
              <span class="text-muted-foreground">硬盘</span>
              <span class="tabular-nums font-medium">{{ diskPercentage.toFixed(1) }}%</span>
            </div>
            <ProgressThin :percentage="diskPercentage" :status="diskStatus" :height="4" />
            <div class="text-[11px] text-muted-foreground truncate">
              {{ formatBytes(props.node.disk ?? 0) }} / {{ formatBytes(props.node.disk_total ?? 0) }}
            </div>
          </div>

          <!-- 流量（分级颜色） -->
          <div class="flex flex-col gap-1">
            <div class="flex justify-between text-xs">
              <span class="text-muted-foreground">流量</span>
              <span class="tabular-nums font-medium" :class="trafficPercentageClass">
                {{ hasTrafficLimit(props.node) ? `${trafficUsedPercentage.toFixed(1)}%` : '∞' }}
              </span>
            </div>
            <ProgressThin :percentage="trafficUsedPercentage" :status="trafficStatus" :height="4" />
            <div class="text-[11px] truncate" :class="trafficUsedPercentage >= 95 ? 'text-red-500' : 'text-muted-foreground'">
              {{ formatBytes(trafficUsed) }}
              <template v-if="hasTrafficLimit(props.node)">
                / {{ formatBytes(props.node.traffic_limit) }}
              </template>
              <template v-else>
                / ∞
              </template>
            </div>
          </div>
        </div>

        <!-- 三列：网速 / 总流量 / 剩余天数+价格或负载 -->
        <div class="grid gap-1.5" :class="nodeCardMetricGridClass">
          <!-- 实时网速 -->
          <div class="flex flex-col gap-0.5 rounded-lg bg-slate-500/5 min-w-0 overflow-hidden" :class="nodeCardMetricBoxClass">
            <div class="text-[11px] text-green-600 flex items-center gap-1">
              <Icon icon="tabler:chevron-up" width="11" height="11" />
              <span class="truncate min-w-0 overflow-hidden">{{ formatBytesPerSecond(props.node.net_out ?? 0) }}</span>
            </div>
            <div class="text-[11px] text-blue-600 flex items-center gap-1">
              <Icon icon="tabler:chevron-down" width="11" height="11" />
              <span class="truncate min-w-0 overflow-hidden">{{ formatBytesPerSecond(props.node.net_in ?? 0) }}</span>
            </div>
          </div>

          <!-- 总流量 -->
          <div class="flex flex-col gap-0.5 rounded-lg bg-slate-500/5 min-w-0 overflow-hidden" :class="nodeCardMetricBoxClass">
            <div class="text-[11px] text-muted-foreground flex items-center gap-1">
              <Icon icon="tabler:upload" width="11" height="11" />
              <span class="truncate min-w-0 overflow-hidden">{{ formatBytes(props.node.net_total_up ?? 0) }}</span>
            </div>
            <div class="text-[11px] text-muted-foreground flex items-center gap-1">
              <Icon icon="tabler:download" width="11" height="11" />
              <span class="truncate min-w-0 overflow-hidden">{{ formatBytes(props.node.net_total_down ?? 0) }}</span>
            </div>
          </div>

          <!-- 第三列：有价格显示剩余天数+价格，否则显示负载 -->
          <div class="flex flex-col gap-0.5 rounded-lg bg-slate-500/5 min-w-0 overflow-hidden" :class="nodeCardMetricBoxClass">
            <template v-if="remainingInfoTags.length">
              <div
                v-for="(item, i) in remainingInfoTags" :key="i"
                class="text-[11px] text-muted-foreground flex items-center gap-0.5"
              >
                <Icon :icon="item.icon" width="11" height="11" class="shrink-0" />
                <span v-if="item.text" class="truncate min-w-0 overflow-hidden">{{ item.text }}</span>
                <template v-else>
                  <span v-if="item.prefix" class="shrink-0">{{ item.prefix }}</span>
                  <span v-if="item.value" class="shrink-0 tabular-nums">{{ item.value }}</span>
                  <span v-if="item.unit" class="shrink-0">{{ item.unit }}</span>
                </template>
              </div>
            </template>
            <template v-else>
              <div class="text-[11px] text-muted-foreground truncate">
                {{ (props.node.load ?? 0).toFixed(2) }}
              </div>
              <div class="text-[11px] text-muted-foreground truncate">
                {{ (props.node.load5 ?? 0).toFixed(2) }} / {{ (props.node.load15 ?? 0).toFixed(2) }}
              </div>
            </template>
          </div>
        </div>

        <!-- 网络质量：按协议展示三网最近 20 次真实检测 -->
        <section
          class="network-quality-module"
          :class="!props.node.online ? 'blur-xs opacity-50' : ''"
          @click.stop
        >
          <header class="network-quality-header">
            <div class="network-quality-title" title="每格表示一个采样时间段；失败率是 TCP 连接失败比例">
              <span>网络质量</span>
              <Icon icon="lucide:info" width="13" height="13" />
            </div>

            <div v-if="availableProtocols.length" class="network-protocol-switch" role="tablist" aria-label="网络协议">
              <button
                v-for="protocol in availableProtocols"
                :key="protocol"
                type="button"
                class="network-protocol-button notranslate"
                translate="no"
                :class="[
                  selectedProtocol === protocol ? 'is-active' : '',
                  protocol === 'ipv4-9929' ? 'is-tunnel' : '',
                ]"
                :title="getProtocolTitle(protocol)"
                :aria-selected="selectedProtocol === protocol"
                @click.stop="selectedProtocol = protocol"
              >
                <span>{{ protocol === 'ipv6' ? 'IPv6' : 'IPv4' }}</span>
                <span v-if="protocol === 'ipv4-9929'" class="network-tunnel-badge">
                  · 隧道
                </span>
                <span v-else-if="isWarpProtocol(protocol)" class="network-warp-badge">
                  WARP
                </span>
              </button>
            </div>
          </header>

          <div v-if="!availableProtocols.length" class="network-quality-empty">
            暂无网络质量数据
          </div>
          <div v-else-if="!hasSelectedProtocolData" class="network-quality-empty">
            {{ selectedProtocolLoading ? '正在加载检测数据' : '等待检测数据' }}
          </div>
          <template v-else>
            <div class="network-quality-panels">
              <div class="network-quality-panel">
                <div class="network-quality-panel-title">
                  延迟
                </div>
                <div v-for="row in qualityRows" :key="`latency-${row.carrier}`" class="network-quality-row">
                  <div class="network-quality-carrier">
                    <span class="network-quality-dot" :class="row.dotClass" />
                    <span>{{ row.label }}</span>
                  </div>
                  <span class="network-quality-value">{{ row.latencyDisplay }}</span>
                  <div class="network-quality-bars" :aria-label="`${row.label}延迟历史`">
                    <span
                      v-for="bar in row.latencyBars"
                      :key="bar.key"
                      class="network-quality-bar"
                      :class="bar.className"
                      :title="bar.tooltip"
                    />
                  </div>
                </div>
              </div>

              <div class="network-quality-panel">
                <div class="network-quality-panel-title">
                  TCP 探测失败率
                </div>
                <div v-for="row in qualityRows" :key="`loss-${row.carrier}`" class="network-quality-row">
                  <div class="network-quality-carrier">
                    <span class="network-quality-dot" :class="row.dotClass" />
                    <span>{{ row.label }}</span>
                  </div>
                  <span class="network-quality-value">{{ row.lossDisplay }}</span>
                  <div class="network-quality-bars" :aria-label="`${row.label} TCP 探测失败率历史`">
                    <span
                      v-for="bar in row.lossBars"
                      :key="bar.key"
                      class="network-quality-bar"
                      :class="bar.className"
                      :title="bar.tooltip"
                    />
                  </div>
                </div>
              </div>
            </div>

            <footer class="network-quality-legend">
              <span><i class="bg-emerald-500/90" />优秀</span>
              <span><i class="bg-lime-500/90" />良好</span>
              <span><i class="bg-yellow-400/90" />一般</span>
              <span><i class="bg-orange-500/90" />较差</span>
              <span><i class="bg-rose-500/90" />差</span>
            </footer>
          </template>
        </section>

        <!-- 自定义标签 -->
        <div v-if="customTags.length > 0" class="flex flex-wrap gap-1">
          <Badge
            v-for="(tag, i) in customTags" :key="i"
            variant="outline"
            class="!text-[11px] rounded-full text-muted-foreground border-muted-foreground/15 px-2 py-0"
          >
            {{ tag }}
          </Badge>
        </div>

        <!-- 离线遮罩 -->
        <div
          v-if="!props.node.online"
          class="absolute inset-0 flex flex-col items-center justify-center z-10 rounded-xl bg-white/20 dark:bg-black/20 backdrop-blur-[2px]"
        >
          <div class="text-sm font-semibold text-destructive">
            离线
          </div>
          <div class="text-[11px] text-muted-foreground mt-1">
            {{ offlineTime }}
          </div>
        </div>
      </div>
    </template>
  </CardX>
</template>

<style scoped>
.node-card {
  position: relative;
  overflow: hidden;
  container-type: inline-size;
}

.network-quality-module {
  overflow: hidden;
  border: 1px solid color-mix(in oklch, var(--border) 78%, transparent);
  border-radius: 10px;
  background: color-mix(in oklch, var(--muted) 24%, transparent);
  padding: 8px;
}

.network-quality-header {
  display: flex;
  min-height: 24px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-bottom: 1px solid color-mix(in oklch, var(--border) 58%, transparent);
  padding-bottom: 6px;
}

.network-quality-title {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--foreground);
  font-size: 11px;
  font-weight: 650;
}

.network-quality-title svg {
  color: var(--muted-foreground);
}

.network-protocol-switch {
  display: inline-flex;
  align-items: center;
  border-radius: 8px;
  background: color-mix(in oklch, var(--muted) 48%, transparent);
  padding: 2px;
}

.network-protocol-button {
  min-width: 38px;
  border: 0;
  border-radius: 6px;
  padding: 4px 7px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  color: var(--muted-foreground);
  font-size: 10px;
  line-height: 1;
  white-space: nowrap;
  transition:
    color 150ms ease,
    background-color 150ms ease;
}

.network-protocol-button.is-tunnel {
  gap: 3px;
  padding-inline: 5px;
}

.network-protocol-button.is-active {
  background: color-mix(in oklch, var(--color-emerald-500) 15%, transparent);
  color: var(--color-emerald-500);
}

.network-warp-badge,
.network-tunnel-badge {
  border-radius: 999px;
  padding: 1px 4px;
  background: color-mix(in oklch, var(--color-violet-500) 17%, transparent);
  color: var(--color-violet-400);
  font-size: 7px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.network-tunnel-badge {
  padding-inline: 0;
  background: transparent;
  color: var(--muted-foreground);
  font-size: 8px;
  font-weight: 600;
  letter-spacing: 0;
}

.network-quality-empty {
  display: grid;
  min-height: 96px;
  place-items: center;
  color: var(--muted-foreground);
  font-size: 11px;
}

.network-quality-panels {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
  padding-top: 8px;
}

.network-quality-panel {
  min-width: 0;
  border: 1px solid color-mix(in oklch, var(--border) 60%, transparent);
  border-radius: 9px;
  background: color-mix(in oklch, var(--background) 38%, transparent);
  padding: 8px;
}

.network-quality-panel-title {
  margin-bottom: 3px;
  border-bottom: 1px solid color-mix(in oklch, var(--border) 55%, transparent);
  padding-bottom: 6px;
  color: var(--muted-foreground);
  font-size: 11px;
}

.network-quality-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas: 'carrier value' 'bars bars';
  align-items: center;
  column-gap: 6px;
  row-gap: 4px;
  min-width: 0;
  padding: 5px 0;
}

.network-quality-carrier {
  grid-area: carrier;
  display: flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  color: var(--foreground);
  font-size: 11px;
}

.network-quality-dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 999px;
}

.network-quality-value {
  grid-area: value;
  color: var(--foreground);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  font-weight: 550;
  text-align: right;
  white-space: nowrap;
}

.network-quality-bars {
  grid-area: bars;
  display: grid;
  grid-template-columns: repeat(20, minmax(1px, 1fr));
  align-items: center;
  gap: 2px;
  min-width: 0;
  height: 12px;
}

.network-quality-bar {
  display: block;
  width: 100%;
  height: 10px;
  border-radius: 1.5px;
}

.network-quality-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 5px 8px;
  min-width: 0;
  padding: 7px 0 0;
  color: var(--muted-foreground);
  font-size: 9px;
  white-space: nowrap;
}

.network-quality-legend span {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.network-quality-legend i {
  display: block;
  width: 7px;
  height: 7px;
  border-radius: 2px;
}

@container (max-width: 330px) {
  .network-quality-panel {
    padding-inline: 5px;
  }

  .network-quality-row {
    column-gap: 4px;
    row-gap: 3px;
  }

  .network-quality-bars {
    gap: 1px;
  }
}
</style>
