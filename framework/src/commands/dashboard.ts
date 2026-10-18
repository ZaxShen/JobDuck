import { startDashboard } from '../dashboard/server'

export interface DashboardCommandOptions {
  port?: string | number
  open?: boolean
  printUrl?: boolean
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
  const dashboard = await startDashboard({ home: options.home, port, open: options.open ?? true, out: err })
  out(options.printUrl ? dashboard.url : `Dashboard: ${dashboard.url}`)
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
