/**
 * Connections — live operational overview for Hermes Desktop.
 *
 * Security boundary: this plugin displays connection state and capability
 * metadata only. It never renders credential values, raw environment values,
 * headers, tokens, or backend error payloads.
 */

import {
  Button,
  cn,
  Codicon,
  CONNECTION_HEALTH_AREA,
  GlyphSpinner,
  haptic,
  host,
  ROUTES_AREA,
  ScrollArea,
  SIDEBAR_NAV_AREA,
  StatusDot,
  Tip,
  useConnectionHealthProviders,
  usePluginI18n,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { useMemo } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'connections'
const EMPTY = Object.freeze([])
const SNAPSHOT_KEY = [ID, 'snapshot']
const MCP_HEALTH_KEY = [ID, 'mcp-health']
const CONTRIBUTED_HEALTH_KEY = [ID, 'contributed-health']
const AUTO_PROBE_MCP = false


const NON_CONNECTION_PLATFORMS = new Set(['api_server'])

const KNOWN_NAMES = {
  telegram: 'Telegram',
  discord: 'Discord',
  matrix: 'Matrix',
  lokyy_brain: 'Lokyy Brain',
  'lokyy-brain': 'Lokyy Brain',
  apple_calendar: 'Apple Calendar',
  'apple-calendar': 'Apple Calendar',
  ticktick: 'TickTick',
  github: 'GitHub',
  hevy: 'Hevy',
  supabase: 'Supabase',
  vercel: 'Vercel',
  ponytail: 'Ponytail'
}

const ICONS = {
  telegram: 'send',
  discord: 'comment-discussion',
  matrix: 'symbol-array',
  'lokyy-brain': 'book',
  lokyy_brain: 'book',
  supabase: 'database',
  vercel: 'cloud',
  'apple-calendar': 'calendar',
  apple_calendar: 'calendar',
  ticktick: 'checklist',
  github: 'github',
  hevy: 'heart',
  ponytail: 'sparkle',
  gateway: 'radio-tower'
}

function asArray(value) {
  return Array.isArray(value) ? value : EMPTY
}

function displayName(value) {
  const raw = String(value || '').trim()
  if (!raw) return 'Unknown'
  if (KNOWN_NAMES[raw]) return KNOWN_NAMES[raw]
  return raw
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase())
}

function iconFor(value) {
  return ICONS[String(value || '').toLowerCase()] || 'plug'
}

function safeText(value, fallback = '', maxLength = 240) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return text ? text.slice(0, maxLength) : fallback
}

function internalRoute(value) {
  const path = typeof value === 'string' ? value.trim() : ''
  return path.startsWith('/') && !path.startsWith('//') && path.length <= 256 ? path : null
}

function platformTone(state) {
  const value = String(state || '').toLowerCase()
  if (value === 'connected' || value === 'running' || value === 'open' || value === 'healthy') return 'good'
  if (value === 'connecting' || value === 'retrying' || value === 'starting') return 'warn'
  if (value === 'error' || value === 'failed' || value === 'disconnected' || value === 'stopped') return 'bad'
  return 'muted'
}

function unwrap(result) {
  return result?.result && typeof result.result === 'object' ? result.result : result
}

async function safeRequest(method, params = {}, timeoutMs) {
  try {
    const gateway = timeoutMs && typeof host.getGateway === 'function' ? host.getGateway() : null
    const pending = gateway
      ? gateway.request(method, params, timeoutMs)
      : host.request(method, params)
    return { ok: true, value: unwrap(await pending) }
  } catch {
    // Deliberately do not retain raw backend errors: they can contain paths,
    // URLs, provider responses, or credential-adjacent material.
    return { ok: false, value: null }
  }
}

async function loadSnapshot(profile) {
  const [statusResult, mcpResult, mcpRuntimeResult] = await Promise.allSettled([
    host.status(),
    safeRequest('mcp.servers.list', profile ? { profile } : {}),
    safeRequest('mcp.servers.status', profile ? { profile } : {})
  ])

  if (statusResult.status !== 'fulfilled') throw new Error('status unavailable')

  const status = unwrap(statusResult.value) || {}
  const mcp = mcpResult.status === 'fulfilled' ? mcpResult.value : { ok: false, value: null }
  const mcpRuntime = mcpRuntimeResult.status === 'fulfilled' ? mcpRuntimeResult.value : { ok: false, value: null }

  return {
    status,
    mcpServers: asArray(mcp.value?.servers),
    mcpRuntime: asArray(mcpRuntime.value?.servers),
    mcpRuntimeAvailable: mcpRuntime.ok,
    mcpRuntimeCheckedAt: Number(mcpRuntime.value?.checked_at || 0),
    partial: !mcp.ok || !mcpRuntime.ok,
    checkedAt: Date.now()
  }
}

function platformEntries(value) {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return EMPTY
  return Object.entries(value).map(([name, state]) => ({ name, ...(state || {}) }))
}

function messagingPlatformRoute(value) {
  const platform = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  return platform ? `/messaging?platform=${encodeURIComponent(platform)}` : '/messaging'
}

