/** Browser-safe Skills wire shapes. Session IDs select authority; clients never send paths. */
import { z } from 'zod'
export const SKILLS_ENDPOINTS = ['skillsList', 'skillsPreview', 'skillsChanges'] as const
export type SkillsEndpoint = typeof SKILLS_ENDPOINTS[number]
const nameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/)
export const skillsRequestSchema = z.object({ sessionId: z.string().min(1), name: nameSchema.optional(), generation: z.number().int().nonnegative().optional() }).strict()
const status = { sessionId: z.string(), generation: z.number().int().nonnegative(), enabled: z.boolean() }
export const skillsStatusSchema = z.object(status)
export const skillsCatalogSchema = z.object({ ...status, skills: z.array(z.object({ name: nameSchema, description: z.string(), modelInvocable: z.boolean() })) })
export const skillsPreviewSchema = z.object({ ...status, name: nameSchema, content: z.string() })
export type SkillsStatusView = z.infer<typeof skillsStatusSchema>
export type SkillsCatalogView = z.infer<typeof skillsCatalogSchema>
export type SkillsPreviewView = z.infer<typeof skillsPreviewSchema>
export interface SkillsResponseMap { skillsList: SkillsCatalogView; skillsPreview: SkillsPreviewView; skillsChanges: SkillsStatusView }
