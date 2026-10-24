export const statusLabel = (status: string) => status.replace(/_/g, ' ')
export const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '')
export const stamp = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '')

export function safeUrl(url: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}
