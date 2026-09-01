import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { OUTLINE_CONFIRMATION_ISSUES } from '@deepseek-ai/dsh-bid'

describe('outline-confirmation rule ownership', () => {
  it('registers complete S5 issue metadata', () => {
    for (const definition of Object.values(OUTLINE_CONFIRMATION_ISSUES)) {
      expect(definition.user_visible).toBe(true)
      expect(typeof definition.user_editable).toBe('boolean')
      expect(['shared_structure', 'shared_coverage', 'outline_confirmation']).toContain(definition.owner)
      expect(['reload_draft', 'restore_server_draft', 'focus_section', 'retry_save', 'retry_confirm']).toContain(definition.repair_action)
    }
  })

  it('does not import or call the S4 generation-quality validator', async () => {
    const source = await readFile(new URL('../src/outline-confirmation-validator.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('outline-generation-quality-validator')
    expect(source).not.toContain('validateOutlineGeneration')
    expect(source).not.toContain('validateOutlineGenerationQuality')
  })
})
