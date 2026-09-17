/**
 * Session composer badge: shows the quota/balance of the provider behind the
 * model the session is using — only when that provider has a usage query
 * configured in cc-switch. Renders nothing otherwise (no visual noise).
 *
 * Latency: the badge subscribes to the session's model-selection store, so
 * picking a different model in the composer switches the badge immediately
 * (one fetch, no poll wait). The periodic tick only refreshes the numbers of
 * the model already in use.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { fetchUsage, type UsageResponse } from './api.ts'
import { en, type Dict } from './locales.ts'

const REFRESH_MS = 60_000

/** One session's shared model-selection snapshot (ui-model-selection). */
export interface ModelSelectionSnapshot {
  current: { provider: string; model: string; reasoningEffort?: string } | null
  status: string
}

export interface DirectoryStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): ModelSelectionSnapshot
}

const NOOP_SUBSCRIBE = (): (() => void) => () => {}
const NOOP_SNAPSHOT = (): null => null

/**
 * Last known answer per provider route. Switching models paints the cached
 * value synchronously (no placeholder flash) and refreshes in the background,
 * so flipping between two providers is instant.
 */
const usageCache = new Map<string, { at: number; value: UsageResponse }>()
const CACHE_FRESH_MS = 60_000
const cacheKeyOf = (route: string | undefined): string => route ?? '__default__'

const BADGE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 11,
  lineHeight: '18px',
  padding: '0 8px',
  borderRadius: 999,
  border: '1px solid rgba(128,128,128,0.35)',
  opacity: 0.85,
  whiteSpace: 'nowrap',
  verticalAlign: 'middle',
}

const OK = '#43a25a'
const WARN = '#d99a3a'
const HOT = '#d96a4a'

const heat = (percent: number): string => (percent >= 90 ? HOT : percent >= 70 ? WARN : OK)

function summarize(data: UsageResponse, t: (key: keyof Dict) => string): { text: string; color: string; title: string } | null {
  if (data.configured !== true || data.result === undefined) return null
  const result = data.result
  if (result.kind === 'error') return { text: '⚠', color: WARN, title: result.error }
  if (result.kind === 'plan') {
    const windows = result.windows
    const parts: string[] = []
    const five = windows['fiveHour']
    if (five !== undefined) parts.push(`${t('usage5h')} ${five.percent.toFixed(1)}%`)
    const weekly = windows['weekly']
    if (weekly !== undefined) parts.push(`${t('usageWeekly')} ${weekly.percent.toFixed(1)}%`)
    const monthly = windows['monthly']
    if (monthly !== undefined) parts.push(`${t('usageMonthly')} ${monthly.percent.toFixed(1)}%`)
    if (parts.length === 0) return null
    const worst = Math.max(...Object.values(windows).map((window) => window.percent))
    const resetParts = Object.values(windows)
      .map((window) => window.resetsAt)
      .filter((value): value is string => value !== null)
    const title = `${data.provider ?? ''} · ${parts.join(' · ')}${resetParts.length > 0 ? ` · ${t('usageResets')} ${new Date(resetParts[0]).toLocaleString()}` : ''}`
    return { text: parts.join(' · '), color: heat(worst), title }
  }
  const unit = result.unit ?? ''
  const fmt = (value: number | undefined): string => (value === undefined ? '?' : value >= 100 ? value.toFixed(0) : value.toFixed(2))
  if (result.remaining !== undefined) {
    const total = result.total
    const percent = total !== undefined && total > 0 && result.used !== undefined ? (result.used / total) * 100 : undefined
    const text = `${t('usageRemaining')} ${fmt(result.remaining)}${unit === '' ? '' : ` ${unit}`}`
    const title = `${data.provider ?? ''}${result.planName !== undefined ? ` · ${result.planName}` : ''}${percent !== undefined ? ` · ${t('usageUsed')} ${percent.toFixed(1)}%` : ''}`
    return { text, color: percent !== undefined ? heat(percent) : OK, title }
  }
  if (result.extra !== undefined) return { text: result.extra, color: OK, title: data.provider ?? result.extra }
  return null
}

export function ConversationUsage(props: { sessionId?: string; directory?: DirectoryStore } = {}) {
  const t = (key: keyof Dict): string => (en[key] ?? key) as string
  const store = props.directory
  const selection = useSyncExternalStore(
    store === undefined ? NOOP_SUBSCRIBE : (listener) => store.subscribe(listener),
    store === undefined ? NOOP_SNAPSHOT : () => store.getSnapshot(),
  )
  // The session's chosen provider (a ccs-* route). undefined → let the host
  // resolve the default model (fresh sessions, or shells without the service).
  const route = store === undefined ? undefined : (selection?.current?.provider ?? undefined)
  const [usage, setUsage] = useState<UsageResponse | null>(null)
  const [pending, setPending] = useState(false)
  const requestSeq = useRef(0)

  useEffect(() => {
    const seq = ++requestSeq.current
    const key = cacheKeyOf(route)
    const cached = usageCache.get(key)
    if (cached !== undefined && Date.now() - cached.at < CACHE_FRESH_MS) {
      // Instant paint from the last answer; the fetch below still refreshes it.
      setUsage(cached.value)
      setPending(false)
    } else {
      // Switching models must not keep showing the previous provider's numbers.
      setUsage(null)
      setPending(true)
    }
    const load = async (): Promise<void> => {
      try {
        const response = await fetchUsage(route)
        usageCache.set(key, { at: Date.now(), value: response })
        if (requestSeq.current === seq) {
          setUsage(response)
          setPending(false)
        }
      } catch {
        if (requestSeq.current === seq) setPending(false)
      }
    }
    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [route])

  const summary = usage === null ? null : summarize(usage, t)
  if (summary === null) {
    // While the first query for a freshly picked model is in flight, keep the
    // seat honest with a placeholder instead of the previous provider's value.
    return pending ? <span style={{ ...BADGE, opacity: 0.5 }}>📊 {t('usageLoading')}</span> : null
  }
  return (
    <span style={BADGE} title={summary.title}>
      <span style={{ width: 6, height: 6, borderRadius: 999, background: summary.color, display: 'inline-block' }} />
      {summary.text}
    </span>
  )
}
