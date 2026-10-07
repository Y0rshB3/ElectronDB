import type { NavicatCandidate } from '@shared/types'
import type { TourStep } from '@shared/tour'

/** A button of a tour step that replaces «Siguiente» (last step of the welcome tour). */
export interface TourAction {
  label: string
  /** 'primary': filled accent button; 'tonal': secondary; 'text': dismiss. */
  variant: 'primary' | 'tonal' | 'text'
  icon?: string
  testId: string
  run: () => void
}

/** A step as the tour host shows it: shared data plus renderer-only extras. */
export interface ActiveTourStep extends TourStep {
  /** Part of `text` shown in monospace (a folder path). */
  code?: string
  /** Buttons that end the tour instead of «Siguiente». */
  actions?: TourAction[]
  testId?: string
  /** Shows the app icon above the title (welcome step). */
  logo?: boolean
}

/** What the last step's buttons do (the tour store wires them to the dialogs). */
export interface WelcomeActions {
  /** «Sí, importar»: the detected folder is right. */
  importFrom: (rootPath: string) => void
  /** «No es esta carpeta»: choose it by hand. */
  chooseFolder: () => void
  newConnection: () => void
  importOther: () => void
  later: () => void
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** «4 conexiones, 3 tareas, 105 copias». */
export function navicatCounts(
  c: Pick<NavicatCandidate, 'connectionCount' | 'jobCount' | 'backupCount'>
): string {
  return [
    plural(c.connectionCount, 'conexión', 'conexiones'),
    plural(c.jobCount, 'tarea', 'tareas'),
    plural(c.backupCount, 'copia', 'copias')
  ].join(', ')
}

/** Feature steps of the welcome tour (1–8). Targets are `data-tour` values. */
export const WELCOME_FEATURE_STEPS: readonly ActiveTourStep[] = [
  {
    title: 'Te damos la bienvenida a Vortaq',
    text: 'Un gestor de bases de datos de escritorio, independiente y de código abierto. Importa tus conexiones y copias desde Navicat, DBeaver, MySQL Workbench o archivos .sql. Te enseñamos lo principal en un minuto.',
    testId: 'tour-welcome',
    logo: true
  },
  {
    target: 'connection-tree',
    title: 'Mis conexiones',
    text: 'Aquí están tus servidores con sus bases de datos, tablas y vistas. Añade uno con el botón «Conexión» de la barra superior.'
  },
  {
    target: ['query-toolbar', 'toolbar-query'],
    title: 'Nueva consulta',
    text: 'Abre un editor SQL con autocompletado, «Formatear SQL» y un selector para cambiar de conexión o de base de datos.'
  },
  {
    target: ['table-filter', 'toolbar-objects'],
    title: 'Datos y filtros',
    text: 'Abre una tabla para ver y editar sus filas. El botón «Filtro» crea condiciones que se leen como frases, sin escribir SQL. Las tablas, vistas y funciones están en «Objetos».'
  },
  {
    target: 'toolbar-backup',
    title: 'Copias de seguridad',
    text: 'Crea copias .nb3 y restáuralas, también las que ya tenías. «Restaurar en Local» lleva una copia a tu conexión local sin tocar el servidor original.'
  },
  {
    target: 'toolbar-automation',
    title: 'Automatización',
    text: 'Programa tareas de copia y restauración que se ejecutan solas, con historial y registro en vivo.'
  },
  {
    target: 'toolbar-ai',
    title: 'Asistente de IA',
    text: 'Pregunta sobre tu base de datos o genera SQL con tu propia clave. Actívalo en Ajustes › IA: solo se envía la estructura, nunca los datos.'
  },
  {
    target: 'toolbar-settings',
    title: 'Ajustes › Seguridad',
    text: 'Producción siempre pide escribir el nombre de la conexión antes de cambiar datos. En Ajustes › Seguridad eliges qué otros entornos lo piden.'
  }
]

/** Last step: import what Navicat has, or create the first connection. */
export function importStep(
  navicat: NavicatCandidate | null,
  actions: WelcomeActions
): ActiveTourStep {
  if (navicat) {
    return {
      title: 'Importar tus datos',
      text: `Se detectó Navicat en ${navicat.rootPath} (${navicatCounts(navicat)}). ¿Es correcto?`,
      code: navicat.rootPath,
      testId: 'tour-import-detected',
      actions: [
        {
          label: 'Sí, importar',
          variant: 'primary',
          icon: 'mdi-import',
          testId: 'tour-import-yes',
          run: () => actions.importFrom(navicat.rootPath)
        },
        {
          label: 'No es esta carpeta',
          variant: 'tonal',
          testId: 'tour-import-other-folder',
          run: actions.chooseFolder
        },
        {
          label: 'Otro gestor o archivo…',
          variant: 'text',
          testId: 'tour-import-other',
          run: actions.importOther
        },
        { label: 'Ahora no', variant: 'text', testId: 'tour-import-later', run: actions.later }
      ]
    }
  }
  return {
    target: 'toolbar-connection',
    title: 'Crea tu primera conexión',
    text: 'Añade un servidor MySQL o importa lo que ya tienes en otro gestor: conexiones de Navicat, DBeaver o MySQL Workbench, y copias .sql o .nb3.',
    testId: 'tour-import-none',
    actions: [
      {
        label: 'Nueva conexión',
        variant: 'primary',
        icon: 'mdi-database-plus-outline',
        testId: 'tour-new-connection',
        run: actions.newConnection
      },
      {
        label: 'Importar desde otro gestor',
        variant: 'tonal',
        testId: 'tour-import-other',
        run: actions.importOther
      },
      { label: 'Ahora no', variant: 'text', testId: 'tour-import-later', run: actions.later }
    ]
  }
}

export function welcomeSteps(
  navicat: NavicatCandidate | null,
  actions: WelcomeActions
): ActiveTourStep[] {
  return [...WELCOME_FEATURE_STEPS, importStep(navicat, actions)]
}
