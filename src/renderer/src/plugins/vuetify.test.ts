import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { VSelect, VTextField } from 'vuetify/components'
import { vuetify } from './vuetify'

describe('vuetify defaults', () => {
  it('keeps labels floated on empty fields so they do not animate on focus', () => {
    const Host = defineComponent({
      render: () => [
        h(VTextField, { label: 'Nombre', modelValue: '' }),
        h(VSelect, { label: 'Juego de caracteres', items: ['utf8mb4'], modelValue: null })
      ]
    })
    const wrapper = mount(Host, { global: { plugins: [vuetify] } })
    const fields = wrapper.findAll('.v-field')
    expect(fields).toHaveLength(2)
    for (const f of fields) expect(f.classes()).toContain('v-field--active')
  })
})