async function loadApiServices(ctx) {
  const result = await ctx.rest('/services', { timeoutMs: 20000 }).catch(() => ({
    services: [{
      id: 'local-provider', name: 'Connections local APIs', reason: 'check_failed',
      detail: ctx.i18n.t('localChecksUnavailable'), checked_at: Date.now(),
      repair: 'inspect_local_backend'
    }]
  }))
  return asArray(result?.services)
    .filter(service => service?.id && service?.name)
    .map(service => {
      return {
        id: String(service.id),
        name: safeText(service.name, displayName(service.id), 80),
        icon: String(service.id),
        reason: normalizeReason(service.reason),
        detail: safeText(service.detail || service.status, 'unknown'),
        checkedAt: Number(service.checked_at || 0),
        staleAfterMs: STALE_AFTER_MS.api,
        repair: {
          kind: 'message',
          message: repairHint({ reason: normalizeReason(service.reason), repair: String(service.repair || '') }, key => ctx.i18n.t(key))
        }
      }
    })
}

async function loadContributedServices(providers) {
  const loaded = await Promise.allSettled(providers.map(provider => provider.load()))
  const checkedAt = Date.now()

  return loaded.flatMap((result, index) => {
    const provider = providers[index]
    if (result.status === 'rejected') {
      return [{
        id: `provider:${provider.id}`,
        name: provider.name || displayName(provider.id),
        icon: provider.icon,
        reason: 'check_failed',
        detail: 'provider check failed',
        checkedAt,
        repair: provider.repair,
        source: provider.source,
        providerId: provider.id
      }]
    }

    return asArray(result.value)
      .filter(item => item && typeof item === 'object')
      .map(item => ({
        ...item,
        source: provider.source,
        providerId: provider.id
      }))
  })
}

const STALE_AFTER_MS = {
  runtime: 45_000,
  platform: 45_000,
  api: 180_000,
  mcp: 900_000
}

const HEALTH_REASONS = new Set([
  'healthy',
  'auth_required',
  'service_unreachable',
  'permission_required',
  'not_installed',
  'not_configured',
  'stale',
  'check_failed'
])

function normalizeReason(value, fallback = 'check_failed') {
  const reason = String(value || '')
  return HEALTH_REASONS.has(reason) ? reason : fallback
}

function toneForReason(reason) {
  if (reason === 'healthy') return 'good'
  if (reason === 'not_configured' || reason === 'not_installed') return 'muted'
  if (reason === 'auth_required' || reason === 'permission_required' || reason === 'stale') return 'warn'
  return 'bad'
}

function reasonForTone(tone) {
  if (tone === 'good') return 'healthy'
  if (tone === 'bad') return 'service_unreachable'
  if (tone === 'warn') return 'check_failed'
  return 'not_configured'
}

function withFreshness(item, now = Date.now()) {
  const checkedAt = Number(item.checkedAt || 0)
  const staleAfter = Number(item.staleAfterMs || STALE_AFTER_MS[item.kind] || 0)
  if (item.counted !== false && item.tone !== 'muted' && checkedAt > 0 && staleAfter > 0 && now - checkedAt > staleAfter) {
    return { ...item, tone: 'warn', reason: 'stale' }
  }
  return item
}

function relativeAge(checkedAt, t, now = Date.now()) {
  const value = Number(checkedAt || 0)
  if (!value) return t('neverChecked')
  const seconds = Math.max(0, Math.floor((now - value) / 1000))
  if (seconds < 5) return t('checkedNow')
  if (seconds < 60) return t('checkedAgo', `${seconds}s`)
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('checkedAgo', `${minutes}m`)
  return t('checkedAgo', `${Math.floor(minutes / 60)}h`)
}

function reasonLabel(reason, t) {
  const key = {
    healthy: 'reasonHealthy',
    auth_required: 'reasonAuthRequired',
    service_unreachable: 'reasonUnreachable',
    permission_required: 'reasonPermissionRequired',
    not_installed: 'reasonNotInstalled',
    not_configured: 'reasonNotConfigured',
    stale: 'reasonStale',
    check_failed: 'reasonCheckFailed'
  }[reason]
  return t(key || 'reasonCheckFailed')
}

function repairHint(item, t) {
  if (item.reason === 'healthy') return t('noActionRequired')
  if (item.profileName) return t('repairProfilePlatform', item.profileName, displayName(item.platformName))
  if (item.repairMessage) return item.repairMessage
  if (item.reason === 'stale') return t('repairStale')
  const repairKey = {
    apple_permission: 'repairApplePermission',
    github_install: 'repairGithubInstall',
    apple_install: 'repairAppleInstall',
    github_auth: 'repairGithubAuth',
    hevy_auth: 'repairHevyAuth',
    ticktick_auth: 'repairTickTickAuth',
    retry: 'repairUnreachable',
    inspect_plugin_logs: 'repairCheckFailed',
    inspect_local_backend: 'repairLocalBackend'
  }[item.repair]
  if (repairKey) return t(repairKey)
  if (item.actionPath) return t('openSetup')
  if (item.reason === 'service_unreachable') return t('repairUnreachable')
  if (item.reason === 'check_failed') return t('repairCheckFailed')
  return t('repairCheckFailed')
}

function mcpNeedsAuth(server) {
  return server?.auth === 'oauth' && server?.oauth_tokens_present !== true
}

