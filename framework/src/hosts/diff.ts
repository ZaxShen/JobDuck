type Op = { kind: ' ' | '-' | '+'; line: string }

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push({ kind: ' ', line: a[i++]! }); j++ }
    else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) ops.push({ kind: '-', line: a[i++]! })
    else ops.push({ kind: '+', line: b[j++]! })
  }
  return ops
}

export function unifiedDiff(path: string, before: string | null, after: string, context = 3): string {
  const ops = diffOps(splitLines(before ?? ''), splitLines(after))
  const header = [`--- ${before === null ? '/dev/null' : path}`, `+++ ${path}`]
  const changed = ops.map((op, index) => (op.kind === ' ' ? -1 : index)).filter((index) => index >= 0)
  if (changed.length === 0) return ''

  const hunks: string[] = []
  let start = 0
  while (start < changed.length) {
    let end = start
    while (end + 1 < changed.length && changed[end + 1]! - changed[end]! <= context * 2 + 1) end++
    const from = Math.max(0, changed[start]! - context)
    const to = Math.min(ops.length - 1, changed[end]! + context)
    const slice = ops.slice(from, to + 1)
    let aStart = 0
    let bStart = 0
    for (const op of ops.slice(0, from)) {
      if (op.kind !== '+') aStart++
      if (op.kind !== '-') bStart++
    }
    const aLen = slice.filter((op) => op.kind !== '+').length
    const bLen = slice.filter((op) => op.kind !== '-').length
    const range = (startLine: number, len: number) => `${len === 0 ? startLine : startLine + 1},${len}`
    hunks.push(`@@ -${range(aStart, aLen)} +${range(bStart, bLen)} @@`)
    for (const op of slice) hunks.push(`${op.kind}${op.line}`)
    start = end + 1
  }
  return [...header, ...hunks].join('\n') + '\n'
}
