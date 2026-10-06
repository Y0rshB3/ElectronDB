import { defineAsyncComponent, h, type Component } from 'vue'
import type { TabKind } from '@renderer/stores/tabs'
import EmptyState from '@renderer/components/common/EmptyState.vue'

/**
 * Maps every tab kind to its lazily loaded view. Each view receives exactly one
 * prop: `tab: WorkspaceTab`.
 */
function lazyView(loader: () => Promise<{ default: Component }>): Component {
  return defineAsyncComponent({
    loader,
    delay: 150,
    loadingComponent: {
      name: 'ViewLoading',
      render: () =>
        h(
          'div',
          { class: 'd-flex justify-center pa-6', role: 'status', 'aria-label': 'Cargando vista' },
          'Cargando…'
        )
    },
    errorComponent: {
      name: 'ViewLoadError',
      render: () =>
        h(EmptyState, {
          icon: 'mdi-alert-circle-outline',
          title: 'No se pudo cargar la vista',
          description:
            'Cierra la pestaña y vuelve a abrirla. Si el problema continúa, revisa el registro (Otros → Registro).'
        })
    }
  })
}

export const VIEW_REGISTRY: Record<TabKind, Component> = {
  objects: lazyView(() => import('./ObjectsView.vue')),
  tableData: lazyView(() => import('./TableDataView.vue')),
  query: lazyView(() => import('./QueryView.vue')),
  tableDesigner: lazyView(() => import('./TableDesignerView.vue')),
  ddlEditor: lazyView(() => import('./DdlEditorView.vue')),
  users: lazyView(() => import('./UsersView.vue')),
  backups: lazyView(() => import('./BackupsView.vue')),
  automation: lazyView(() => import('./AutomationView.vue')),
  jobEditor: lazyView(() => import('./JobEditorView.vue'))
}

export function viewFor(kind: TabKind): Component {
  return VIEW_REGISTRY[kind]
}
