import { statSync } from 'node:fs'

export function lines(text: string): string[] {
  const all = text.split('\n')
  if (all.at(-1) === '') all.pop()
  return all
}

export function show(text: string): false {
  for (const line of lines(text)) console.error(`     | ${line}`)
  return false
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function createChecks() {
  let failures = 0
  return {
    get failures() {
      return failures
    },
    fail() {
      failures += 1
    },
    async check(name: string, test: () => boolean | Promise<boolean>): Promise<void> {
      let passed = false
      try {
        passed = await test()
      } catch (error) {
        show(error instanceof Error ? error.message : String(error))
      }
      if (passed) {
        console.log(`ok   ${name}`)
      } else {
        console.error(`FAIL ${name}`)
        failures += 1
      }
    },
  }
}
