import { DASHBOARD_VIEWS, type DashboardView, pageUrl, startDashboard } from '../dashboard/server'

export interface DashboardCommandOptions {
  port?: string | number
  open?: boolean
  printUrl?: boolean
  view?: string
  home?: string
  out?: (line: string) => void
  err?: (line: string) => void
}

export async function runDashboard(options: DashboardCommandOptions = {}): Promise<number> {
  const out = options.out ?? ((line: string) => console.log(line))
  const err = options.err ?? ((line: string) => console.error(line))
  const raw = String(options.port ?? 4848)
  const port = Number(raw)
  if (!/^\d+$/.test(raw) || port > 65535) {
    err(`invalid --port: ${options.port}`)
    return 1
  }
  if (options.view !== undefined && !(DASHBOARD_VIEWS as readonly string[]).includes(options.view)) {
    err(`invalid --view: ${options.view} (expected ${DASHBOARD_VIEWS.join(', ')})`)
    return 1
  }
  const view = options.view as DashboardView | undefined
  const dashboard = await startDashboard({ home: options.home, port, open: options.open ?? true, view, out: err })
  const page = pageUrl(dashboard.url, view)
  out(options.printUrl ? page : `Dashboard: ${page}`)
  if (!options.printUrl) out('Press Ctrl+C to stop.')
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      resolve()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
  await dashboard.close()
  return 0
}
