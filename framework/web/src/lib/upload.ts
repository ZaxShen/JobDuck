import { postJSON } from '@/lib/api'
import { base64Of } from '@/lib/base64'
import type { InboxUpload } from '@/lib/types'

export async function uploadToInbox(file: File): Promise<InboxUpload> {
  return postJSON<InboxUpload>('/api/inbox', { name: file.name, data: await base64Of(file) })
}
