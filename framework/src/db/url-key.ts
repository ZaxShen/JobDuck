const paramName = (param: string) => param.split('=')[0] ?? ''
const paramValue = (param: string, name: string) => param.slice(name.length + 1)

export function urlKey(url: string | null | undefined): string | null {
  let s = (url ?? '').replace(/[\t\r\n]/g, '').trim()
  s = s.split('#')[0] ?? ''
  s = s.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '')

  const m = /^([^/?]*)([^?]*)(?:\?(.*))?$/s.exec(s)
  let host = (m?.[1] ?? '').toLowerCase()
  let path = m?.[2] ?? ''
  const query = m?.[3]

  host = host.replace(/^www\./, '').replace(/:(80|443)$/, '')
  if (host === '') return null
  if (host === 'boards.greenhouse.io') host = 'job-boards.greenhouse.io'

  const params = query ? query.split('&') : []
  path = path.replace(/\/{2,}/g, '/').replace(/\/+$/, '')

  if (/(^|\.)greenhouse\.io$/.test(host) && /\/embed\/job_app$/.test(path)) {
    let ghFor = ''
    let ghToken = ''
    for (const param of params) {
      if (paramName(param) === 'for') ghFor = paramValue(param, 'for')
      else if (paramName(param) === 'token') ghToken = paramValue(param, 'token')
    }
    if (ghFor !== '' && ghToken !== '') return `job-boards.greenhouse.io/${ghFor}/jobs/${ghToken}`
  }

  if (/(^|\.)linkedin\.com$/.test(host)) {
    let linkedinId: string | null = null
    for (const param of params) {
      const value = paramValue(param, 'currentJobId')
      if (paramName(param) === 'currentJobId' && /^\d+$/.test(value)) linkedinId = value
    }
    if (linkedinId !== null) return `${host}/jobs/view/${linkedinId}`
    return host + path.replace(/^\/jobs\/view\/(?:[^/]*-)?(\d+)$/, '/jobs/view/$1')
  }

  if (host === 'jobs.ashbyhq.com') path = path.replace(/\/application$/, '')
  else if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') path = path.replace(/\/apply$/, '')

  const kept = params.filter((param) => {
    const name = paramName(param)
    return name === 'gh_jid' || (name === 'jk' && /(^|\.)indeed\./.test(host))
  })
  if (kept.length > 0) return `${host}${path}?${[...kept].sort().join('&')}`
  return host + path
}