async function testMcpServers(servers, profile) {
  const checks = []

  // Probe sequentially: OAuth-backed MCP clients own task-local locks and can
  // fail spuriously when several connect→tools/list→disconnect cycles overlap.
  for (const server of servers) {
    if (mcpNeedsAuth(server)) {
      checks.push([server.name, {
        ok: false,
        needsAuth: true,
        tools: 0,
        checkedAt: Date.now()
      }])
      continue
    }
    const params = {
      name: server.name,
      ...(profile ? { profile } : {})
    }
    let response = await safeRequest('mcp.servers.test', params, 60000)
    let value = response.value || {}
    let ok = response.ok && (value.ok === true || value.result?.ok === true)
    let errorText = String(value.error || value.result?.error || '')
    let needsAuth = !ok && /\b(401|unauthorized|forbidden|invalid[_ ]?token|authentication|oauth)\b/i.test(errorText)

    // A transient network failure must not stay red until the pane is
    // manually refreshed. Authentication failures are deliberate and should
    // surface immediately; everything else gets one bounded retry.
    if (response.ok && !ok && !needsAuth) {
      await new Promise(resolve => setTimeout(resolve, 750))
      response = await safeRequest('mcp.servers.test', params, 60000)
      value = response.value || {}
      ok = response.ok && (value.ok === true || value.result?.ok === true)
      errorText = String(value.error || value.result?.error || '')
      needsAuth = !ok && /\b(401|unauthorized|forbidden|invalid[_ ]?token|authentication|oauth)\b/i.test(errorText)
    }

    const tools = asArray(value.tools || value.result?.tools)
    checks.push([server.name, {
      ok,
      needsAuth,
      tools: tools.length,
      checkedAt: Date.now()
    }])
  }

  return Object.fromEntries(checks)
}

function healthSummary(items) {
  const checked = items.filter(item => item.counted !== false && item.tone !== 'muted')
  return {
    healthy: checked.filter(item => item.tone === 'good').length,
    total: checked.length,
    warnings: checked.filter(item => item.tone === 'warn').length,
    failures: checked.filter(item => item.tone === 'bad').length
  }
}

function buildConnectionRows({
  status,
  enabledMcp,
  mcpHealth,
  mcpRuntime,
  mcpRuntimeAvailable,
  mcpRuntimeCheckedAt,
  apiServices,
  checkedAt,
  apiCheckedAt
}) {
  const platformRows = platformEntries(status.gateway_platforms)
    .filter(platform => !NON_CONNECTION_PLATFORMS.has(String(platform.name || '').toLowerCase().split(':').at(-1)))
    .map(platform => {
    const tone = platformTone(platform.state || platform.status)
    const separator = String(platform.name || '').lastIndexOf(':')
    const profileName = separator < 0 ? '' : platform.name.slice(0, separator)
    const platformName = separator < 0 ? platform.name : platform.name.slice(separator + 1)
    return {
      id: `platform:${platform.name}`,
      name: displayName(platform.name),
      icon: iconFor(platformName),
      profileName,
      platformName,
      tone,
      reason: reasonForTone(tone),
      detail: String(platform.state || platform.status || 'unknown'),
      source: 'Hermes gateway registry',
      checkedAt,
      kind: 'platform',
      actionPath: profileName ? null : messagingPlatformRoute(platformName)
    }
  })

  const mcpRuntimeByName = new Map(asArray(mcpRuntime).map(server => [server?.name, server]))
  const mcpRows = enabledMcp.map(server => {
    const runtime = mcpRuntimeAvailable ? mcpRuntimeByName.get(server.name) : undefined
    // Runtime checked_at is retrieval time, not event time. Connected/failed
    // runtime wins; connecting/unknown/missing runtime falls back to manual checks.
    const check = runtime?.status === 'connected' || runtime?.status === 'failed'
      ? undefined
      : mcpHealth?.[server.name]
    const needsAuth = mcpNeedsAuth(server)
    const runtimeReason = runtime?.status === 'connected'
      ? 'healthy'
      : runtime?.status === 'failed'
        ? normalizeReason(runtime.reason)
        : 'stale'
    const reason = needsAuth
      ? 'auth_required'
      : check
      ? check.ok ? 'healthy' : check.needsAuth ? 'auth_required' : 'check_failed'
      : mcpRuntimeAvailable && runtime
        ? runtimeReason
        : 'stale'
    const detail = needsAuth || reason === 'auth_required'
      ? 'login required'
      : check
        ? (check.ok ? `${check.tools} tools` : check.needsAuth ? 'login required' : 'check failed')
        : runtime?.status === 'connected'
          ? `${Number(runtime.tools || 0)} tools`
          : runtime?.status === 'connecting'
            ? 'connecting'
            : runtime?.status === 'failed'
              ? 'connection failed'
              : 'configured'
    return {
      id: `mcp:${server.name}`,
      name: displayName(server.name),
      icon: iconFor(server.name),
      tone: toneForReason(reason),
      reason,
      detail,
      source: 'Hermes MCP registry',
      checkedAt: Number(check?.checkedAt || (needsAuth ? checkedAt : mcpRuntimeAvailable ? mcpRuntimeCheckedAt : 0)),
      counted: true,
      kind: 'mcp',
      actionPath: `/skills?tab=mcp&server=${encodeURIComponent(server.name)}`
    }
  })

  const apiRows = asArray(apiServices)
    .filter(service => service?.providerId && service?.id && service?.name)
    .map(service => {
    const reason = normalizeReason(service.reason)
    const repair = service.repair && typeof service.repair === 'object' ? service.repair : null
    const repairRoute = repair?.kind === 'route' ? internalRoute(repair.path) : null
    const repairMessage = repair?.kind === 'message' ? safeText(repair.message, '', 500) : ''
    const legacyRepair = String(service.repairCode || (typeof service.repair === 'string' ? service.repair : ''))
    const providerName = String(service.source || '').replace(/^plugin:/, '')
    return {
      id: `api:${service.providerId}:${service.id}`,
      name: safeText(service.name, displayName(service.id), 80),
      icon: iconFor(service.icon || service.id),
      tone: toneForReason(reason),
      reason,
      repair: legacyRepair,
      repairMessage,
      detail: safeText(service.detail || service.status, 'unknown'),
      source: providerName === ID ? 'Connections local check' : `Plugin ${displayName(providerName)}`,
      checkedAt: Number(service.checkedAt || service.checked_at || apiCheckedAt || 0),
      staleAfterMs: Number(service.staleAfterMs || 0) || undefined,
      counted: !['not_configured', 'not_installed'].includes(reason),
      kind: 'api',
      actionPath: repairRoute,
      canNavigate: Boolean(repairRoute)
    }
  })

  return [
    ...platformRows,
    ...mcpRows,
    ...apiRows
  ].map(item => withFreshness(item))
}

