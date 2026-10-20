export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const HEADERS = { 'X-JobDuck-Dashboard': '1' }

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { ...HEADERS } }
  if (body !== undefined) {
    init.headers = { ...HEADERS, 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const res = await fetch(path, init)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `${res.status} ${res.statusText}`)
  return data as T
}

export const fetchJSON = <T>(path: string) => request<T>('GET', path)
export const putJSON = <T>(path: string, body: unknown) => request<T>('PUT', path, body)
export const postJSON = <T>(path: string, body?: unknown) => request<T>('POST', path, body)
export const patchJSON = <T>(path: string, body: unknown) => request<T>('PATCH', path, body)
export const deleteJSON = <T>(path: string) => request<T>('DELETE', path)

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
export const isConflict = (error: unknown) => error instanceof ApiError && error.status === 409

export function applicationsPath(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value)
  const text = query.toString()
  return `/api/applications${text ? `?${text}` : ''}`
}
