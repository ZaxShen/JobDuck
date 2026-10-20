type Tree = Record<string, unknown>

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export const getPath = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((node, key) => (node == null ? undefined : (node as Tree)[key]), obj)

export function setPath<T>(obj: T, path: string, value: unknown): T {
  const next = clone(obj) as Tree
  const keys = path.split('.')
  const last = keys.pop()!
  let node = next
  for (const key of keys) {
    if (node[key] == null || typeof node[key] !== 'object') node[key] = {}
    node = node[key] as Tree
  }
  node[last] = value
  return next as T
}

export const splitList = (text: string) => text.split(/[,\n]/).map((part) => part.trim()).filter(Boolean)