function useConnections() {
  const gateway = useValue(host.state.gateway)
  const profile = useValue(host.state.profile)
  const healthProviders = useConnectionHealthProviders()
  const providerSignature = healthProviders.map(provider => provider.id).sort().join('|')

  const snapshot = useQuery({
    queryKey: [...SNAPSHOT_KEY, profile],
    queryFn: () => loadSnapshot(profile),
    enabled: gateway === 'open',
    refetchInterval: 15000,
    staleTime: 5000,
    retry: 1
  })

  const contributedHealth = useQuery({
    queryKey: [...CONTRIBUTED_HEALTH_KEY, profile, providerSignature],
    queryFn: () => loadContributedServices(healthProviders),
    enabled: gateway === 'open' && healthProviders.length > 0,
    refetchInterval: 60000,
    staleTime: 30000,
    retry: 1
  })

  const enabledMcp = asArray(snapshot.data?.mcpServers).filter(server => server?.enabled !== false && server?.name)
  const mcpSignature = enabledMcp.map(server => server.name).sort().join('|')
  const mcpHealth = useQuery({
    queryKey: [...MCP_HEALTH_KEY, profile, mcpSignature],
    queryFn: () => testMcpServers(enabledMcp, profile),
    enabled: AUTO_PROBE_MCP && gateway === 'open' && enabledMcp.length > 0,
    refetchInterval: 300000,
    staleTime: 300000,
    retry: false
  })

  const data = useMemo(() => {
    const checkedAt = Number(snapshot.data?.checkedAt || 0)
    const checks = buildConnectionRows({
      status: snapshot.data?.status || {},
      enabledMcp,
      mcpHealth: mcpHealth.data,
      mcpRuntime: snapshot.data?.mcpRuntime,
      mcpRuntimeAvailable: snapshot.data?.mcpRuntimeAvailable === true,
      mcpRuntimeCheckedAt: snapshot.data?.mcpRuntimeCheckedAt,
      apiServices: contributedHealth.data,
      checkedAt,
      apiCheckedAt: contributedHealth.dataUpdatedAt
    })
    return {
      checks,
      summary: healthSummary(checks),
      partial: Boolean(snapshot.data?.partial),
      checkedAt: Math.max(checkedAt, contributedHealth.dataUpdatedAt || 0, ...Object.values(mcpHealth.data || {}).map(item => item.checkedAt || 0))
    }
  }, [snapshot.data, mcpHealth.data, contributedHealth.data, contributedHealth.dataUpdatedAt, gateway, mcpSignature, providerSignature])

  const refresh = async () => {
    haptic('tap')
    await Promise.all([snapshot.refetch(), contributedHealth.refetch()])
    if (enabledMcp.length > 0) await mcpHealth.refetch()
  }

  return {
    ...data,
    refresh,
    loading: snapshot.isLoading || contributedHealth.isLoading,
    refreshing: snapshot.isFetching || mcpHealth.isFetching || contributedHealth.isFetching,
    error: snapshot.isError,
    gateway
  }
}

function SectionTitle({ title, count }) {
  return jsxs('div', {
    className: 'flex items-center justify-between px-0.5',
    children: [
      jsx('div', {
        className: 'text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-(--ui-text-tertiary)',
        children: title
      }),
      count == null ? null : jsx('div', {
        className: 'font-mono text-[0.6875rem] tabular-nums text-(--ui-text-tertiary)',
        children: count
      })
    ]
  })
}

