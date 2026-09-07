import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.mock('@hermes/plugin-sdk', async (importOriginal) => ({
  ...await importOriginal<any>(),
  useValue: () => 'closed',
  useConnectionHealthProviders: () => [],
  usePluginI18n: () => (key: string) => key,
  useQuery: () => ({ data: undefined, isLoading: false, isFetching: false, refetch: vi.fn() })
}))
import { connectionHealthProviders } from '@hermes/plugin-sdk'
import plugin, { buildConnectionRows, loadContributedServices, repairHint, AUTO_PROBE_MCP, ServiceRow, HealthOverview } from './plugin.js'

it('summarizes sign-in separately and counts mixed problems together', () => {
  const t = (key: string, count?: number) => `${key}:${count ?? ''}`
  const summary = { healthy: 7, total: 9, failures: 0, warnings: 2 }
  expect(renderToStaticMarkup(HealthOverview({ summary, t, loading: false, needsAttention: [{ reason: 'auth_required' }, { reason: 'auth_required' }] }))).toContain('signInRequired:2')
  expect(renderToStaticMarkup(HealthOverview({ summary: { ...summary, failures: 1, warnings: 1 }, t, loading: false, needsAttention: [{ reason: 'auth_required' }, { reason: 'unreachable' }] }))).toContain('attentionRequired:2')
})

it('labels the actual repair action without turning guidance into a sign-in link', () => {
  const t = (key: string) => key
  const item = { id: 'mcp:test', name: 'Test', kind: 'mcp', source: 'MCP', tone: 'warn', reason: 'auth_required', detail: 'login required', checkedAt: Date.now(), icon: 'plug', actionPath: '/settings?tab=mcp' }
  expect(renderToStaticMarkup(ServiceRow({ item, t }))).toContain('>signIn<')
  const guidance = { ...item, kind: 'api', actionPath: null, repair: 'github_auth' }
  expect(renderToStaticMarkup(ServiceRow({ item: guidance, t }))).toContain('>showHint<')
  expect(renderToStaticMarkup(ServiceRow({ item: { ...item, reason: 'unreachable' }, t }))).toContain('>openSettings<')
  expect(renderToStaticMarkup(ServiceRow({ item: { ...item, reason: 'healthy', tone: 'good' }, t }))).not.toContain('<button')
})

it('shows the expired-check reason instead of obsolete MCP tool counts', () => {
  const item = { id: 'mcp:test', name: 'Test', kind: 'mcp', source: 'MCP', tone: 'muted', reason: 'stale', detail: '30 tools', checkedAt: 0, icon: 'plug', actionPath: '/skills?tab=mcp' }
  const html = renderToStaticMarkup(ServiceRow({ item, t: (key: string) => key }))
  expect(html).toContain('>reasonStale<')
  expect(html).not.toContain('>30 tools<')
})

const emptyChecks = {
  mcpHealth: undefined, mcpRuntime: [], mcpRuntimeAvailable: false,
  mcpRuntimeCheckedAt: 0, checkedAt: Date.now(), apiCheckedAt: 0
}

it.each([
  ['failed', 'check_failed', 'bad', 'connection failed', true],
  ['connected', 'healthy', 'good', '12 tools', false]
])('prefers available %s MCP runtime over a conflicting cached manual test', (status, reason, tone, detail, ok) => {
  const now = Date.now()
  const rows = buildConnectionRows({
    ...emptyChecks, status: {}, enabledMcp: [{ name: 'test' }], apiServices: [],
    // Retrieval time is not an event time: runtime wins even if the manual check is newer.
    mcpHealth: { test: { ok, needsAuth: false, tools: 30, checkedAt: now } },
    // Public #104527 RPC contract has status, not the retired MCP reason taxonomy.
    mcpRuntime: [{ name: 'test', transport: 'stdio', status, connected: status === 'connected', disabled: false, tools: 12 }],
    mcpRuntimeAvailable: true, mcpRuntimeCheckedAt: now - 1000
  })
  expect(rows[0]).toMatchObject({ reason, tone, detail, checkedAt: now - 1000 })
})

it.each([
  ['missing', true], ['connected', false], ['connecting', true], ['unknown', true]
])('uses cached manual MCP results for %s runtime (available=%s)', (status, available) => {
  const now = Date.now()
  for (const ok of [true, false]) {
    const rows = buildConnectionRows({
      ...emptyChecks, status: {}, enabledMcp: [{ name: 'test' }], apiServices: [],
      mcpHealth: { test: { ok, needsAuth: false, tools: 30, checkedAt: now } },
      mcpRuntime: status === 'missing' ? [] : [{ name: 'test', status, tools: 12 }],
      mcpRuntimeAvailable: available, mcpRuntimeCheckedAt: now - 1000
    })
    expect(rows[0]).toMatchObject({
      reason: ok ? 'healthy' : 'check_failed', tone: ok ? 'good' : 'bad',
      detail: ok ? '30 tools' : 'check failed', checkedAt: now
    })
  }
})

