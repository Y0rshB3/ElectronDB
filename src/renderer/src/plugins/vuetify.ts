import 'vuetify/styles'
import { createVuetify, type VuetifyOptions } from 'vuetify'
import { aliases, mdi } from 'vuetify/iconsets/mdi'
import { es } from 'vuetify/locale'

/**
 * Components are registered by vite-plugin-vuetify (autoImport) at build time,
 * so these options intentionally list no components. Tests that need real
 * Vuetify rendering can pass `components` on top of these options.
 *
 * Colours mirror the "Nebula" tokens in styles/tokens.css (Vuetify needs raw
 * hex values; components and areas should prefer the --nd-* variables).
 */
export const vuetifyOptions: VuetifyOptions = {
  // Spanish UI: built-in strings (table footers, "no data", aria labels).
  locale: { locale: 'es', fallback: 'es', messages: { es } },
  icons: { defaultSet: 'mdi', aliases, sets: { mdi } },
  theme: {
    defaultTheme: 'vortaqDark',
    themes: {
      vortaqDark: {
        dark: true,
        colors: {
          background: '#090c13',
          surface: '#0e131c',
          'surface-bright': '#1a2232',
          'surface-light': '#131a26',
          'surface-variant': '#1a2232',
          'on-surface-variant': '#e6edf7',
          'on-background': '#e6edf7',
          'on-surface': '#e6edf7',
          primary: '#22d3ee',
          'on-primary': '#061018',
          secondary: '#8b5cf6',
          'on-secondary': '#ffffff',
          accent: '#8b5cf6',
          success: '#34d399',
          warning: '#fbbf24',
          error: '#f87171',
          info: '#38bdf8'
        },
        variables: {
          'border-color': '#94a3b8',
          'border-opacity': 0.1,
          'high-emphasis-opacity': 1,
          'medium-emphasis-opacity': 0.72,
          'disabled-opacity': 0.42,
          'hover-opacity': 0.06,
          'focus-opacity': 0.1,
          'activated-opacity': 0.1,
          'theme-overlay-multiplier': 1
        }
      },
      vortaqLight: {
        dark: false,
        colors: {
          background: '#f3f5fa',
          surface: '#ffffff',
          'surface-bright': '#ffffff',
          'surface-light': '#f9fafc',
          'surface-variant': '#e9edf4',
          'on-surface-variant': '#0f172a',
          'on-background': '#0f172a',
          'on-surface': '#0f172a',
          primary: '#0891b2',
          'on-primary': '#ffffff',
          secondary: '#7c3aed',
          'on-secondary': '#ffffff',
          accent: '#7c3aed',
          success: '#059669',
          warning: '#d97706',
          error: '#dc2626',
          info: '#0284c7'
        },
        variables: {
          'border-color': '#0f172a',
          'border-opacity': 0.1,
          'high-emphasis-opacity': 1,
          'medium-emphasis-opacity': 0.7,
          'disabled-opacity': 0.42,
          'hover-opacity': 0.04,
          'focus-opacity': 0.08,
          'activated-opacity': 0.08
        }
      }
    }
  },
  defaults: {
    global: { ripple: false },
    VBtn: { density: 'comfortable', variant: 'text' },
    // Labels always sit on the border: no grow/shrink animation when an empty field gains focus.
    VTextField: { density: 'compact', variant: 'outlined', hideDetails: 'auto', active: true },
    VTextarea: { density: 'compact', variant: 'outlined', hideDetails: 'auto', active: true },
    VSelect: { density: 'compact', variant: 'outlined', hideDetails: 'auto', active: true },
    VAutocomplete: { density: 'compact', variant: 'outlined', hideDetails: 'auto', active: true },
    VCombobox: { density: 'compact', variant: 'outlined', hideDetails: 'auto', active: true },
    VCheckbox: { density: 'compact', hideDetails: 'auto', color: 'primary' },
    VSwitch: { density: 'compact', hideDetails: 'auto', color: 'primary', inset: true },
    VDataTable: { density: 'compact', hover: true },
    VTable: { density: 'compact' },
    VList: { density: 'compact' },
    VTooltip: { openDelay: 350, location: 'bottom' },
    VChip: { size: 'small', variant: 'tonal' },
    VTabs: { density: 'compact' },
    VCard: { variant: 'flat' },
    VAlert: { variant: 'tonal', density: 'compact' },
    VProgressLinear: { color: 'primary' }
  }
}

export const vuetify = createVuetify(vuetifyOptions)