function statusSurface(tone) {
  if (tone === 'muted') {
    return {
      color: 'var(--ui-text-secondary)',
      background: 'var(--ui-bg-secondary)',
      borderColor: 'var(--ui-border-subtle)'
    }
  }
  const color = tone === 'bad'
    ? 'var(--ui-red)'
    : tone === 'warn'
      ? 'var(--ui-yellow)'
      : 'var(--ui-green)'
  return {
    color,
    background: `color-mix(in srgb, ${color} 7%, transparent)`,
    borderColor: `color-mix(in srgb, ${color} 24%, var(--ui-border-subtle))`
  }
}

function sourceLabel(item, t) {
  if (item.kind === 'mcp') return 'MCP'
  if (item.kind === 'platform') return t('platform')
  if (item.kind === 'runtime') return t('runtime')
  if (item.source === 'Connections local check') return t('localCheck')
  return item.source
}

export function ServiceRow({ item, t }) {
  const kind = item.kind === 'mcp'
    ? 'MCP'
    : item.kind === 'platform'
      ? t('platform')
      : item.kind === 'api'
        ? t('apiService')
        : t('runtimeService')
  const color = item.tone === 'good'
    ? 'var(--ui-green)'
    : item.tone === 'bad'
      ? 'var(--ui-red)'
      : item.tone === 'warn'
        ? 'var(--ui-yellow)'
        : 'var(--ui-text-tertiary)'
  const reason = reasonLabel(item.reason, t)
  const age = relativeAge(item.checkedAt, t)
  const repair = repairHint(item, t)
  const shouldNavigate = Boolean(item.actionPath)
    && !['healthy', 'stale'].includes(item.reason)
    && (item.kind !== 'api' || item.canNavigate)
    && (item.reason !== 'permission_required' || item.canNavigate)
  const canActivate = shouldNavigate || (item.reason !== 'healthy' && Boolean(repair))
  const action = canActivate ? t(shouldNavigate ? (item.reason === 'auth_required' ? 'signIn' : 'openSettings') : 'showHint') : reason
  const label = [item.name, action, t('sourceLabel', item.source), reason, item.detail, age, repair].filter(Boolean).join('. ')
  const element = canActivate ? 'button' : 'div'

  return jsxs(element, {
    ...(canActivate ? {
      type: 'button',
      onClick: () => {
        haptic('tap')
        if (shouldNavigate) {
          host.navigate(item.actionPath)
          return
        }
        host.notify({ kind: 'info', message: repair })
      }
    } : {}),
    'aria-label': label,
    className: cn(
      'group flex min-h-14 w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left',
      canActivate && 'transition-colors hover:bg-(--chrome-action-hover) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)'
    ),
    children: [
      jsx('div', {
        className: 'grid size-9 shrink-0 place-items-center rounded-md',
        style: {
          color,
          background: `color-mix(in srgb, ${color} 12%, transparent)`
        },
        children: jsx('span', {
          className: `codicon codicon-${item.icon}`,
          style: { color, fontSize: '17px' },
          'aria-hidden': true
        })
      }),
      jsxs('div', {
        className: 'min-w-0 flex-1',
        children: [
          jsx('div', {
            className: 'truncate text-xs font-medium text-foreground',
            children: item.name
          }),
          jsxs('div', {
            className: 'mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[0.6875rem] text-(--ui-text-secondary)',
            children: [
              jsx('span', { className: 'truncate', children: item.reason === 'stale' ? reason : item.detail }),
              jsx('span', { 'aria-hidden': true, children: '·' }),
              jsx('span', { className: 'shrink-0', children: sourceLabel(item, t) }),
              jsx('span', { 'aria-hidden': true, children: '·' }),
              jsx('span', { className: 'shrink-0', children: age })
            ]
          })
        ]
      }),
      jsxs('div', {
        className: 'flex shrink-0 items-center gap-2',
        children: [
          jsx(StatusDot, { tone: item.tone }),
          jsx('span', {
            className: 'text-[0.6875rem] font-medium',
            style: { color },
            children: action
          }),
          canActivate ? jsx(Codicon, {
            name: shouldNavigate ? 'chevron-right' : 'info',
            className: 'text-(--ui-text-tertiary)'
          }) : null
        ]
      }),
      jsx('span', { className: 'sr-only', children: `${kind}: ${item.name}` })
    ]
  })
}

function ServiceList({ items, t }) {
  return jsx('div', {
    className: 'grid gap-x-8 gap-y-1',
    style: { gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))' },
    children: items.map(item => jsx(ServiceRow, { item, t }, item.id))
  })
}

export function HealthOverview({ summary, t, loading, needsAttention = [] }) {
  const tone = loading ? 'muted' : summary.failures ? 'bad' : summary.warnings ? 'warn' : 'good'

  const headline = loading
    ? t('checking')
    : needsAttention.length > 0 && needsAttention.every(item => item.reason === 'auth_required')
    ? t('signInRequired', needsAttention.length)
    : summary.failures + summary.warnings > 0
      ? t('attentionRequired', summary.failures + summary.warnings)
      : t('allOperational')

  return jsxs('div', {
    className: 'flex items-center justify-between gap-4 border-b border-(--ui-border-subtle) px-0.5 pb-4',
    children: [
      jsxs('div', {
        className: 'flex min-w-0 items-center gap-3',
        children: [
          jsx(StatusDot, { tone }),
          jsx('div', { className: 'truncate text-sm font-semibold text-foreground', children: headline })
        ]
      }),
      jsxs('div', {
        className: 'shrink-0 font-mono text-sm font-semibold tabular-nums text-foreground',
        children: [summary.healthy, jsx('span', { className: 'font-normal text-(--ui-text-tertiary)', children: `/${summary.total}` })]
      })
    ]
  })
}

