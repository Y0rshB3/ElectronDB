# ElectronDB

Cliente MySQL de escritorio (Electron + Vue 3 + TypeScript) capaz de leer los datos de Navicat for MySQL:
importa conexiones, colores y trabajos por lotes desde la carpeta de configuración de Navicat, lee y escribe
copias de seguridad en el mismo formato `.nb3` y automatiza backups y restauraciones entre entornos. Funciona
por su cuenta: no necesita Navicat instalado ni los clientes `mysql`/`mysqldump`, porque usa su propio driver.

> ElectronDB es un proyecto independiente, sin relación con PremiumSoft CyberTech Ltd. ni con Navicat, que no lo
> patrocinan ni lo respaldan. Navicat es una marca registrada de su propietario y se menciona solo para describir
> la compatibilidad de formatos.

La interfaz está en español. El código y los comentarios están en inglés.

## Índice

- [Funciones](#funciones)
- [Compatibilidad por sistema operativo](#compatibilidad-por-sistema-operativo)
- [Requisitos](#requisitos)
- [Inicio rápido](#inicio-rápido)
- [Generar un instalador](#generar-un-instalador)
- [Primer uso](#primer-uso)
- [Copias de seguridad y rollback a local](#copias-de-seguridad-y-rollback-a-local)
- [Automatización](#automatización)
- [Dónde se guardan los datos](#dónde-se-guardan-los-datos)
- [Actualizar](#actualizar)
- [Solución de problemas](#solución-de-problemas)
- [Desarrollo](#desarrollo)
- [Seguridad](#seguridad)

## Funciones

- **Conexiones MySQL/MariaDB** con colores, entorno (Local, Staging, Producción, Otro), túnel SSH (contraseña o
  clave privada), SSL, lista de bases de datos personalizada y consultas iniciales de sesión.
- **Explorador de objetos**: tablas, vistas, funciones, procedimientos, eventos y usuarios.
- **Editor de consultas** con autocompletado, formateo de SQL, varias sentencias y resultados editables cuando
  vienen de una sola tabla con clave primaria.
- **Vista de datos** con edición de celdas, `NULL`, alta y baja de filas; los cambios se aplican en una
  transacción y se deshacen todos si falla uno.
- **Diseñador de tablas** (columnas, índices, claves foráneas) y editor DDL de vistas y rutinas.
- **Copias de seguridad `.nb3`**: crear, listar (incluidas las de Navicat, en solo lectura), restaurar en
  cualquier conexión y "rollback a local".
- **Automatización**: trabajos con pasos de backup y de SQL, programador tipo cron, historial y registro de
  ejecución.
- **Importación desde Navicat**: conexiones, colores, trabajos por lotes y copias existentes. Es de solo
  lectura: no modifica nada de Navicat.
- **Protección de producción**: toda escritura sobre una conexión marcada como Producción pide confirmación
  explícita.
- Tema oscuro y claro.

## Compatibilidad por sistema operativo

El desarrollo y las pruebas diarias se hacen en macOS. Windows y Linux compilan y empaquetan, pero todavía no se
han probado a fondo en un equipo real: trátalos como **experimentales**.

| Función                                  | macOS                           | Windows                                        | Linux                                            |
| ---------------------------------------- | ------------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| Ejecutar desde el código (`npm run dev`) | Sí                              | Sí (experimental)                              | Sí (experimental)                                |
| Instalador                               | `.dmg` y `.zip` (sin firmar)    | Instalador NSIS y `.exe` portable (sin firma)  | AppImage y `.deb`                                |
| Conexiones, consultas, datos, diseñador  | Sí                              | Sí                                             | Sí                                               |
| Copias `.nb3` (crear, leer, restaurar)   | Sí                              | Sí                                             | Sí                                               |
| Importar desde Navicat                   | Sí, detección automática        | Solo copiando la carpeta de un Mac (ver abajo) | Solo copiando la carpeta de un Mac (ver abajo)   |
| Recuperar contraseñas de Navicat         | Sí, desde el Llavero (Keychain) | **No**: escríbelas a mano                      | **No**: escríbelas a mano                        |
| Trabajos programados con la app abierta  | Sí                              | Sí                                             | Sí                                               |
| Trabajos programados con la app cerrada  | Sí (launchd)                    | **No** de forma integrada (ver Automatización) | **No** de forma integrada (ver Automatización)   |
| Cifrado de contraseñas guardadas         | Llavero de macOS                | DPAPI de Windows                               | libsecret / KWallet; **sin llavero, sin cifrar** |

Limitaciones conocidas fuera de macOS:

- Navicat para Windows guarda sus conexiones en el Registro y Navicat para Linux en otra carpeta; ElectronDB
  todavía no lee ninguno de los dos formatos. Solo entiende la carpeta `Navicat CC` de macOS, así que fuera de
  macOS la ruta de importación empieza vacía y el diálogo explica cómo usar una copia de esa carpeta.
- La barra de herramientas hace de barra de título: en macOS lleva los semáforos a la izquierda y en
  Windows/Linux los botones nativos de minimizar, maximizar y cerrar a la derecha, con los colores del tema.
- La opción **"Ejecutar aunque la app esté cerrada"** de un trabajo solo existe en macOS. En Windows y Linux
  aparece desactivada (al pasar el ratón explica la alternativa) y la app nunca escribe en
  `~/Library/LaunchAgents`. Un trabajo que la tenga activada (por ejemplo, copiado de un Mac) se ejecuta con
  el programador interno mientras la app está abierta.
- Los textos de ayuda dicen `Cmd`; en Windows y Linux usa `Ctrl` en su lugar.

## Requisitos

| Requisito | Versión                                                           | Notas                                                      |
| --------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| Node.js   | **24 LTS** recomendada (la usada en desarrollo); mínimo **22.12** | Trae `npm`. Con Node 20 Electron no se puede descargar.    |
| Git       | Cualquiera reciente                                               | Para clonar y actualizar.                                  |
| Docker    | Opcional                                                          | Solo para el MySQL desechable de los tests de integración. |

Sistemas: macOS 13 (Ventura) o posterior (Apple Silicon o Intel), Windows 10/11 de 64 bits, Linux de escritorio
de 64 bits (por ejemplo Ubuntu 22.04+, Debian 12+, Fedora 41+).

Después de instalar Node, comprueba la versión con `node -v`: debe ser `v22.12.0` o superior (ideal `v24.x`).
El repositorio incluye un `.nvmrc` con `24`, así que con `nvm` basta `nvm install` y `nvm use` dentro de la
carpeta del proyecto (nvm-windows no lee `.nvmrc`: indica la versión, `nvm install 24`).

No hace falta instalar compiladores (Visual Studio Build Tools, Python, Xcode, `make`). La única dependencia
nativa (`cpu-features`, una aceleración opcional de `ssh2`) puede fallar al compilarse durante `npm ci` y
mostrar errores de `node-gyp`: es normal, la instalación termina bien y los túneles SSH funcionan igual.

### macOS

Opción A, con Homebrew. `node@24` no se añade solo al `PATH`, por eso la segunda línea:

```sh
brew install node@24 git
echo 'export PATH="$(brew --prefix node@24)/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
node -v   # v24.x
```

Opción B, con un gestor de versiones (fnm). Necesita una línea en `~/.zshrc` antes de usarlo:

```sh
brew install fnm git
echo 'eval "$(fnm env --use-on-cd --shell zsh)"' >> ~/.zshrc
source ~/.zshrc
fnm install 24
fnm default 24
node -v   # v24.x
```

Si no tienes Homebrew, Git viene con las herramientas de línea de comandos de Xcode: `xcode-select --install`.

### Windows (PowerShell)

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
# Cierra y vuelve a abrir la terminal, luego comprueba:
node -v
npm -v
```

Alternativa con varias versiones de Node (nvm-windows):

```powershell
winget install --id CoreyButler.NVMforWindows -e
# Nueva terminal:
nvm install 24
nvm use 24
```

Si PowerShell bloquea `npm` con un error de "ejecución de scripts deshabilitada", ejecuta una vez
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` o usa `cmd`.

### Linux (Debian/Ubuntu)

```sh
sudo apt update && sudo apt install -y git curl
# Node con nvm (sin sudo, por usuario)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# Abre una terminal nueva:
nvm install 24
nvm use 24
```

En una instalación mínima (sin escritorio completo) Electron puede necesitar estas bibliotecas:

```sh
sudo apt install -y libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2t64 libsecret-1-0
# En Ubuntu 22.04 / Debian 12 el paquete de audio se llama libasound2
```

En Fedora instala `git` y `curl` con `sudo dnf install -y git curl` y usa los mismos pasos de `nvm`. El paquete
`nodejs` de Fedora 40 y anteriores es Node 20 y no sirve; si usas el de tu distribución, comprueba que `node -v`
sea 22.12 o superior.

## Inicio rápido

```sh
git clone https://github.com/Y0rshB3/ElectronDB.git
cd ElectronDB
npm ci
npm run dev
```

- `npm ci` instala exactamente las versiones de `package-lock.json`.
- `npm run dev` compila y abre la app con recarga en caliente. **La primera vez** descarga Electron (unos
  100 MB) y muestra `Downloading Electron binary...`; tarda un poco más. La terminal debe quedar abierta mientras
  usas la app; `Ctrl+C` la cierra.

Si te pasaron el código como `.zip` en lugar de clonarlo, descomprímelo, entra en la carpeta con `cd` y sigue
desde `npm ci`. Si estás detrás de un proxy, mira [Descargas detrás de un proxy](#descargas-detrás-de-un-proxy).

Para usarla a diario sin la terminal abierta, genera un instalador (siguiente sección).

## Generar un instalador

Compila **en el mismo sistema operativo** al que va destinado el instalador. Los archivos quedan en `release/`.

| Sistema | Comando              | Resultado en `release/`                                                         |
| ------- | -------------------- | ------------------------------------------------------------------------------- |
| macOS   | `npm run dist:mac`   | `.dmg` y `.zip` para la arquitectura del Mac que compila                        |
| Windows | `npm run dist:win`   | `* Setup <versión>.exe` (instalador) y `<nombre> <versión>.exe` (portable), x64 |
| Linux   | `npm run dist:linux` | `.AppImage` y `.deb`, x64                                                       |
| Actual  | `npm run dist`       | Los formatos del sistema en el que lo ejecutas                                  |

Notas:

- Para un Mac con otro procesador: `npm run dist:mac -- --x64` (Intel) o `npm run dist:mac -- --universal`.
- Desde un Mac se pueden generar las carpetas sin instalador de Windows/Linux
  (`npx electron-builder --win dir --x64`, `--linux dir --x64`). Los instaladores NSIS y AppImage desde un Mac
  con Apple Silicon necesitan Rosetta 2; lo más sencillo es compilarlos en Windows o Linux.
- La app usa el icono genérico de Electron hasta que se añada uno en `build/`.

### Aplicación sin firmar: primer arranque

Los instaladores no están firmados con un certificado de Apple ni de Microsoft, así que el sistema avisa la
primera vez:

- **macOS (Gatekeeper)**: arrastra la app a **Aplicaciones** y, antes de abrirla, quita la marca de
  "descargado de internet" que macOS pone a lo que llega por navegador, AirDrop o chat. Es la solución que
  funciona en todos los casos, incluidos los avisos "**está dañada y no se puede abrir**" y "**no se ha podido
  verificar**":

  ```sh
  xattr -dr com.apple.quarantine "/Applications/ElectronDB.app"
  ```

  Sin terminal: intenta abrirla una vez, ve a **Ajustes del Sistema → Privacidad y seguridad** y pulsa
  **Abrir igualmente** (en macOS 13 y 14 también vale clic derecho sobre la app → **Abrir** → **Abrir**).

- **Windows (SmartScreen)**: en "Windows protegió su PC" pulsa **Más información → Ejecutar de todas formas**.
- **Linux (AppImage)**: dale permiso de ejecución. En Ubuntu 22.04+ las AppImage necesitan `libfuse2`
  (`libfuse2t64` en 24.04):

  ```sh
  chmod +x ElectronDB-*.AppImage
  sudo apt install -y libfuse2t64   # o libfuse2
  ./ElectronDB-*.AppImage
  ```

  El `.deb` se instala con `sudo apt install ./electrondb_*_amd64.deb`.

## Primer uso

### Crear una conexión

1. **Conexión → Nueva conexión MySQL…**
2. Rellena host, puerto, usuario y contraseña. Elige el **Entorno**: marca como **Producción** cualquier servidor
   real que no quieras modificar por accidente.
3. Opcional: túnel SSH (contraseña o archivo de clave privada) y SSL (CA, certificado y clave de cliente).
4. **Probar conexión** y guarda.

### Importar desde Navicat (macOS)

1. **Conexión → Importar desde Navicat…**. Se propone la carpeta
   `~/Library/Application Support/PremiumSoft CyberTech/Navicat CC` (la ruta es editable).
2. Marca las conexiones y los trabajos que quieras traer. Navicat no se modifica.
3. Navicat no guarda las contraseñas en sus archivos. Puedes pulsar **recuperarlas del Llavero** (macOS pedirá
   permiso para cada una) o escribirlas una vez en cada conexión.

**En Windows o Linux**: copia la carpeta `Navicat CC` desde un Mac (por ejemplo a `C:\Datos\Navicat CC` o
`~/navicat-cc`) y escribe esa ruta en el diálogo de importación (o en **Ajustes** para no repetirla), que fuera
de macOS empieza vacío. Las contraseñas habrá que escribirlas a mano: el botón del Llavero solo aparece en macOS.
Las copias `.nb3` se buscan en la carpeta de cada conexión dentro de `Navicat CC`, porque las rutas de un Mac
no existen en otro equipo.

### Contraseñas

- Se guardan cifradas con el almacén del sistema (Llavero, DPAPI o libsecret/KWallet), nunca en
  `connections.json`.
- Si desmarcas **Guardar contraseña**, la app la pedirá cuando haga falta. El error
  `No hay contraseña guardada para la conexión …` significa que falta: edita la conexión y escríbela.
- En Linux sin un llavero activo (GNOME Keyring o KWallet) las contraseñas se guardan **solo en base64, sin
  cifrar**, y la app lo avisa una vez al arrancar. Instala y desbloquea un llavero si guardas contraseñas de
  servidores reales.

### Producción y confirmaciones

En una conexión con entorno **Producción**, restaurar, borrar, crear bases de datos, editar filas o ejecutar
sentencias que escriben exige escribir el nombre de la conexión para confirmar. El proceso principal también lo
comprueba y rechaza la operación si la interfaz no envió la confirmación. Puedes desactivarlo en **Otros →
Ajustes…**, pero no se recomienda.

### Atajos de teclado

En macOS se usa `Cmd`; en Windows y Linux, `Ctrl`.

| Atajo                           | Acción                                                                |
| ------------------------------- | --------------------------------------------------------------------- |
| `Cmd/Ctrl+N`                    | Nueva consulta en la conexión seleccionada                            |
| `Cmd/Ctrl+R` o `Cmd/Ctrl+Enter` | Ejecuta la consulta de la pestaña activa                              |
| `Cmd/Ctrl+S`                    | Guarda (consulta, diseño de tabla, objeto DDL o cambios en los datos) |
| `Cmd/Ctrl+W`                    | Cierra la pestaña activa (pregunta si hay cambios sin guardar)        |
| `Shift+Cmd/Ctrl+W`              | Cierra la ventana                                                     |
| `Shift+Alt+Cmd/Ctrl+R`          | Recarga la ventana (desarrollo)                                       |
| `Alt+Cmd/Ctrl+I`                | Herramientas de desarrollo (desarrollo)                               |

En el editor de consultas, un resultado que sale de **una sola tabla** e incluye su clave primaria completa se
edita igual que la vista de datos. Un aviso sobre la rejilla indica `Editable · esquema.tabla` o `Solo lectura`
con el motivo (varias tablas, columnas calculadas, vista, sin clave primaria).

## Copias de seguridad y rollback a local

- **Copia de seguridad** (barra superior) abre las copias de la conexión seleccionada: las propias y, en solo
  lectura, las que creó Navicat.
- **Nueva copia** genera un `.nb3` del esquema elegido (estructura y, si quieres, datos) con barra de progreso
  y opción de cancelar.
- **Restaurar** carga una copia en la conexión y el esquema que elijas. Puedes crear el esquema, borrar antes
  los objetos, restaurar solo estructura o solo datos y elegir objetos concretos.
- **Rollback a local**: para traer el estado de un servidor remoto a tu MySQL local:
  1. Crea una conexión a tu MySQL local con entorno **Local**.
  2. En la conexión remota, pulsa **Nueva copia**.
  3. Selecciona esa copia y pulsa **Restaurar en Local**.

Las copias nuevas se guardan en `<perfil>/backups/<conexión>/<esquema>/`, salvo que cambies la carpeta en la
conexión o en **Ajustes** (si venías de Navidog, siguen en la carpeta `backups` del perfil de Navidog).

## Automatización

Un trabajo agrupa pasos de **backup de esquema** y de **SQL**, con una programación tipo cron, historial y
registro de cada ejecución.

| Modo                                  | Sistemas   | Cómo funciona                                                                       |
| ------------------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| Programador interno                   | Todos      | Ejecuta los trabajos a su hora **mientras la app está abierta**.                    |
| "Ejecutar aunque la app esté cerrada" | Solo macOS | Crea un LaunchAgent en `~/Library/LaunchAgents/` que lanza la app sin ventana.      |
| Línea de comandos `--run-job=<id>`    | Todos      | Ejecuta un trabajo sin ventana y termina. Útil con el Programador de tareas o cron. |

Un trabajo con pasos SQL sobre Producción pide confirmación al guardarlo; las ejecuciones programadas usan esa
confirmación.

Ejecución por línea de comandos (código de salida `0` = éxito, `1` = fallo, `2` = el trabajo no existe). El
`<id>` del trabajo está en `<perfil>/jobs.json`.

```sh
# Desde el código
npm run build
npx electron . --run-job=<id>

# App instalada
/Applications/ElectronDB.app/Contents/MacOS/ElectronDB --run-job=<id>     # macOS
"%LOCALAPPDATA%\Programs\ElectronDB\ElectronDB.exe" --run-job=<id>        # Windows (ruta por defecto del instalador)
/opt/ElectronDB/electrondb --run-job=<id>                                 # Linux (.deb)
```

Para programarlo con la app cerrada fuera de macOS:

- **Windows**: Programador de tareas → Crear tarea básica → Acción "Iniciar un programa" con la ruta del `.exe`
  y el argumento `--run-job=<id>`.
- **Linux** (experimental): cron no tiene pantalla ni acceso al llavero de tu sesión, y Electron necesita
  ambos aunque no abra ventana. Indícalos en la línea de `crontab -e` y deja tu sesión de escritorio iniciada
  (con el llavero desbloqueado). Cambia `1000` por tu UID, que sale con `id -u`:

  ```sh
  0 3 * * * DISPLAY=:0 XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus /opt/ElectronDB/electrondb --run-job=<id> >> /tmp/electrondb-cron.log 2>&1
  ```

  El registro de la ejecución queda en `/tmp/electrondb-cron.log` y en el `logs/` del perfil.

## Dónde se guardan los datos

El **perfil** es una carpeta por usuario que se llama como la app:

| Sistema | Carpeta del perfil                                                                   |
| ------- | ------------------------------------------------------------------------------------ |
| macOS   | `~/Library/Application Support/ElectronDB`                                           |
| Windows | `%APPDATA%\ElectronDB` (normalmente `C:\Users\<usuario>\AppData\Roaming\ElectronDB`) |
| Linux   | `~/.config/ElectronDB` (o `$XDG_CONFIG_HOME/ElectronDB`)                             |

Si usaste la app cuando aún se llamaba **Navidog**, tu perfil anterior está en la misma ruta pero con la carpeta
`Navidog` (en Linux puede ser `navidog`). ElectronDB lo copia solo en el primer arranque: ver
[Si venías de Navidog](#si-venías-de-navidog).

| Archivo o carpeta  | Contenido                                                                   |
| ------------------ | --------------------------------------------------------------------------- |
| `connections.json` | Conexiones (sin contraseñas)                                                |
| `credentials.json` | Contraseñas cifradas con el almacén del sistema                             |
| `jobs.json`        | Trabajos de automatización                                                  |
| `job-runs.json`    | Historial de ejecuciones                                                    |
| `settings.json`    | Preferencias (carpeta de Navicat, carpeta de copias, tema, límite de filas) |
| `logs/`            | Registro de la app (`electrondb.log`) y de las ejecuciones con launchd      |
| `backups/`         | Copias `.nb3` creadas por la app (carpeta por defecto)                      |
| `notices.json`     | Avisos de arranque que ya cerraste                                          |

### Copiar o mover el perfil

1. Cierra la app.
2. Copia la carpeta del perfil completa (o al menos `connections.json`, `jobs.json`, `settings.json` y
   `backups/`).
3. En el equipo nuevo, **no copies `credentials.json`**: está cifrado con una clave de ese usuario y equipo y no
   se puede descifrar en otro. Escribe de nuevo las contraseñas.
4. Revisa en cada conexión las rutas que dependen del equipo: carpeta de copias, clave SSH y certificados SSL.

Para probar sin tocar tu perfil, arranca con otro (ver [Variables de entorno](#variables-de-entorno)).

### Si venías de Navidog

La app se llamaba **Navidog**. La primera vez que arranca como ElectronDB, si la carpeta nueva todavía no tiene
conexiones y existe la antigua, **copia** (no mueve) tu perfil:

- Los `*.json` (conexiones, trabajos, historial, preferencias y contraseñas cifradas), `logs/` (el registro
  antiguo, `navidog.log`, se conserva ahí) y las consultas guardadas (`Local Storage`). En Windows también
  `Local State`, donde está la clave de cifrado de las contraseñas.
- **Las copias `.nb3` no se copian** (pueden ocupar muchos GB): ElectronDB sigue usando `Navidog/backups` donde
  está, como carpeta de copias en **Ajustes** y en cada conexión que la usaba.
- Las demás rutas que apuntaban dentro de la carpeta antigua (por ejemplo, certificados guardados ahí) pasan a
  apuntar a la nueva.
- Nunca sobrescribe lo que ya exista en la carpeta nueva. Deja un `migrated-from-navidog.json` con lo copiado
  (y lo que no se pudo copiar, en `failed`) y lo apunta en el registro. La carpeta antigua no se toca.
- Con un perfil alternativo (`ELECTRONDB_USER_DATA`) no se copia nada.

**No borres la carpeta antigua** mientras ElectronDB use su `backups/` ni mientras haya contraseñas pendientes
(ver abajo). Para dejar de depender de ella: cierra la app, mueve `Navidog/backups` a otra carpeta, ponla en
**Ajustes** y en la carpeta de copias de cada conexión, y después borra `Navidog`.

**Contraseñas.** El cifrado del sistema va ligado al nombre de la app, así que hay que volver a cifrarlas:

- **macOS**: la clave antigua está en el llavero, en el elemento «Navidog Safe Storage». ElectronDB la lee una
  sola vez y macOS pregunta si `security` puede acceder a ella: elige **Permitir**. Las contraseñas se vuelven a
  cifrar con la clave nueva («ElectronDB Safe Storage»). Si deniegas el acceso, no respondes al aviso o el
  llavero está bloqueado, esas contraseñas quedan pendientes y se vuelve a intentar en los siguientes arranques
  (3 intentos en total). Si el elemento no existe, no se reintenta.
- **Windows**: se siguen leyendo con la clave copiada en `Local State` (DPAPI, ligada a tu usuario de Windows).
- **Linux**: las que guardó el llavero de la sesión (GNOME Keyring/KWallet) van ligadas al nombre antiguo y no
  se pueden recuperar.

Si alguna no se puede recuperar, la app avisa una vez al arrancar: «Vuelve a escribir la contraseña de: …».
Edita esas conexiones y guarda la contraseña de nuevo.

Para **volver a intentarlo más tarde** (por ejemplo, si denegaste el acceso las tres veces): cierra la app, abre
`migrated-from-navidog.json` en la carpeta del perfil y cambia `"secrets": "done"` por `"secrets": "pending"`. En
el siguiente arranque ElectronDB vuelve a leer las contraseñas que le falten de `Navidog/credentials.json` (la
carpeta antigua tiene que seguir existiendo) y conserva las que ya hayas escrito de nuevo.

**Trabajos con "Ejecutar aunque la app esté cerrada"** (macOS): al arrancar, los LaunchAgents antiguos
(`dev.y0rshb3.navidog.job.*`) de los trabajos que ya están en ElectronDB se eliminan y se crean otra vez para
ElectronDB (`dev.y0rshb3.electrondb.job.*`). Los de trabajos que ElectronDB no tiene (por ejemplo, si no se copió
el perfil porque la carpeta nueva ya tenía conexiones) **no se tocan**: siguen lanzando Navidog, dejan de
funcionar si lo desinstalas, y la app avisa una vez con sus nombres. Crea esos trabajos en **Automatización** y
borra después los archivos antiguos de `~/Library/LaunchAgents`. No vuelvas a abrir Navidog: volvería a crear
sus agentes y esos trabajos se ejecutarían dos veces.

## Actualizar

```sh
cd ElectronDB
git pull
npm ci
npm run dev        # o vuelve a generar el instalador: npm run dist
```

Cierra la app antes de actualizar. El perfil no se toca al actualizar ni al reinstalar.

## Solución de problemas

| Síntoma                                                                                                 | Solución                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm ci` o la primera ejecución (`Downloading Electron binary...`) falla o se queda colgada             | Normalmente es un proxy o un firewall. Ver [Descargas detrás de un proxy](#descargas-detrás-de-un-proxy).                                                                                                                                                                      |
| `Electron failed to install correctly`                                                                  | La descarga de Electron se cortó. Borra la carpeta `node_modules/electron`, ejecuta `npm ci` y vuelve a lanzar `npm run dev`.                                                                                                                                                  |
| Errores de `node-gyp` / `cpu-features` durante `npm ci`                                                 | Se pueden ignorar si `npm ci` termina. Es una dependencia opcional.                                                                                                                                                                                                            |
| `Failed to fetch dynamically imported module` o pantalla en blanco en `npm run dev`                     | Cierra `npm run dev` con `Ctrl+C` y vuelve a lanzarlo. Pasa tras cambiar de rama o actualizar dependencias con el servidor de desarrollo abierto.                                                                                                                              |
| El puerto 5173 ya está en uso                                                                           | Hay otro `npm run dev` abierto (o cualquier proyecto Vite). Ciérralo; si no, Vite usará el siguiente puerto libre.                                                                                                                                                             |
| `No hay contraseña guardada para la conexión …`                                                         | Edita la conexión, escribe la contraseña y marca **Guardar contraseña**. Ocurre también tras importar desde Navicat o mover el perfil.                                                                                                                                         |
| Error al descifrar contraseñas tras copiar el perfil                                                    | Cierra la app, borra `credentials.json` del perfil y vuelve a escribir las contraseñas.                                                                                                                                                                                        |
| Tras pasar de Navidog a ElectronDB pide contraseñas                                                     | No se pudo leer la clave antigua (acceso al llavero denegado o Linux). En macOS se reintenta en los dos arranques siguientes (elige **Permitir**). Si no, escribe de nuevo las contraseñas del aviso o fuerza otro intento: ver [Si venías de Navidog](#si-venías-de-navidog). |
| `Access denied for user …` (`ER_ACCESS_DENIED_ERROR`)                                                   | Usuario o contraseña incorrectos, o el usuario no tiene permiso desde tu IP (`'usuario'@'%'` frente a `'usuario'@'localhost'`).                                                                                                                                                |
| Error con `caching_sha2_password` o `RSA public key`                                                    | MySQL 8 usa `caching_sha2_password`. Activa SSL en la conexión o conéctate una vez con otro cliente para que el servidor cachee la contraseña. Como último recurso, el administrador puede cambiar el usuario a `mysql_native_password` (eliminado en MySQL 9).                |
| `ECONNREFUSED` / `ETIMEDOUT`                                                                            | Comprueba host, puerto y firewall. Si el servidor solo es accesible por SSH, activa el túnel SSH.                                                                                                                                                                              |
| `No se pudo leer la clave privada SSH …`                                                                | Revisa la ruta. En macOS/Linux la clave debe pertenecer a tu usuario y tener permisos `600`: `chmod 600 ~/.ssh/id_ed25519`. En Windows usa una ruta completa (`C:\Users\<usuario>\.ssh\id_ed25519`).                                                                           |
| `La clave privada SSH … está cifrada y no hay frase de contraseña guardada`                             | Escribe la frase de contraseña de la clave en el campo **Contraseña SSH** y guárdala.                                                                                                                                                                                          |
| Linux: `The SUID sandbox helper binary was found, but is not configured correctly`                      | En Ubuntu 23.10+ ocurre por AppArmor. Desde el código: `sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox`. Con la AppImage: `./ElectronDB-*.AppImage --no-sandbox`.                                 |
| macOS: "está dañada y no se puede abrir", "no se ha podido verificar" o "desarrollador no identificado" | Ejecuta `xattr -dr com.apple.quarantine "/Applications/ElectronDB.app"`. Ver [Aplicación sin firmar](#aplicación-sin-firmar-primer-arranque).                                                                                                                                  |
| macOS: "no se puede usar con esta versión de macOS"                                                     | La app necesita macOS 13 (Ventura) o posterior.                                                                                                                                                                                                                                |
| `npm warn EBADENGINE` durante `npm ci`                                                                  | Tu Node es demasiado antiguo. Instala Node 24 (mínimo 22.12) como en [Requisitos](#requisitos) y repite `npm ci`.                                                                                                                                                              |
| Un trabajo programado no se ejecuta en Windows/Linux                                                    | El programador interno solo funciona con la app abierta: déjala abierta o usa el Programador de tareas / cron con `--run-job=<id>` (ver [Automatización](#automatización)).                                                                                                    |

### Descargas detrás de un proxy

`npm ci` descarga los paquetes de npm; Electron se descarga aparte la primera vez que arranca la app
(`npm run dev` o `npx electron .`) y **no usa** la configuración de proxy de npm.

```sh
# macOS / Linux
npm config set proxy http://proxy.ejemplo:8080
npm config set https-proxy http://proxy.ejemplo:8080
npm ci
ELECTRON_GET_USE_PROXY=1 HTTPS_PROXY=http://proxy.ejemplo:8080 npm run dev
```

```powershell
# Windows (PowerShell)
npm config set proxy http://proxy.ejemplo:8080
npm config set https-proxy http://proxy.ejemplo:8080
npm ci
$env:ELECTRON_GET_USE_PROXY = '1'; $env:HTTPS_PROXY = 'http://proxy.ejemplo:8080'
npm run dev
```

Si el sitio de descargas de Electron (GitHub) está bloqueado, usa un espejo al arrancar por primera vez:
`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dev` (en PowerShell,
`$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'` y luego `npm run dev`). Al generar
instaladores, `npm run dist` usa las mismas variables y además `ELECTRON_BUILDER_BINARIES_MIRROR` para las
herramientas de `electron-builder`.

### Registro

Para más detalle, abre **Otros → Registro** o el archivo `logs/electrondb.log` del perfil. Con `ELECTRONDB_DEBUG=1`
el registro es más detallado y se copia también en la terminal.

## Desarrollo

| Comando                          | Qué hace                                                                    |
| -------------------------------- | --------------------------------------------------------------------------- |
| `npm run dev`                    | App en modo desarrollo con recarga en caliente                              |
| `npm run check`                  | Lint + typecheck + tests unitarios (debe pasar antes de entregar un cambio) |
| `npm test`                       | Tests unitarios (Vitest, proyectos `node` y `web`)                          |
| `npm run test:watch`             | Tests en modo observación                                                   |
| `npm run test:integration`       | Tests contra un MySQL real (se omiten sin `ELECTRONDB_TEST_MYSQL_URL`)      |
| `npm run lint`                   | ESLint                                                                      |
| `npm run format`                 | Prettier                                                                    |
| `npm run build`                  | Compila a `out/`                                                            |
| `npm run dist[:mac/:win/:linux]` | Instaladores en `release/`                                                  |
| `npm run screenshots`            | Capturas de todas las pantallas con un perfil y un MySQL desechables        |

### Tests de integración

Necesitan un MySQL desechable. Con Docker (los comandos valen igual en macOS, Linux y PowerShell):

```sh
docker run -d --name electrondb-test-mysql -e MYSQL_ROOT_PASSWORD=navidog -e MYSQL_DATABASE=navidog_test -p 127.0.0.1:33306:3306 mysql:8.4.7
# Espera a que MySQL termine de arrancar (unos 20-30 s la primera vez) hasta ver "mysqld is alive":
docker exec electrondb-test-mysql mysqladmin ping -h127.0.0.1 -uroot -pnavidog --wait=30
```

Las siguientes veces basta con `docker start electrondb-test-mysql` (y el mismo `mysqladmin ping`). Para
borrarlo: `docker rm -f electrondb-test-mysql`.

```sh
# macOS / Linux
ELECTRONDB_TEST_MYSQL_URL='mysql://root:navidog@127.0.0.1:33306/navidog_test' npm run test:integration
```

```powershell
# Windows (PowerShell)
$env:ELECTRONDB_TEST_MYSQL_URL = 'mysql://root:navidog@127.0.0.1:33306/navidog_test'
npm run test:integration
```

Usa siempre una base de datos desechable: los tests crean y borran tablas. La contraseña `navidog` y la base
`navidog_test` son los valores con los que se creó este contenedor de pruebas; no tienen relación con tus datos.

En macOS, el test de la migración de contraseñas contra un llavero real se activa aparte: crea un llavero
desechable en la carpeta que indiques (nunca usa el llavero de inicio de sesión) y lo borra al terminar.

```sh
ELECTRONDB_TEST_KEYCHAIN_DIR="$(mktemp -d)" npm run test:integration
```

### Capturas de pantalla

`npm run screenshots` siembra un perfil de prueba y el MySQL desechable (tablas `shot_*` en `navidog_test`),
compila y abre la app en una ventana de 1600×1000 que recorre las pantallas principales. Guarda `01-home.png` …
`15-light-theme-home.png` e imprime un resumen `[screenshots] {...}`. Nunca usa tu perfil real y se niega a
sembrar un MySQL en los puertos locales habituales (3306-3309). **Solo macOS y Linux**: el script usa sintaxis de
shell POSIX y en Windows npm ejecuta los scripts con `cmd.exe`, aunque lo lances desde Git Bash o PowerShell.

```sh
npm run screenshots
# Rutas y MySQL configurables:
ELECTRONDB_SHOTS_DIR=/tmp/shots ELECTRONDB_SHOTS_PROFILE=/tmp/shots/profile \
ELECTRONDB_SHOTS_MYSQL='mysql://root:navidog@127.0.0.1:33306/navidog_test' npm run screenshots
# Solo algunos pasos (prefijos del nombre del PNG):
ELECTRONDB_SHOTS_ONLY=05,06 npm run screenshots
```

Por defecto escribe en `$TMPDIR/electrondb-shots`. El perfil (`.../profile`) se borra y se recrea en cada
ejecución, y su carpeta debe llamarse `profile`.

### Variables de entorno

| Variable                         | Efecto                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ELECTRONDB_USER_DATA=<carpeta>` | Usa otro perfil (conexiones, trabajos, contraseñas, copias, registros). Con un perfil alternativo no se instalan LaunchAgents. |
| `ELECTRONDB_PLAIN_SECRETS=1`     | Guarda las contraseñas solo en base64, sin cifrar. Solo para perfiles de prueba.                                               |
| `ELECTRONDB_SMOKE=1`             | Arranca, prueba varios canales IPC, imprime `[smoke] {...}` y sale (0 = todo bien).                                            |
| `ELECTRONDB_DEBUG=1`             | Registro a nivel `debug`, copiado también en la consola.                                                                       |
| `ELECTRONDB_TEST_MYSQL_URL`      | MySQL desechable para `npm run test:integration`.                                                                              |
| `ELECTRONDB_TEST_KEYCHAIN_DIR`   | Carpeta desechable para el test del llavero de macOS en `npm run test:integration`.                                            |
| `ELECTRONDB_SCREENSHOTS=<dir>`   | Arnés de capturas. Exige `ELECTRONDB_USER_DATA`.                                                                               |

Prueba de humo del binario compilado sin tocar tus datos:

```sh
# macOS / Linux
npm run build
ELECTRONDB_USER_DATA="$(mktemp -d)" ELECTRONDB_SMOKE=1 ELECTRONDB_PLAIN_SECRETS=1 npx electron .
```

```powershell
# Windows (PowerShell)
npm run build
$env:ELECTRONDB_USER_DATA = "$env:TEMP\electrondb-smoke"; $env:ELECTRONDB_SMOKE = '1'; $env:ELECTRONDB_PLAIN_SECRETS = '1'
npx electron .
# Limpia las variables al terminar (o cierra la terminal): si no, el siguiente `npm run dev` de esta terminal
# arrancaría en modo humo, con el perfil de prueba y las contraseñas sin cifrar.
Remove-Item Env:ELECTRONDB_SMOKE, Env:ELECTRONDB_PLAIN_SECRETS, Env:ELECTRONDB_USER_DATA
```

### Estructura del proyecto

| Carpeta           | Contenido                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `src/shared/`     | Tipos del dominio y contrato IPC tipado (única API entre interfaz y proceso principal)                    |
| `src/main/`       | Proceso principal de Electron: MySQL, copias `.nb3`, automatización, importación de Navicat, credenciales |
| `src/preload/`    | Puente `contextBridge`, sin lógica                                                                        |
| `src/renderer/`   | Interfaz Vue 3 + Vuetify 3 + Pinia                                                                        |
| `tests/fixtures/` | Archivos de Navicat anonimizados y un `.nb3` sintético                                                    |

Las convenciones del proyecto están en [`CLAUDE.md`](CLAUDE.md) y los formatos de Navicat verificados en
[`docs/navicat-storage.md`](docs/navicat-storage.md). Léelos antes de tocar la importación o las copias.

## Seguridad

- **Las copias `.nb3` no van cifradas** (igual que las de Navicat). Se escriben con permisos `0600` en tu
  carpeta de usuario, pero cualquiera que copie el archivo puede leer los datos. Trátalas como datos sensibles y
  no las subas a repositorios ni carpetas compartidas.
- Los archivos JSON del perfil se escriben con permisos `0600`. En Windows quedan protegidos por los permisos de tu
  carpeta de usuario.
- Las contraseñas solo se guardan en `credentials.json`, cifradas con el almacén del sistema. Nunca las pongas en
  `connections.json`, en variables de entorno compartidas ni en el repositorio.
- **Nunca subas al repositorio** perfiles, `credentials.json`, copias `.nb3`, claves SSH ni configuraciones con
  hosts o usuarios reales. Los fixtures de `tests/` deben ser anónimos o sintéticos.
- El registro no guarda datos de consultas, contraseñas ni contenido de copias. De los errores de MySQL solo
  guarda el canal y el código.
- Las conexiones de Producción exigen confirmación para cualquier escritura, tanto en la interfaz como en el
  proceso principal.
