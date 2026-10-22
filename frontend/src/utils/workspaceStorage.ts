/**
 * 工作区配置的浏览器本地持久化。
 *
 * 后端配置按 session 保存，新标签页/浏览器重启会拿到默认值，
 * 因此额外在 localStorage 中保留一份，加载时覆盖后端默认值并同步回后端。
 */
import type { WorkspaceConfig } from '../types'

/** 工作区配置的 localStorage key（所有标签页共享） */
const WORKSPACE_STORAGE_KEY = 'automatedTest.workspaceConfig'

/** 读取浏览器保存的工作区配置，无效或不存在时返回 null */
export function loadStoredWorkspace(): Partial<WorkspaceConfig> | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Partial<WorkspaceConfig>
  } catch {
    return null
  }
}

/** 保存工作区配置到浏览器（失败不影响页面使用） */
export function saveStoredWorkspace(config: WorkspaceConfig): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(config))
  } catch {
    // 隐私模式/存储已满等场景下静默降级
  }
}

/**
 * 合并后端配置与浏览器配置：以浏览器保存的值为准。
 *
 * 只接受后端已存在且类型一致的字段，避免旧版本或脏数据导致页面异常。
 */
export function mergeWorkspaceConfig(
  server: WorkspaceConfig,
  stored: Partial<WorkspaceConfig> | null,
): WorkspaceConfig {
  if (!stored) return server
  const merged: WorkspaceConfig = { ...server }
  for (const key of Object.keys(server) as Array<keyof WorkspaceConfig>) {
    const value = stored[key]
    if (value !== undefined && typeof value === typeof server[key]) {
      Object.assign(merged, { [key]: value })
    }
  }
  return merged
}

/** 判断两份工作区配置是否不同（用于决定是否需要同步到后端） */
export function isWorkspaceConfigChanged(a: WorkspaceConfig, b: WorkspaceConfig): boolean {
  return JSON.stringify(a) !== JSON.stringify(b)
}