function ConnectionsPane() {
  const t = usePluginI18n(ID)
  const state = useConnections()
  const priority = { bad: 0, warn: 1, muted: 2, good: 3 }
  const checks = [...state.checks].sort((a, b) => priority[a.tone] - priority[b.tone] || a.name.localeCompare(b.name))
  const needsAttention = checks.filter(item => item.tone === 'bad' || item.tone === 'warn')
  const operational = checks.filter(item => item.tone === 'good')
  const inactive = checks.filter(item => item.tone === 'muted')

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col bg-(--ui-bg-primary) text-sm',
    children: [
      jsxs('header', {
        className: 'shrink-0 border-b border-(--ui-border-subtle)',
        children: [jsx('div', {
          className: 'mx-auto flex w-full items-center gap-3 px-5 py-4 md:px-7',
          style: { maxWidth: '1080px' },
          children: jsxs('div', {
            className: 'flex w-full items-center gap-3',
            children: [
              jsx('div', {
                className: 'flex size-9 items-center justify-center',
                children: jsx(Codicon, { name: 'pulse', className: 'text-base text-(--ui-text-secondary)' })
              }),
              jsxs('div', {
                className: 'min-w-0 flex-1',
                children: [
                  jsx('h1', { className: 'text-base font-semibold tracking-[-0.015em]', children: t('title') }),
                  jsx('p', { className: 'mt-0.5 text-[0.6875rem] text-(--ui-text-tertiary)', children: t('subtitle') })
                ]
              }),
              jsxs('div', {
                className: 'flex shrink-0 items-center gap-2',
                children: [
                  jsx(Button, {
                    variant: 'secondary',
                    size: 'sm',
                    'aria-label': t('refresh'),
                    disabled: state.refreshing || state.gateway !== 'open',
                    onClick: state.refresh,
                    children: [
                      state.refreshing ? jsx(GlyphSpinner, { className: 'size-3.5' }) : jsx(Codicon, { name: 'refresh' }),
                      jsx('span', { className: 'text-xs', children: t('refreshShort') })
                    ]
                  })
                ]
              })
            ]
          })
        })]
      }),
      state.gateway !== 'open'
        ? jsxs('div', {
            className: 'mx-auto mt-6 flex w-[calc(100%-2rem)] max-w-[1040px] items-start gap-3 rounded-xl border p-4',
            style: statusSurface(state.gateway === 'connecting' ? 'warn' : 'bad'),
            children: [
              jsx(StatusDot, { tone: state.gateway === 'connecting' ? 'warn' : 'bad', className: 'mt-1' }),
              jsxs('div', { children: [
                jsx('div', { className: 'text-xs font-medium text-foreground', children: t('gatewayUnavailable') }),
                jsx('div', { className: 'mt-1 text-[0.6875rem] text-(--ui-text-secondary)', children: t('gatewayUnavailableHint') })
              ] })
            ]
          })
        : state.error
          ? jsx('div', { className: 'mx-auto mt-6 w-[calc(100%-2rem)] max-w-[1040px] text-xs text-(--ui-red)', children: t('loadFailed') })
          : jsx(ScrollArea, {
              className: 'min-h-0 flex-1',
              children: jsxs('main', {
                className: 'mx-auto w-full space-y-6 px-5 py-5 md:px-7 md:py-6',
          style: { maxWidth: '1080px' },
                children: [
                  jsx(HealthOverview, { summary: state.summary, t, loading: state.loading, needsAttention }),
                  needsAttention.length > 0
                    ? jsxs('section', {
                        className: 'space-y-2',
                        children: [
                          jsx(SectionTitle, { title: t('needsAttention'), count: needsAttention.length }),
                          jsx(ServiceList, { items: needsAttention, t })
                        ]
                      })
                    : null,
                  operational.length > 0
                    ? jsxs('section', {
                        className: 'space-y-2',
                        children: [
                          jsx(SectionTitle, { title: t('operationalServices'), count: operational.length }),
                          jsx(ServiceList, { items: operational, t })
                        ]
                      })
                    : null,
                  inactive.length > 0
                    ? jsxs('section', {
                        className: 'space-y-2',
                        children: [
                          jsx(SectionTitle, { title: t('inactiveServices'), count: inactive.length }),
                          jsx(ServiceList, { items: inactive, t })
                        ]
                      })
                    : null,
                  checks.length === 0 && !state.loading
                    ? jsx('div', {
                        className: 'py-10 text-center text-xs text-(--ui-text-tertiary)',
                        children: t('noConnections')
                      })
                    : null,
                  state.partial
                    ? jsx('div', { className: 'rounded-lg border border-(--ui-border-subtle) px-3 py-2.5 text-[0.6875rem] text-(--ui-text-tertiary)', children: t('partialData') })
                    : null
                ]
              })
            }),
      jsx('footer', {
        className: 'shrink-0 border-t border-(--ui-border-subtle)',
        children: jsx('div', {
          className: 'mx-auto flex w-full items-center justify-between px-5 py-2 text-[0.625rem] text-(--ui-text-tertiary) md:px-7',
          style: { maxWidth: '1080px' },
          children: state.loading || state.refreshing
            ? jsx('span', { children: t('checking') })
            : jsxs('span', { children: [t('lastChecked'), ' ', state.checkedAt ? new Date(state.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'] })
        })
      })
    ]
  })
}

function ConnectionsChip() {
  const t = usePluginI18n(ID)
  const state = useConnections()
  const tone = state.gateway !== 'open'
    ? 'bad'
    : state.summary.failures
      ? 'bad'
      : state.summary.warnings
        ? 'warn'
        : state.summary.total > 0
          ? 'good'
          : 'muted'

  return jsx(Tip, {
    label: t('chipTip'),
    children: jsxs('button', {
      type: 'button',
      'aria-label': t('chipTip'),
      onClick: () => host.navigate('/connections-health'),
      className: cn(
        'inline-flex h-full items-center gap-1.5 px-2 text-[0.6875rem] transition-colors',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground disabled:opacity-60'
      ),
      children: [
        state.refreshing ? jsx(GlyphSpinner, { className: 'size-3' }) : jsx(StatusDot, { tone }),
        jsx('span', { children: t('chip') }),
        jsx('span', { className: 'font-mono tabular-nums', children: `${state.summary.healthy}/${state.summary.total}` })
      ]
    })
  })
}

export { AUTO_PROBE_MCP, buildConnectionRows, loadApiServices, loadContributedServices, mcpNeedsAuth, normalizeReason, repairHint, withFreshness }

export default {
  id: ID,
  name: 'Connections',
  register(ctx) {
    ctx.i18n.register({
      en: {
        title: 'Connections',
        subtitle: 'Live system health',
        refresh: 'Refresh connections',
        refreshShort: 'Refresh',
        refreshTip: 'Run fresh connection checks',
        healthy: 'Healthy',
        healthyShort: 'healthy',
        degraded: 'Degraded',
        unavailable: 'Unavailable',
        configured: 'Enabled',

        checksHealthy: 'checks healthy',
        runtime: 'Runtime',
        runtimeService: 'Runtime',
        apiService: 'API service',
        platform: 'Platform',
        connectedServices: 'Connected services',
        needsAttention: 'Needs attention',
        operationalServices: 'Operational',
        inactiveServices: 'Not active',
        noConnections: 'No active connections were found.',
        localCheck: 'Local check',
        attentionRequired: count => count === 1 ? '1 connection needs attention' : `${count} connections need attention`,
        signInRequired: count => count === 1 ? '1 service needs sign-in' : `${count} services need sign-in`,
        signIn: 'Sign in',
        openSettings: 'Settings',
        showHint: 'Show hint',
        allOperational: 'All connections operational',
        liveStatus: 'Live status',
        overviewHint: 'Hermes checks connected platforms and MCP servers without exposing credentials.',

        gatewayUnavailable: 'Gateway unavailable',
        gatewayUnavailableHint: 'Live checks resume automatically when Hermes reconnects.',
        loadFailed: 'Connection status could not be loaded.',
        partialData: 'Some optional inventories are unavailable. Core health checks are still shown.',
        checking: 'Checking connections…',
        lastChecked: 'Last checked',
        chip: 'Connections',
        chipTip: 'Open connections health',
        openSetup: 'Open setup or login',
        noActionRequired: 'Connected; no action required.',
        sourceLabel: source => `Source: ${source}`,
        checkedNow: 'checked just now',
        checkedAgo: age => `checked ${age} ago`,
        neverChecked: 'not checked yet',
        reasonHealthy: 'Healthy',
        reasonAuthRequired: 'Sign-in required',
        reasonUnreachable: 'Service unreachable',
        reasonPermissionRequired: 'Local permission required',
        reasonNotInstalled: 'CLI or plugin not installed',
        reasonNotConfigured: 'Not configured',
        reasonStale: 'Check expired',
        reasonCheckFailed: 'Health check failed',
        repairStale: 'Press Refresh to run a fresh check.',
        repairUnreachable: 'Check the network connection, then press Refresh.',
        repairCheckFailed: 'Refresh once; if it fails again, inspect the plugin logs.',
        localChecksUnavailable: 'Local API checks unavailable for this profile',
        repairLocalBackend: 'Check that the Connections backend plugin is installed and enabled in this profile. If it is, check its logs and refresh. No credentials were changed.',
        repairProfilePlatform: (profile, platform) => `Switch to profile "${profile}" and check ${platform} in Messaging. This connection belongs to that profile; do not change the current profile’s credentials.`,
        repairGithubAuth: 'Run gh auth login in Terminal.',
        repairGithubInstall: 'Install GitHub CLI, then run gh auth login.',
        repairTickTickAuth: 'Open Plugins and reconnect TickTick.',
        repairHevyAuth: 'Ask Hermes to reconnect Hevy.',
        repairApplePermission: 'Open System Settings → Privacy & Security → Calendars and allow Hermes.',
        repairAppleInstall: 'Open Plugins and install or enable Apple Calendar.'
      },
      de: {
        title: 'Verbindungen',
        subtitle: 'Live-Systemstatus',
        refresh: 'Verbindungen aktualisieren',
        refreshShort: 'Aktualisieren',
        refreshTip: 'Neue Verbindungstests ausführen',
        healthy: 'Erreichbar',
        healthyShort: 'erreichbar',
        degraded: 'Eingeschränkt',
        unavailable: 'Nicht erreichbar',
        configured: 'Aktiviert',

        checksHealthy: 'Prüfungen erfolgreich',
        runtime: 'Laufzeit',
        runtimeService: 'Laufzeit',
        apiService: 'API-Dienst',
        platform: 'Plattform',
        connectedServices: 'Verbundene Dienste',
        needsAttention: 'Aufmerksamkeit erforderlich',
        operationalServices: 'Erreichbar',
        inactiveServices: 'Nicht aktiv',
        noConnections: 'Keine aktiven Verbindungen gefunden.',
        localCheck: 'Lokale Prüfung',
        attentionRequired: count => count === 1 ? '1 Verbindung braucht Aufmerksamkeit' : `${count} Verbindungen brauchen Aufmerksamkeit`,
        signInRequired: count => count === 1 ? '1 Dienst benötigt Anmeldung' : `${count} Dienste benötigen Anmeldung`,
        signIn: 'Anmelden',
        openSettings: 'Einstellungen',
        showHint: 'Hinweis',
        allOperational: 'Alle Verbindungen erreichbar',
        liveStatus: 'Live-Status',
        overviewHint: 'Hermes prüft verbundene Plattformen und MCP-Server, ohne Zugangsdaten anzuzeigen.',

        gatewayUnavailable: 'Gateway nicht erreichbar',
        gatewayUnavailableHint: 'Die Live-Prüfungen starten automatisch nach der Wiederverbindung.',
        loadFailed: 'Der Verbindungsstatus konnte nicht geladen werden.',
        partialData: 'Einige optionale Inventare sind nicht verfügbar. Kernprüfungen werden weiter angezeigt.',
        checking: 'Verbindungen werden geprüft…',
        lastChecked: 'Zuletzt geprüft',
        chip: 'Verbindungen',
        chipTip: 'Verbindungsstatus öffnen',
        openSetup: 'Einrichtung oder Anmeldung öffnen',
        noActionRequired: 'Verbunden; keine Aktion erforderlich.',
        sourceLabel: source => `Quelle: ${source}`,
        checkedNow: 'gerade geprüft',
        checkedAgo: age => `vor ${age} geprüft`,
        neverChecked: 'noch nicht geprüft',
        reasonHealthy: 'Erreichbar',
        reasonAuthRequired: 'Anmeldung erforderlich',
        reasonUnreachable: 'Dienst nicht erreichbar',
        reasonPermissionRequired: 'Lokale Berechtigung fehlt',
        reasonNotInstalled: 'CLI oder Plugin nicht installiert',
        reasonNotConfigured: 'Nicht konfiguriert',
        reasonStale: 'Prüfung abgelaufen',
        reasonCheckFailed: 'Prüfung fehlgeschlagen',
        repairStale: 'Aktualisieren drücken, um neu zu prüfen.',
        repairUnreachable: 'Netzwerk prüfen und danach Aktualisieren drücken.',
        repairCheckFailed: 'Einmal aktualisieren; schlägt es erneut fehl, Plugin-Logs prüfen.',
        localChecksUnavailable: 'Lokale API-Prüfungen für dieses Profil nicht verfügbar',
        repairLocalBackend: 'Prüfe, ob das Connections-Backend-Plugin in diesem Profil installiert und aktiviert ist. Falls ja, prüfe seine Logs und aktualisiere. Zugangsdaten wurden nicht geändert.',
        repairProfilePlatform: (profile, platform) => `Wechsle zum Profil „${profile}“ und prüfe ${platform} unter Messaging. Diese Verbindung gehört zu diesem Profil; ändere nicht die Zugangsdaten des aktuellen Profils.`,
        repairGithubAuth: 'Im Terminal gh auth login ausführen.',
        repairGithubInstall: 'GitHub CLI installieren und danach gh auth login ausführen.',
        repairTickTickAuth: 'Plugins öffnen und TickTick neu verbinden.',
        repairHevyAuth: 'Hermes bitten, Hevy neu zu verbinden.',
        repairApplePermission: 'Systemeinstellungen → Datenschutz & Sicherheit → Kalender öffnen und Hermes erlauben.',
        repairAppleInstall: 'Plugins öffnen und Apple Calendar installieren oder aktivieren.'
      }
    })

    ctx.register({
      id: 'local-health',
      area: CONNECTION_HEALTH_AREA,
      data: {
        name: 'Connections local APIs',
        icon: 'pulse',
        repair: { kind: 'route', path: '/settings?tab=plugins' },
        load: () => loadApiServices(ctx)
      }
    })

    ctx.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: '/connections-health' },
      render: () => jsx(ConnectionsPane, {})
    })

    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      data: { path: '/connections-health', label: 'Connections', codicon: 'pulse' }
    })

    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 125,
      render: () => jsx(ConnectionsChip, {})
    })
  }
}
