import z from '@deepseek-ai/schemastery'

import { APPROVAL_MODES, DEFAULT_CONFIG } from './lib/config.js'

export const name = 'dsh-computer'

/** Plugin config schema exposed to DSH. */
export const Config = z.object({
  cursor: z.object({
    enabled: z.boolean().default(DEFAULT_CONFIG.cursor.enabled),
    theme: z.string().default(DEFAULT_CONFIG.cursor.theme),
    idleHideMs: z.number().default(DEFAULT_CONFIG.cursor.idleHideMs),
    glideMs: z.number().default(DEFAULT_CONFIG.cursor.glideMs),
  }),
  approvals: z.object({
    mode: z.union(APPROVAL_MODES).default(DEFAULT_CONFIG.approvals.mode),
  }),
  policy: z.object({
    allowedApps: z.array(z.string()).default(DEFAULT_CONFIG.policy.allowedApps),
    blockedApps: z.array(z.string()).default(DEFAULT_CONFIG.policy.blockedApps),
    maxActionsPerMinute: z.number().default(DEFAULT_CONFIG.policy.maxActionsPerMinute),
  }),
  audit: z.object({
    path: z.string().default(DEFAULT_CONFIG.audit.path),
    includeScreenshots: z.boolean().default(DEFAULT_CONFIG.audit.includeScreenshots),
  }),
  backend: z.object({
    timeoutMs: z.number().default(DEFAULT_CONFIG.backend.timeoutMs),
  }),
  observation: z.object({
    maxElements: z.number().default(DEFAULT_CONFIG.observation.maxElements),
    maxImageDimension: z.number().default(DEFAULT_CONFIG.observation.maxImageDimension),
    ttlMs: z.number().default(DEFAULT_CONFIG.observation.ttlMs),
  }),
})

/** Register the plugin. Tool wiring lands in a later task. */
export function apply(_ctx, _config) {}
