#!/usr/bin/env bun
import { Command } from 'commander'
import { runDashboard } from './commands/dashboard'
import { runDoctor } from './commands/doctor'
import { runInit } from './commands/init'
import { runMcp } from './commands/mcp'
import { runSync } from './commands/sync'
import { runUpgrade } from './commands/upgrade'
import { HOST_IDS } from './hosts'
import { PACKAGE_VERSION } from './paths'

const program = new Command()
  .name('jobduck')
  .description('Agent-run job search: local store, profile, and host registration')
  .version(PACKAGE_VERSION)

program
  .command('init')
  .description('Create ~/.jobduck, apply migrations, and register Job Duck with your agent hosts')
  .option('--workspace <dir>', 'project directory for workspace-scoped host files', process.cwd())
  .option('--hosts <list>', `comma-separated hosts (${HOST_IDS.join(',')}); default: detected`)
  .option('--dry-run', 'print the plan and diffs without writing anything')
  .option('--yes', 'apply without asking')
  .action(async (opts: { workspace: string; hosts?: string; dryRun?: boolean; yes?: boolean }) => {
    process.exitCode = await runInit({
      workspace: opts.workspace,
      hosts: opts.hosts?.split(',').map((host) => host.trim()).filter(Boolean),
      dryRun: opts.dryRun,
      yes: opts.yes,
    })
  })

program
  .command('doctor')
  .description('Check the runtime, PATH, the Job Duck home, the database, config files, and host registration')
  .option('--json', 'print the report as JSON')
  .option('--workspace <dir>', 'project directory to check for workspace-scoped host files', process.cwd())
  .action((opts: { json?: boolean; workspace: string }) => {
    process.exitCode = runDoctor({ json: opts.json, workspace: opts.workspace })
  })

program
  .command('dashboard')
  .description('Serve the local applications dashboard on 127.0.0.1')
  .option('--port <n>', 'port to listen on (0 picks a free port)', '4848')
  .option('--no-open', 'do not open a browser')
  .option('--print-url', 'print only the URL')
  .action(async (opts: { port: string; open: boolean; printUrl?: boolean }) => {
    process.exitCode = await runDashboard({ port: opts.port, open: opts.open, printUrl: opts.printUrl })
  })

program
  .command('sync')
  .description('Pull rejection emails from your Apps Script web app, match them to applications, and acknowledge them')
  .option('--dry-run', 'fetch and print the plan without storing or acknowledging anything')
  .option('--json', 'print the result as JSON')
  .action(async (opts: { dryRun?: boolean; json?: boolean }) => {
    process.exitCode = await runSync({ dryRun: opts.dryRun, json: opts.json })
  })

program
  .command('mcp')
  .description('Run the Job Duck MCP server over stdio (started by your agent host)')
  .action(async () => {
    process.exitCode = await runMcp()
  })

program
  .command('upgrade [version]')
  .description('Replace this jobduck binary with the latest (or the given) GitHub release after verifying its SHA-256')
  .option('--check', 'print the current and latest versions without downloading')
  .action(async (version: string | undefined, opts: { check?: boolean }) => {
    process.exitCode = await runUpgrade({ version, check: opts.check })
  })

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
