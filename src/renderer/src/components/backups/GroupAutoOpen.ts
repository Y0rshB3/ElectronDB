import { defineComponent, watch, type PropType } from 'vue'

/** The part of a Vuetify data-table group entry this helper needs. */
export interface TableGroup {
  type: string
  id: string
  value: unknown
}

/**
 * Vuetify's data table starts every group closed and exposes no prop to open
 * them. Rendered inside the table's `top` slot, this renderless helper opens
 * (once each) the groups `shouldOpen` accepts, after render. The backups list
 * uses it for single files (a group of one without header), so they show as
 * plain rows while packages start collapsed.
 */
export default defineComponent({
  name: 'GroupAutoOpen',
  props: {
    groups: { type: Array as PropType<readonly unknown[]>, required: true },
    isGroupOpen: { type: Function as PropType<(group: never) => boolean>, required: true },
    toggleGroup: { type: Function as PropType<(group: never) => void>, required: true },
    shouldOpen: { type: Function as PropType<(group: TableGroup) => boolean>, required: true }
  },
  setup(props) {
    const opened = new Set<string>()
    watch(
      () => props.groups,
      (groups) => {
        for (const entry of groups) {
          const group = entry as TableGroup
          if (group?.type !== 'group' || opened.has(group.id)) continue
          if (!props.shouldOpen(group)) continue
          opened.add(group.id)
          if (!props.isGroupOpen(group as never)) props.toggleGroup(group as never)
        }
      },
      { immediate: true, flush: 'post' }
    )
    return () => null
  }
})
