import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { APPROVAL_MODES, DEFAULT_CONFIG, normalizeConfig } from './lib/config.js'
import { register } from './lib/host.js'

export const name = 'dsh-computer'

export const inject = ['tools', 'approval']

/**
 * Plugin config schema exposed to DSH.
 * Constraints mirror RULES in `lib/config.js` so every schema-valid value also
 * passes `normalizeConfig()`; keep both in sync when adding fields.
 */
export const Config = z.object({
  cursor: z.object({
    enabled: z.boolean().default(DEFAULT_CONFIG.cursor.enabled),
    theme: z.string().min(1).default(DEFAULT_CONFIG.cursor.theme),
    idleHideMs: z.natural().default(DEFAULT_CONFIG.cursor.idleHideMs),
    glideMs: z.natural().default(DEFAULT_CONFIG.cursor.glideMs),
  }),
  approvals: z.object({
    mode: z.union(APPROVAL_MODES).default(DEFAULT_CONFIG.approvals.mode),
  }),
  policy: z.object({
    allowedApps: z.array(z.string()).default(DEFAULT_CONFIG.policy.allowedApps),
    blockedApps: z.array(z.string()).default(DEFAULT_CONFIG.policy.blockedApps),
    maxActionsPerMinute: z.natural().min(1).default(DEFAULT_CONFIG.policy.maxActionsPerMinute),
  }),
  audit: z.object({
    path: z.string().min(1).default(DEFAULT_CONFIG.audit.path),
    includeScreenshots: z.boolean().default(DEFAULT_CONFIG.audit.includeScreenshots),
  }),
  backend: z.object({
    timeoutMs: z.natural().min(1).default(DEFAULT_CONFIG.backend.timeoutMs),
  }),
  observation: z.object({
    maxElements: z.natural().min(1).default(DEFAULT_CONFIG.observation.maxElements),
    maxImageDimension: z.natural().min(1).default(DEFAULT_CONFIG.observation.maxImageDimension),
    ttlMs: z.natural().min(1).default(DEFAULT_CONFIG.observation.ttlMs),
  }),
})

/** Register the plugin: one `computer` tool with a lazily started cua backend. */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config ?? {})
  const plugin = register(ctx, cfg, { defineTool })
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      void plugin.dispose()
    })
  }
  ctx.logger?.info?.('dsh-computer: computer 工具已注册（后端按需启动）')
}

export default { name, inject, Config, apply }