it.each([
  ['missing', true, 'configured'], ['connected', false, 'configured'],
  ['connecting', true, 'connecting'], ['unknown', true, 'configured']
])('keeps %s MCP runtime without a manual check neutral (available=%s)', (status, available, detail) => {
  const rows = buildConnectionRows({
    ...emptyChecks, status: {}, enabledMcp: [{ name: 'test' }], apiServices: [],
    mcpRuntime: status === 'missing' ? [] : [{ name: 'test', status, tools: 12 }],
    mcpRuntimeAvailable: available, mcpRuntimeCheckedAt: Date.now()
  })
  expect(rows[0]).toMatchObject({ reason: 'stale', tone: 'warn', detail })
})

it('registers without probing and preserves local repair guidance across the real SDK boundary', async () => {
  const contributions: any[] = []
  const rest = vi.fn().mockResolvedValue({ services: [{
    id: 'github', name: 'GitHub', reason: 'auth_required',
    detail: 'login required', checked_at: Date.now(), repair: 'github_auth'
  }] })
  plugin.register({ rest, register: (c: any) => contributions.push({ ...c, source: 'plugin:connections' }), i18n: { register: vi.fn(), t: (key: string) => key } })
  expect(rest).not.toHaveBeenCalled()
  expect(AUTO_PROBE_MCP).toBe(false)
  const page = contributions.find(c => c.id === 'page')
  expect(page.data.path).toBe('/connections-health')
  const html = renderToStaticMarkup(page.render())
  expect(html).toContain('gatewayUnavailable')
  expect(html).toContain('gatewayUnavailableHint')
  expect(html).toContain('refresh')
  expect(html).not.toContain('aria-label="connect"')
  expect(rest).not.toHaveBeenCalled()
  const provider = connectionHealthProviders(contributions.filter(c => c.area === 'connections.health'))
  const services = await loadContributedServices(provider)
  const rows = buildConnectionRows({ ...emptyChecks, status: {}, enabledMcp: [], apiServices: services })
  expect(rows[0].reason).toBe('auth_required')
  expect(repairHint(rows[0], (key: string) => key)).toBe('repairGithubAuth')
})

it('excludes internal API servers from profile-merged gateway health', () => {
  const rows = buildConnectionRows({
    status: { gateway_platforms: {
      api_server: { state: 'connected' },
      'default:api_server': { state: 'connected' },
      'default:telegram': { state: 'connected' },
      'raziel-discord:discord': { state: 'connected' }
    } },
    enabledMcp: [], apiServices: [], mcpHealth: undefined,
    mcpRuntime: [], mcpRuntimeAvailable: false, mcpRuntimeCheckedAt: 0,
    checkedAt: Date.now(), apiCheckedAt: 0
  })
  expect(rows.map(row => row.id)).toEqual(['platform:default:telegram', 'platform:raziel-discord:discord'])
})

it('keeps foreign-profile repairs out of the active profile settings', () => {
  const rows = buildConnectionRows({
    ...emptyChecks,
    status: { gateway_platforms: {
      'raziel-discord:discord': { state: 'failed' },
      telegram: { state: 'failed' }
    } }, enabledMcp: [], apiServices: []
  })
  const foreign = rows.find(row => row.id === 'platform:raziel-discord:discord')!
  expect(foreign.actionPath).toBeNull()
  expect(repairHint(foreign, (key: string, ...args: string[]) => [key, ...args].join('|')))
    .toBe('repairProfilePlatform|raziel-discord|Discord')
  expect(rows.find(row => row.id === 'platform:telegram')!.actionPath).toBe('/messaging?platform=telegram')
})

it('explains unavailable local checks through the real SDK without leaking errors', async () => {
  const contributions: any[] = []
  const rest = vi.fn().mockRejectedValue(new Error('HTTP 404 SECRET_TOKEN'))
  plugin.register({ rest, register: (c: any) => contributions.push({ ...c, source: 'plugin:connections' }), i18n: { register: vi.fn(), t: (key: string) => key } })
  const providers = connectionHealthProviders(contributions.filter(c => c.area === 'connections.health'))
  for (const error of ['HTTP 404 SECRET_TOKEN', 'HTTP 500 SECRET_TOKEN', 'timeout SECRET_TOKEN']) {
    rest.mockRejectedValue(new Error(error))
    const services = await loadContributedServices(providers)
    const rows = buildConnectionRows({ ...emptyChecks, status: {}, enabledMcp: [], apiServices: services })
    expect(rows[0].reason).toBe('check_failed')
    expect(rows[0].detail).toBe('localChecksUnavailable')
    expect(repairHint(rows[0], (key: string) => key)).toBe('repairLocalBackend')
    expect(JSON.stringify(rows)).not.toContain('SECRET_TOKEN')
  }
})

it('turns a rejected provider into a neutral error without raw exception data', async () => {
  const services = await loadContributedServices([{ id: 'test', source: 'plugin:test', load: async () => { throw new Error('SECRET_TOKEN') } }])
  expect(services[0].reason).toBe('check_failed')
  expect(JSON.stringify(services)).not.toContain('SECRET_TOKEN')
})
