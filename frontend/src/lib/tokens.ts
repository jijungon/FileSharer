import { api } from './api'

/** 발급된 토큰의 메타데이터(원문은 절대 포함되지 않는다). */
export interface ApiTokenInfo {
  id: string
  label: string
  space_id: string | null
  node_id: string | null
  scope_label: string
  created_at: string | null
  last_used_at: string | null
  expires_at: string | null
}

/** 생성 응답 — 원문(token)은 이때 단 한 번만 내려온다. */
export interface CreatedApiToken extends ApiTokenInfo {
  token: string
  warning: string
}

export interface CreateTokenInput {
  label?: string
  space_id?: string | null
  node_id?: string | null
  expires_in_days?: number | null
  expires_in_minutes?: number | null // 짧은 임시 토큰(분). 서버 업로드 버튼이 사용.
}

export const listTokens = () => api<ApiTokenInfo[]>('/api/tokens')

export const createToken = (input: CreateTokenInput) =>
  api<CreatedApiToken>('/api/tokens', { method: 'POST', body: JSON.stringify(input) })

export const revokeToken = (id: string) =>
  api<{ ok: boolean }>(`/api/tokens/${id}`, { method: 'DELETE' })
