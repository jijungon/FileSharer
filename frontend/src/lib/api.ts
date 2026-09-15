export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** 같은 오리진 API 호출 (세션 쿠키 포함). 2xx가 아니면 ApiError를 던진다. */
export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    // headers는 ...init 뒤에 둔다 — 앞에 두면 init에 headers가 있을 때
    // 스프레드가 Content-Type 병합을 덮어써 버린다.
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null
    throw new ApiError(res.status, body?.detail ?? `요청 실패 (${res.status})`)
  }
  return (await res.json()) as T
}

export interface Me {
  id: string
  email: string
  name: string
  role: 'admin' | 'member'
}

export interface SpaceInfo {
  id: string
  type: 'personal' | 'team' | 'org'
  name: string
}
