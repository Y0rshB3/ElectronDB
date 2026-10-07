# ElectronDB

Gestor de bases de datos MySQL de escritorio, de código abierto (Electron + Vue 3 + TypeScript), inspirado en
otros gestores de bases de datos. Explora y edita datos, escribe consultas con autocompletado, diseña tablas, saca
copias de seguridad y automatiza backups y restauraciones entre entornos (por ejemplo, de staging a local).
Funciona por su cuenta: no necesita los clientes `mysql`/`mysqldump`, porque usa su propio driver. También puede
importar conexiones y copias que ya tengas en otros gestores (ver
[Importar desde otros gestores](#importar-desde-otros-gestores-macos)).

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
- [Asistente de IA](#asistente-de-ia)
- [Dónde se guardan los datos](#dónde-se-guardan-los-datos)
- [Actualizaciones](#actualizaciones)
- [Solución de problemas](#solución-de-problemas)
- [Desarrollo](#desarrollo)
- [Seguridad](#seguridad)
- [Licencia](#licencia)
- [Marcas](#marcas)

## Funciones

- **Conexiones MySQL/MariaDB** con colores, entorno (Local, Staging, Producción, Otro), túnel SSH (contraseña o
  clave privada), SSL, sin contraseña para proxies o certificados, lista de bases de datos personalizada y
  consultas iniciales de sesión.
- **Explorador de objetos**: tablas, vistas, funciones, procedimientos, eventos y usuarios.
- **Editor de consultas** con autocompletado, formateo de SQL, varias sentencias y resultados editables cuando
  vienen de una sola tabla con clave primaria. La conexión se puede cambiar desde la propia pestaña.
- **Vista de datos** con edición de celdas, `NULL`, alta y baja de filas; los cambios se aplican en una
  transacción y se deshacen todos si falla uno. Filtro visual por condiciones con paréntesis y perfiles,
  selector de fecha y hora, columnas redimensionables y panel **Texto** con el valor completo de la celda.
- **Diseñador de tablas** (columnas, índices, claves foráneas) y editor DDL de vistas y rutinas.
- **Copias de seguridad `.nb3`**: crear, listar (incluidas las importadas de otros gestores, en solo lectura), restaurar en
  cualquier conexión y "rollback a local".
- **Automatización**: trabajos con pasos de backup, de SQL y de restauración, programador tipo cron, historial
  y registro de ejecución. **Restaurar todo en Local** reemplaza tus bases de datos locales con las copias que
  sacó una ejecución (por ejemplo, todo staging en local); **Restaurar paquete en Local** hace lo mismo desde
  la lista de copias de seguridad con un paquete entero (también los lotes importados de otros gestores).
- **Importación desde otros gestores**: conexiones, colores, trabajos por lotes y copias existentes de
  Navicat for MySQL (formato `.nb3`). Es de solo lectura: no modifica nada del otro programa.
- **Protección de producción**: toda escritura sobre una conexión marcada como Producción pide escribir su
  nombre. En **Ajustes › Seguridad** puedes extenderlo a Staging, Local u Otro.
- **Confirmación antes de borrar en cualquier conexión**: DROP, TRUNCATE, DELETE y eliminar filas, tablas,
  vistas, rutinas, eventos o bases de datos piden confirmación también en Local o Staging
  ([Producción y confirmaciones](#producción-y-confirmaciones)).
- **Aviso de versiones nuevas** publicadas en GitHub, con la descarga para tu sistema o los comandos para
  actualizar la carpeta del código ([Actualizaciones](#actualizaciones)).
- **Asistente de IA con tu propia clave** (Claude, OpenAI, Groq, Grok, GLM, Ollama o cualquier servidor
  compatible con OpenAI): pregunta sobre tu base de datos, genera SQL en el editor y explica consultas y
  errores. Solo se envía la estructura, nunca tus datos ([Asistente de IA](#asistente-de-ia)).
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

| Sistema | Comando              | Resultado en `release/`                                                                          |
| ------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| macOS   | `npm run dist:mac`   | `ElectronDB-<versión>-<arch>.dmg` y `ElectronDB-<versión>-<arch>-mac.zip` (arquitectura del Mac) |
| Windows | `npm run dist:win`   | `ElectronDB-<versión>-x64-setup.exe` (instalador) y `ElectronDB-<versión>-x64-portable.exe`      |
| Linux   | `npm run dist:linux` | `ElectronDB-<versión>-x86_64.AppImage` y `electrondb_<versión>_amd64.deb`                        |
| Actual  | `npm run dist`       | Los formatos del sistema en el que lo ejecutas                                                   |

Notas:

- Para un Mac con otro procesador: `npm run dist:mac -- --x64` (Intel) o `npm run dist:mac -- --universal`.
- Desde un Mac (también Apple Silicon sin Rosetta) se generan los instaladores de Windows y Linux:
  `electron-builder.yml` elige las herramientas NSIS y AppImage nativas (`toolsets`).
- Los nombres de los archivos los fija `electron-builder.yml` (`artifactName`). **No los renombres**: los
  archivos `latest*.yml` que usa la actualización integrada apuntan a esos nombres.
- Ningún comando `dist` publica nada (`--publish never`).
- La app usa el icono genérico de Electron hasta que se añada uno en `build/`.

### Preparar una versión para GitHub

`npm run release:build` compila la app y todos los instaladores en `release/v<versión>/`, comprueba los
archivos de actualización y escribe `SHA256SUMS.txt`. **No publica nada**: sube a mano a la versión de GitHub
todos los archivos que lista al terminar, sin renombrarlos:

- los instaladores (`.dmg`, `-mac.zip`, `-setup.exe`, `-portable.exe`, `.AppImage`, `.deb`);
- `latest.yml`, `latest-linux.yml` y `latest-mac.yml` (sin ellos la app no puede actualizarse sola);
- los `.blockmap` (descargas parciales en Windows);
- `SHA256SUMS.txt` (la descarga del `.dmg` desde la app en Mac lo exige).

Opciones: `--platforms win,linux` (solo algunos sistemas), `--out <carpeta>`, `--skip-build` (usa `out/` ya
compilado), `--clean` (vacía antes la carpeta de salida). Ejemplo: `npm run release:build -- --platforms win`.

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

### Tour de bienvenida

La primera vez que abres ElectronDB con un perfil nuevo aparece un recorrido corto (9 pasos): qué es la app,
**Mis conexiones**, **Nueva consulta** (autocompletado, **Embellecer**, selector de conexión), datos y filtros,
copias de seguridad y **Restaurar en Local**, automatización, el asistente de IA (**Ajustes › IA**, solo se envía
la estructura) y **Ajustes › Seguridad** (Producción). Cada paso resalta el botón del que habla; si ese elemento
no está en pantalla, la tarjeta sale centrada.

- **Siguiente** / **Atrás** o las flechas ← → para moverte, **Saltar tour** o `Esc` para cerrarlo.
- El último paso, **Importar tus datos**, busca Navicat (ver abajo). Si lo encuentra pregunta «Se detectó
  Navicat en … (4 conexiones, 3 tareas, 105 copias). ¿Es correcto?»: **Sí, importar** abre la importación ya en
  el paso **Seleccionar**; **No es esta carpeta** la abre en el primer paso para elegirla; **Ahora no** cierra.
  Si no lo encuentra ofrece **Nueva conexión** o **Importar desde otro gestor**.
- Terminarlo o saltarlo se recuerda en `tour.json` del perfil y no vuelve a salir. Puedes repetirlo cuando quieras
  desde **Otros → Ver tour de bienvenida** o en **Ajustes → Actualizaciones → Ver tour de bienvenida**.
- Si actualizas desde una versión anterior (0.1.6 o antes) no sale el tour de bienvenida: ya conoces la app. En
  su lugar, la ventana de novedades ofrece **Mostrarme cómo** (ver [Actualizaciones](#actualizaciones)).
- ElectronDB ya no abre la importación de Navicat sola al arrancar sin conexiones; sigue a mano en
  **Conexión → Importar desde Navicat…** y en el estado vacío de **Mis conexiones**.

### Crear una conexión

1. **Conexión → Nueva conexión MySQL…**
2. Rellena host, puerto, usuario y contraseña. Elige el **Entorno**: marca como **Producción** cualquier servidor
   real que no quieras modificar por accidente.
3. Opcional: túnel SSH (contraseña o archivo de clave privada) y SSL (CA, certificado y clave de cliente).
4. **Probar conexión** y guarda.

**Conexiones sin contraseña.** Si el servidor no pide contraseña (un proxy local que autentica por su cuenta,
como Cloud SQL Auth Proxy con IAM; un usuario MySQL con contraseña vacía; o autenticación solo con certificado
de cliente en la pestaña SSL), elige **Autenticación › Sin contraseña (proxy, certificado o usuario sin clave)**.
El campo de contraseña desaparece, no se guarda ninguna y la conexión, los trabajos automáticos, las copias y
el asistente de IA conectan sin ella. Si dejas **Contraseña** pero no hay ninguna guardada, ElectronDB prueba
una vez sin contraseña: si el servidor la acepta conecta (y **Probar conexión** sugiere marcar «Sin
contraseña»); si la rechaza verás «No hay contraseña guardada para la conexión X: escríbela en la conexión o
marca «Sin contraseña»». Las conexiones importadas de Navicat quedan en modo **Contraseña**, porque Navicat no
guarda si hace falta.

### Importar desde otros gestores (macOS)

Hoy se puede importar desde Navicat for MySQL.

1. **Conexión → Importar desde Navicat…**. Si la carpeta guardada no existe o está vacía, ElectronDB **busca
   Navicat solo** en los sitios habituales de macOS:
   - `~/Library/Application Support/PremiumSoft CyberTech/Navicat CC` (la habitual);
   - la versión de la App Store: `~/Library/Containers/<carpeta con «navicat» en el nombre>/Data/Library/Application Support/PremiumSoft CyberTech/Navicat CC`;
   - versiones antiguas: `~/Library/Application Support/PremiumSoft CyberTech/Navicat` (si tiene `Common/conn.plist`).

   Solo cuenta una carpeta cuyo `Common/conn.plist` se pueda leer. Si hay una, pregunta «Se detectó Navicat en
   … ¿Es correcto?»: **Sí** pasa a **Seleccionar** y guarda la carpeta en **Ajustes**; **Elegir otra** deja
   escribir la ruta o usar **Elegir carpeta…**. Si hay varias, aparecen en una lista (primero la que tiene más
   conexiones y, a igualdad, la más reciente). **Detectar** con la ruta vacía vuelve a buscar. La búsqueda solo
   lee: no escribe nada en esas carpetas, no usa la red y no guarda nada salvo la carpeta que confirmes.

2. Marca las conexiones y los trabajos que quieras traer. Navicat no se modifica.
3. Navicat no guarda las contraseñas en sus archivos. Puedes pulsar **recuperarlas del Llavero** (macOS pedirá
   permiso para cada una) o escribirlas una vez en cada conexión.

**En Windows o Linux**: copia la carpeta `Navicat CC` desde un Mac (por ejemplo a `C:\Datos\Navicat CC` o
`~/navicat-cc`) y escribe esa ruta en el diálogo de importación (o en **Ajustes** para no repetirla), que fuera
de macOS empieza vacío. ElectronDB también busca una carpeta llamada `Navicat CC` copiada en tu carpeta personal
o un nivel por debajo (por ejemplo `~/Navicat CC` o `~/Documentos/Navicat CC`), sin recorrer el disco entero. Las contraseñas habrá que escribirlas a mano: el botón del Llavero solo aparece en macOS.
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
comprueba y rechaza la operación si la interfaz no envió la confirmación. Desde la versión 0.1.5 **no se puede
desactivar** para Producción (si tenías apagado el antiguo interruptor, vuelve a pedirlo).

En **Otros → Ajustes… → Seguridad → «Pedir confirmación escribiendo el nombre antes de escribir en:»** eliges
qué otros entornos se comportan igual: **Staging**, **Local** u **Otro** (Producción aparece marcada y bloqueada).
Para una conexión de un entorno marcado:

- cualquier escritura pide escribir su nombre, con el mismo diálogo que Producción («La conexión «Pre» (entorno
  Staging) requiere confirmación: escribe su nombre»), y el proceso principal la rechaza sin esa confirmación;
- se muestra solo ese diálogo, nunca también el de borrado;
- los **pasos de restauración de una tarea** no pueden usarla como destino (al ejecutarla, programada o con
  launchd nadie escribe el nombre); usa **Restaurar todo** desde el historial, que pide confirmación;
- en el árbol de conexiones y en el selector de la consulta lleva un **candado** junto al entorno. La línea roja y
  la etiqueta roja siguen siendo solo de Producción.

Las tareas con pasos de SQL sobre esas conexiones piden escribir el nombre al ejecutarlas a mano y al
programarlas (como Producción). Una tarea ya programada antes de marcar su entorno sigue ejecutándose; guárdala
de nuevo para revisarla.

En **cualquier otra conexión** (Local, Staging, Otro), con **Ajustes → Seguridad → Confirmar antes de borrar o
eliminar en cualquier conexión** activado (lo está por defecto, también en perfiles anteriores), ElectronDB pide
una confirmación sencilla, sin escribir el nombre, antes de:

- eliminar una tabla, vista, función, procedimiento, evento o base de datos, o vaciar una tabla (árbol de
  conexiones, lista de objetos y menús contextuales);
- **Aplicar** cambios de una tabla o de un resultado editable que **eliminan filas** (dice cuántas y cuáles);
- ejecutar una consulta con `DROP`, `TRUNCATE`, `DELETE`, `ALTER TABLE … DROP` (columna, índice, clave,
  restricción o partición) o un `UPDATE` sin `WHERE`. El diálogo lista las sentencias y marca las que no tienen
  `WHERE` («sin WHERE: afecta a todas las filas»). Las palabras dentro de comentarios o cadenas no cuentan, y un
  `SELECT`, un `INSERT` o un `UPDATE … WHERE` no preguntan;
- aplicar el editor DDL cuando elimina y vuelve a crear el objeto, guardar el diseñador de tablas cuando elimina
  campos, índices o claves, y eliminar un usuario.

El diálogo muestra la conexión con su entorno, lo que se va a borrar, y deja el foco en **Cancelar** (Intro no
borra nada). En una conexión de Producción (o de un entorno marcado en Seguridad) se muestra solo la
confirmación con el nombre, nunca las dos. Es una ayuda de la interfaz: el proceso principal no la exige (la del
nombre sí). Si la desactivas, todo vuelve a funcionar como antes: las conexiones que no piden el nombre solo
preguntan donde ya preguntaban.

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
- **Reemplazar la base de datos completa** (modo de **Restaurar**) borra la base de datos de destino y la crea
  de nuevo con la copia. En **Contenido** eliges **Estructura y datos** (por defecto) o **Solo estructura**:
  las tablas con sus relaciones (claves foráneas, índices), vistas, rutinas, eventos y triggers, pero **sin
  filas** y con los contadores `AUTO_INCREMENT` empezando de nuevo (no se aplica el valor de la copia). La
  comprobación de la copia, la copia previa, las bases de datos del sistema y la confirmación de Producción
  funcionan igual en los dos modos; la confirmación y el resultado dicen «Solo estructura».
- **Rollback a local** de una sola copia: para traer el estado de un servidor remoto a tu MySQL local:
  1. Crea una conexión a tu MySQL local con entorno **Local**.
  2. En la conexión remota, pulsa **Nueva copia**.
  3. Selecciona esa copia y pulsa **Restaurar en Local**.

Las copias nuevas se guardan en `<perfil>/backups/<conexión>/<esquema>/`, salvo que cambies la carpeta en la
conexión o en **Ajustes** (si venías de Navidog, siguen en la carpeta `backups` del perfil de Navidog).

### Restaurar todo en Local (rollback de una ejecución)

Si un trabajo de automatización saca copias de varias bases de datos (por ejemplo, todas las de staging), puedes
pasarlas todas a tu MySQL local de una vez y dejarlo **igual que estaba en el momento del backup**:

1. En **Automatización**, selecciona el trabajo y, en el **Historial**, pulsa el icono **Restaurar todo en
   Local** de una ejecución terminada (también está dentro de la ejecución al desplegarla).
2. Elige la **conexión de destino**. Por defecto es la primera conexión con entorno **Local**; nunca se
   preselecciona una de producción.
3. Revisa la lista: cada base de datos muestra `origen → destino` (mismo nombre), cuántos objetos y filas
   tiene la copia, su tamaño y si en el destino **se reemplaza** (ya existe) o es **nueva**. Desmarca las que
   no quieras. Las copias que no se pueden usar (archivo borrado, otra base de datos dentro, cifrada, o una
   base de datos del sistema como `mysql`, `sys` o `performance_schema`, que nunca se reemplaza) aparecen
   desactivadas con el motivo. Las copias **solo de estructura** (paso de copia sin «Incluir datos») o sin
   ninguna fila salen con un aviso, porque dejarían las tablas vacías; las de solo estructura vienen
   desmarcadas y la confirmación las nombra aparte («quedarán SIN DATOS»).
4. En **Contenido** deja **Estructura y datos** o elige **Solo estructura** (todas las bases de datos marcadas
   se crean con sus tablas vacías, sin filas). Deja marcada **Copia de seguridad previa de Local**
   (recomendado) y pulsa **Restaurar**. La confirmación
   lista exactamente qué bases de datos se van a reemplazar y cuáles se van a crear.

Para cada base de datos marcada, en este orden:

1. Se comprueba la copia: que existe, que contiene esa base de datos y que **se lee entera sin errores** (se
   verifican la suma de verificación y la descompresión de cada bloque de datos, así que una copia dañada se
   detecta antes de borrar nada). Si falla, esa base de datos no se toca.
2. Si ya existe en el destino y la copia previa está activada, se guarda una copia de seguridad en
   `<carpeta de backups del destino>/<esquema>/<fecha>-previo-rollback.nb3`. **Si esa copia falla, esa base
   de datos no se toca** y aparece con ERROR.
3. Se borra (`DROP DATABASE`) y se crea de nuevo con el juego de caracteres y la colación de la copia cuando
   el servidor de destino los tiene (si no, los del servidor).
4. Se restauran todos los objetos con sus datos (o, con **Solo estructura**, sin filas y sin el
   `AUTO_INCREMENT` de la copia). Funciona entre versiones (por ejemplo, MySQL 5.7 → 8.4): los
   `DEFINER` de usuarios que no existen en el destino se quitan para que vistas, triggers y rutinas funcionen.

La restauración aparece en el historial del trabajo como una ejecución más (**Restauración**, nombre
`Rollback a Local · <trabajo>`) con su registro en vivo: un encabezado por base de datos (`Base de datos auth:
Staging -> Local`), la comprobación de la copia, la copia previa, el borrado y la creación, una línea por objeto
restaurado, el modo (`Contenido: estructura y datos` o `Contenido: solo estructura`), el resultado (`Solo
estructura: 7 objetos, 0 filas` en ese modo) y un resumen final con los fallos y la lista de **copias previas** guardadas. No cambia
el estado ni la «Última ejecución» del trabajo de backup, y no impide ejecutarlo mientras dura.

Si un objeto falla (por ejemplo, una función de 5.7 sin `DETERMINISTIC` en un 8.4 con binlog), el paso dice qué
objetos fallaron, el error con una pista en español (en ese caso, `SET GLOBAL log_bin_trust_function_creators
= 1` en el destino), que la base de datos **ha quedado incompleta** y cuál es su copia previa. Lo mismo si
cancelas o cierras ElectronDB a mitad: cancelar una restauración pide confirmación, y salir de la aplicación
mientras restaura también.

**Deshacer.** Cada base de datos reemplazada muestra en el historial su **Copia previa** y un botón
**Deshacer**, que abre esa copia en **Restaurar** con el modo **Reemplazar la base de datos completa**: la base
de datos se borra y se crea de nuevo con lo que tenía antes (lo que trajo la restauración desaparece; antes se
guarda otra copia previa). También puedes hacerlo desde **Copias de seguridad › conexión › base de datos ›
copia `previo-rollback` › Restaurar**. El modo «Restaurar objetos» (el de siempre) solo sobrescribe los objetos
de la copia y deja los demás.

Si el destino es una conexión de **Producción**, hay que escribir su nombre para confirmar.

### Restaurar un paquete de copias en Local (desde Copias de seguridad)

En **Copia de seguridad** de una conexión, las copias que se hicieron juntas se agrupan en **paquetes** (el
interruptor **Agrupar por paquete**, abajo a la derecha, está activado por defecto y se recuerda):

- **Automatización**: las copias que escribió una misma ejecución de un trabajo de ElectronDB. Título
  `<trabajo> · <fecha de la ejecución>`, por ejemplo `Backup staging · 2026-10-05 23:16`.
- **Lote**: el resto (los lotes de Navicat, copias antiguas o hechas a mano) se agrupan por conexión y
  etiqueta (el sufijo del nombre, `…-backup-staging.nb3`) cuando cada copia se hizo menos de 10 minutos
  después de la anterior y no repite base de datos. Título `<etiqueta o «Sin etiqueta»> · <fecha de la
primera>`.

Un paquete necesita al menos dos copias; las sueltas siguen como filas normales. Los paquetes salen plegados:
la flecha los despliega. Para restaurar el paquete entero en tu MySQL local:

1. Pulsa la cabecera del paquete (o su casilla): se marcan todas sus copias. También puedes marcar copias
   sueltas a mano, o seleccionar una fila de un paquete.
2. Pulsa **Restaurar paquete en Local**. Se abre el mismo diálogo que «Restaurar todo en Local», con las
   bases de datos marcadas; la confirmación lista qué se **reemplaza** y qué se **crea**.

Si todas las copias marcadas son de una misma ejecución, se usa esa ejecución (como desde el historial). Si no
(un lote de Navicat, copias elegidas a mano), la restauración se hace **por archivos** con las mismas reglas:
cada archivo tiene que estar en la carpeta de copias de una conexión conocida (la propia o una de Navicat), solo
una copia por base de datos (si marcas dos de `auth`, te pide que elijas una), comprobación completa de cada
copia antes de borrar nada, copia previa `previo-rollback`, nunca bases de datos del sistema y, en
**Producción**, escribir su nombre. Queda en el historial del trabajo que hizo las copias o, si vienen de varios
trabajos o de ninguno, en **Automatización › Restauraciones manuales**, con su registro.

## Automatización

Un trabajo agrupa pasos de **backup de esquema**, de **SQL** y de **restauración**, con una programación tipo
cron, historial y registro de cada ejecución.

El paso **Restaurar** reemplaza una base de datos con una copia, igual que «Restaurar todo en Local»
(comprobación de la copia, copia previa, borrado y creación, restauración). Su origen es:

- **un paso de copia anterior del mismo trabajo** (restaura el archivo que ese paso acaba de generar; solo
  puede ser un paso solo de estructura si el paso Restaurar también es «Solo estructura»), o
- **la última copia completa de una tarea** de un esquema de una conexión: la copia con datos más reciente que
  hizo un paso de copia de una tarea de ElectronDB sobre esa misma conexión y que sigue en disco. Nunca usa
  copias manuales, parciales, solo de estructura, de Navicat, de otra conexión ni copias previas.

Como en el diálogo de restaurar, el paso tiene **Contenido**: **Estructura y datos** (por defecto, también en
los trabajos guardados antes de la 0.1.6) o **Solo estructura** (tablas vacías con sus relaciones); se guarda
en `jobs.json` con el paso.

La base de datos de destino tiene por defecto el mismo nombre que la de origen. Así se monta un trabajo
**Staging → Local**: un paso de copia por cada base de datos de staging y, detrás, un paso Restaurar de cada
una en la conexión Local; programado, mantiene tu local al día cada mañana. Por seguridad, **un paso Restaurar
nunca puede escribir en una conexión de Producción** (las ejecuciones programadas o de launchd no tienen a nadie
que confirme): ElectronDB lo rechaza al guardar el trabajo y otra vez al ejecutarlo. Tampoco permite restaurar
una base de datos sobre sí misma (misma conexión y esquema que el origen) ni sobre una base de datos del sistema
(`mysql`, `sys`, `performance_schema`, `information_schema`).

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

### Cambiar la conexión de una consulta

En la barra de la pestaña de consulta, a la izquierda de la base de datos, está el **selector de conexión**: cada
conexión aparece con su color, su nombre y su entorno (Producción en rojo). Al cambiarla:

- El SQL del editor se conserva. La conexión se abre si hacía falta.
- Se recarga la lista de bases de datos: si la nueva conexión tiene una base con el mismo nombre se mantiene; si
  no, queda sin base de datos seleccionada. El autocompletado pasa a usar la nueva conexión.
- El título de la pestaña cambia a `consulta@base (conexión)` y los resultados anteriores se vacían (pertenecían
  a la otra conexión).
- No se puede cambiar mientras se ejecuta una consulta; si un resultado tiene cambios sin aplicar, primero
  pregunta si quieres descartarlos.
- Con una conexión de **Producción** la barra y el selector se tiñen de rojo, y las confirmaciones de escritura
  se aplican siempre a la conexión **actual** de la pestaña.
- Las consultas guardadas son de cada conexión: si abres una guardada y cambias de conexión, al pulsar
  **Guardar** se guarda en la conexión nueva (la original no cambia). El botón lo indica con un icono y un aviso.

### Filtrar datos de una tabla

El botón **Filtro** de la vista de datos muestra u oculta el panel de filtro; con un filtro aplicado el botón
muestra cuántas condiciones hay aunque el panel esté oculto. El filtro se lee como frases:

```
☑ email contiene jorge y
☑ (
☑   country está en la lista (ES, MX) o
☑   credit_limit entre 1000 y 6000
  ) y
☐ city empieza por Val          ← desmarcada: se conserva, pero no se aplica
```

- Haz clic en cada palabra para cambiarla: la **columna** y el **operador** abren un menú, el **valor** se edita en
  el sitio (`<?>` si está vacío; en columnas de fecha u hora con el calendario) y el **conector** alterna entre
  `y` y `o`. Al lado del valor se indica el tipo (`[Número]`, `[Texto]`, `[Fecha]`...).
- `+` añade una condición y `(+` un paréntesis (en la raíz o, desde la línea `)`, dentro de ese paréntesis). Los
  paréntesis se pueden anidar.
- Clic derecho en una línea: Insertar condición, Insertar paréntesis, Agrupar con paréntesis, Borrar condición,
  Borrar paréntesis (conserva sus condiciones), Borrar paréntesis y condiciones, Limpiar todo y los **perfiles**.
  Clic derecho en el espacio vacío o en una línea `)`: Añadir condición, Limpiar todo y los perfiles.
- Operadores: `=`, `!=`, `<`, `<=`, `>`, `>=`, contiene, no contiene, empieza por, no empieza por, termina en, no
  termina en, es nulo, no es nulo, está vacío, no está vacío, está en la lista, no está en la lista, entre, no
  entre y `[Personalizado]` (un fragmento SQL tuyo para esa línea).
- **Aplicar filtro** (o `Cmd/Ctrl+Enter`, o `Enter` al editar un valor) recarga la tabla desde la primera página;
  el total y la paginación usan el mismo filtro. **Limpiar** quita el filtro y recarga todo.
- **Editar como texto (WHERE)** muestra el `WHERE` que se ejecutaría para retocarlo a mano. Ese texto es SQL tuyo
  y se ejecuta tal cual; al volver al editor visual se descarta lo editado (se avisa antes).
- El filtro y la visibilidad del panel se conservan mientras la pestaña está abierta. Los **perfiles** (Guardar
  perfil, Guardar perfil como…, Cargar perfil, Eliminar perfil) se guardan por conexión, base de datos y tabla
  en `filter-profiles.json` del perfil.

Cómo se interpreta, para que no haya sorpresas:

- `y` tiene prioridad sobre `o`, como en SQL: `a o b y c` es `a o (b y c)`. Usa paréntesis para otro orden.
- **está vacío** es `(columna = '' OR columna IS NULL)`; **no está vacío** es lo contrario.
- `!=`, **no contiene**, **no está en la lista**, etc. siguen a SQL: las filas con `NULL` en esa columna no
  aparecen. Usa **es nulo** si también las quieres.
- **contiene / empieza por / termina en** buscan el texto literal: `%`, `_` y `\` no son comodines.
- La SQL la construye el proceso principal: las columnas se comprueban contra la tabla real y los valores van
  escapados por el controlador de MySQL. Solo `[Personalizado]` y el modo texto son SQL escrito por ti.

### Editar fechas y horas

Al editar una celda `DATE`, `DATETIME`, `TIMESTAMP`, `TIME` o `YEAR` el editor sigue siendo un campo de texto
(puedes escribir o pegar `2026-09-30 23:45:00`) con un botón de calendario que también se abre con `Alt+↓`:

- `DATE`: calendario. `DATETIME`/`TIMESTAMP`: calendario y hora con segundos (y fracción de segundo si la columna
  la tiene, por ejemplo `DATETIME(3)`). `TIME`: horas, minutos y segundos (en el texto admite más de 24 h y
  negativos, como MySQL). `YEAR`: selector de años.
- **Hoy/Ahora** pone la fecha u hora de tu reloj; **NULL** solo aparece si la columna admite `NULL`.
- `Enter` valida y guarda el cambio pendiente; `Esc` cancela. Un valor no válido se marca en rojo y no se guarda.
- Se escribe siempre el formato de MySQL (`AAAA-MM-DD`, `AAAA-MM-DD hh:mm:ss[.ffffff]`, `hh:mm:ss`) sin
  conversiones de zona horaria. Las fechas cero (`0000-00-00`) se muestran y se pueden conservar.

### Columnas y panel Texto

- Arrastra el borde derecho de una cabecera para cambiar el ancho de la columna (mínimo 48 px); doble clic en el
  borde la ajusta al contenido visible (máximo 600 px). Los anchos se recuerdan por tabla (también al paginar,
  refrescar o volver a abrirla). Editar una celda no cambia el ancho de su columna.
- El botón **Texto** (vista de datos y resultados de consulta de una tabla) abre un panel inferior redimensionable
  con el valor completo de la celda seleccionada: columna, tipo y tamaño; JSON formateado y coloreado; binarios
  en hexadecimal; `NULL` como estado. Sigue a la celda activa también con las flechas.
- Si la rejilla es editable, el panel también: el cambio queda pendiente como en la celda (Aplicar, Descartar,
  `Cmd/Ctrl+S`). **Formatear JSON** guarda el JSON con sangría; si no, se guarda exactamente lo que escribes.
  **NULL** solo aparece si la columna admite `NULL`. Las confirmaciones de producción no cambian.

## Asistente de IA

Un panel lateral **IA** (botón ✦ a la derecha de la barra superior; se alterna con el panel Información) para
preguntar sobre tu base de datos con el proveedor de IA que elijas y **tu propia clave**. Está **desactivado
por defecto**: añade un proveedor en **Ajustes › IA** y activa «Activar asistente de IA».

### Proveedores

| Proveedor                             | URL base                                                                               | Clave    |
| ------------------------------------- | -------------------------------------------------------------------------------------- | -------- |
| Anthropic Claude                      | SDK oficial de Anthropic (`@anthropic-ai/sdk`)                                         | Sí       |
| OpenAI                                | `https://api.openai.com/v1`                                                            | Sí       |
| Groq                                  | `https://api.groq.com/openai/v1`                                                       | Sí       |
| xAI Grok                              | `https://api.x.ai/v1`                                                                  | Sí       |
| Zhipu GLM / Z.ai GLM (internacional)  | `https://open.bigmodel.cn/api/paas/v4` / `https://api.z.ai/api/paas/v4`                | Sí       |
| Ollama (local)                        | `http://localhost:11434/v1` (editable)                                                 | No       |
| Personalizado (compatible con OpenAI) | La que indiques: `https://` obligatorio, `http://` solo para `localhost` o `127.0.0.1` | Opcional |

- Claude se usa siempre con el SDK oficial de Anthropic. Modelos sugeridos: `claude-opus-5-5` (por defecto),
  `claude-sonnet-5-5`, `claude-haiku-4-5` y `claude-fable-5-1`; puedes escribir otro ID. En Opus 5.5, Sonnet 5.5
  y Fable 5.1 el razonamiento es siempre adaptativo y el **esfuerzo** (Bajo / Medio / Alto, en Ajustes) controla
  cuánto piensa; Haiku 4.5 no usa ni razonamiento ni esfuerzo.
- El resto de proveedores usan el SDK oficial `openai` con su URL base. El modelo se escribe a mano o se elige
  tras pulsar **Cargar modelos** (si el proveedor no permite listarlos, escribe el ID). Si un servidor
  compatible no admite herramientas, la petición se repite una vez sin ellas.
- **Probar** hace una petición mínima con la clave (en Claude solo consulta el modelo, sin generar texto).
- Las claves se guardan cifradas en `credentials.json` con el almacén del sistema, como las contraseñas, y
  **nunca vuelven a la interfaz** (solo se ve si hay una guardada). Todas las llamadas de red salen del proceso
  principal con la configuración de red del sistema (proxy incluido).

**Coste**: cada pregunta la factura el proveedor a tu clave según sus tarifas. El pie del panel muestra los
tokens de la última respuesta (entrada, salida y, en Claude, los leídos de la caché). Con Claude, las
instrucciones y la estructura van marcadas para la caché de prompts, así que las preguntas seguidas sobre la
misma base de datos cuestan bastante menos.

**Rechazos de Claude**: si los filtros de seguridad de Claude rechazan una petición se muestra un aviso en
español. En `claude-opus-5-5`, `claude-sonnet-5-5` y `claude-fable-5-1` está activado el **reintento en el
servidor** (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`): Anthropic repite la petición con
el modelo que recomienda para ese tipo de rechazo, dentro de la misma llamada, y se factura con las tarifas de
ese modelo. El pie indica el modelo que respondió.

### Qué se envía y qué nunca

Solo se envía la **estructura** de la base de datos seleccionada: nombres de bases de datos, tablas y columnas,
tipos, claves primarias y únicas, índices, claves foráneas, firmas de vistas y rutinas, estimaciones de filas y
el entorno de la conexión (Local, Staging, Producción). La estructura se lee **solo de `information_schema`**:
el lector del asistente rechaza cualquier otra consulta, así que no puede leer filas aunque haya un error.

**Nunca** se envían filas, resultados de consultas, valores de celdas, ni el servidor, usuario o contraseña de
la conexión (tampoco su nombre).

También se envía lo que tú escribes: tus preguntas, el historial de la conversación, tus notas de **Memoria** y,
al usar «Explicar / optimizar» o «Explicar error», el SQL del editor y el mensaje de error del servidor (es tu
texto, no datos de tus tablas). «Explicar / optimizar» añade el resultado de `EXPLAIN` **solo si el SQL es una
única sentencia SELECT**; `EXPLAIN` no ejecuta la consulta y devuelve el plan (índices, tipo de acceso,
estimaciones), no datos. **Ver contexto enviado** (icono del panel) muestra el texto exacto que se mandará.

En bases de datos muy grandes la estructura se limita a unos 60.000 caracteres: van primero la tabla de la
pestaña abierta, las tablas que nombras en la pregunta o en el editor y las relacionadas por claves foráneas; el
resto aparece solo por nombre y el modelo puede pedir su estructura con una herramienta de solo lectura (que
tampoco lee filas).

### Funciones

- **Chat** con el contexto de la conexión y base de datos de la pestaña activa (o de la selección del árbol).
  Respuestas en markdown; cada bloque SQL tiene **Insertar en el editor** y **Copiar**. Enter envía, Mayús+Enter
  añade una línea, **Detener** corta la respuesta.
- **Generar SQL con IA** (barra del editor de consultas): describe lo que necesitas y el SQL se inserta en el
  cursor. **Nunca se ejecuta solo**: al pulsar Ejecutar pasa por las mismas confirmaciones de siempre
  (producción, borrados).
- **Explicar / optimizar** la selección o todo el editor.
- **Explicar error**: en la pestaña Mensajes, cada sentencia que falla tiene ese botón.
- **Memoria**: notas libres por conexión y por base de datos (reglas de negocio, significado de los estados,
  convenciones) que acompañan a la estructura. No escribas datos sensibles.
- **Conversaciones** por conexión: lista, renombrar, eliminar y «Nueva conversación». Se guardan solo en tu
  perfil (`ai/`), nunca se sincronizan.

En conexiones de Producción el asistente funciona igual (solo estructura) y el panel muestra la etiqueta del
entorno.

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

| Archivo o carpeta      | Contenido                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `connections.json`     | Conexiones (sin contraseñas)                                                       |
| `credentials.json`     | Contraseñas cifradas con el almacén del sistema                                    |
| `jobs.json`            | Trabajos de automatización                                                         |
| `job-runs.json`        | Historial de ejecuciones                                                           |
| `settings.json`        | Preferencias (carpeta de Navicat, carpeta de copias, tema, límite de filas)        |
| `logs/`                | Registro de la app (`electrondb.log`) y de las ejecuciones con launchd             |
| `backups/`             | Copias `.nb3` creadas por la app (carpeta por defecto)                             |
| `notices.json`         | Avisos de arranque que ya cerraste                                                 |
| `tour.json`            | Si ya viste (o saltaste) el tour de bienvenida                                     |
| `filter-profiles.json` | Perfiles de filtro de la vista de datos (solo la definición del filtro)            |
| `ai-providers.json`    | Proveedores del asistente de IA (sin claves; las claves van en `credentials.json`) |
| `ai-memory.json`       | Notas de «Memoria» del asistente por conexión y base de datos                      |
| `ai/`                  | Conversaciones del asistente, un archivo por conexión                              |

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

## Actualizaciones

ElectronDB comprueba si hay una versión nueva en las
[versiones publicadas en GitHub](https://github.com/Y0rshB3/ElectronDB/releases). Solo hace una consulta
anónima a la API pública de GitHub (sin cuenta ni datos tuyos). **No descarga nada hasta que pulsas
Descargar y actualizar** (salvo que actives **Descargar actualizaciones automáticamente**) y nunca instala sin
que lo pidas o cierres la app. Cómo se instala depende del sistema: ver
[Si instalaste la app](#si-instalaste-la-app-instalador-de-github).

- **Al iniciar**: unos segundos después de abrir la app, si hay una versión nueva aparece la ventana **Hay una
  nueva actualización** con lo más destacado (como mucho 5 puntos: la sección «Destacado» de la versión o, si no
  la tiene, los títulos de «Novedades») y los botones **Descargar y actualizar** (en Mac **Descargar
  instalador**; con el `.exe` portable o el `.deb`, **Descargar**; desde el código, **Cómo actualizar**, que
  muestra los comandos con **Copiar comandos**), **Ver todas las novedades**, **Más tarde** y **Omitir esta versión**. Sale
  como mucho una vez por arranque y espera a que se cierre cualquier otra ventana. **Más tarde** la oculta hasta
  un arranque pasadas 6 horas. Se consulta GitHub como mucho una vez cada 6 horas; si no hay conexión, no avisa
  de nada. Se desactiva en **Ajustes → Actualizaciones → Buscar actualizaciones al iniciar**.
- **A mano**: **Otros → Buscar actualizaciones…** (o el menú de la app en macOS) siempre consulta GitHub y muestra
  la versión instalada, la última publicada, sus notas y cómo actualizar. La versión instalada también aparece en
  **Ajustes**.
- **Omitir esta versión** deja de avisar de esa versión al iniciar; la siguiente sí se avisa.
- **Después de actualizar**: el primer arranque de una versión nueva muestra una vez **ElectronDB se actualizó a
  x.y.z** con lo importante de cada versión desde la que tenías (por ejemplo, de 0.1.2 a 0.1.4 verás la 0.1.3 y
  la 0.1.4). La lista viene con la app (`src/shared/whatsNew.ts`), así que funciona sin Internet. **Ver todas las
  novedades en GitHub** abre la página de la versión. En un perfil nuevo o al volver a una versión anterior no
  sale nada. La última versión vista se guarda en `updates.json` del perfil.
- **Mostrarme cómo**: si alguna de esas versiones trae una guía, la ventana de novedades muestra este botón. La
  cierra y resalta en la pantalla dónde están las novedades, paso a paso (lo que vive dentro de un diálogo se
  explica con texto).

### Si instalaste la app (instalador de GitHub)

Tus conexiones, trabajos y ajustes están en el perfil y no se tocan al actualizar ni al reinstalar.

**Windows (instalador `-setup.exe`) y Linux (AppImage)**: actualización integrada, como en Navicat.

1. **Descargar y actualizar** descarga la versión nueva dentro de la app. La ventana muestra el progreso
   (descargado / total y velocidad) y un botón **Cancelar**.
2. Antes de usar el archivo se comprueba su suma **sha512** con la publicada en la versión de GitHub
   (`latest.yml` / `latest-linux.yml`). Solo se descarga de las versiones de este repositorio; nunca se pasa a
   una versión anterior ni a una preliminar.
3. Cuando termina: **Reiniciar y actualizar** cierra la app, instala sin preguntas y abre la versión nueva. Con
   **Más tarde** se instala sola la próxima vez que cierres ElectronDB. Si hay una restauración en curso, la app
   no se reinicia hasta que termine.
4. Si algo falla verás el motivo en español, **Reintentar** y **Descargar manualmente** (abre el instalador en
   el navegador).

Las versiones publicadas antes de la 0.1.9 no traen `latest.yml`: desde ellas hay que actualizar una vez a mano
(descarga el instalador de la 0.1.9 o posterior). En **Ajustes → Actualizaciones → Descargar actualizaciones
automáticamente** (desactivado por defecto) la descarga empieza sola al encontrar una versión nueva que no
hayas omitido ni pospuesto; instalarla sigue siendo decisión tuya.

**macOS**: **Descargar instalador** guarda en **Descargas** el `.dmg` de tu Mac (Apple Silicon o Intel),
comprueba su suma **SHA-256** con `SHA256SUMS.txt` de la versión (si la versión no la publica, no lo abre y te
ofrece **Descargar manualmente**) y lo abre. Después cierra ElectronDB y **arrastra ElectronDB a Aplicaciones y
reemplaza** la anterior. En Mac la app no puede reemplazarse sola: macOS solo permite la actualización
automática (Squirrel.Mac) en apps firmadas con un certificado _Developer ID_ de Apple, y ElectronDB todavía no
lo tiene.

**`.exe` portable y `.deb`**: **Descargar** abre el archivo en el navegador; cierra ElectronDB e instálalo como
la primera vez (`sudo apt install ./electrondb_*_amd64.deb`). Ver
[Aplicación sin firmar](#aplicación-sin-firmar-primer-arranque).

### Windows: reparar una instalación rota

Si al actualizar el instalador dijo **"Failed to uninstall old application files"** (o se cerró a medias) y
ahora no puedes desinstalar ElectronDB desde **Configuración → Aplicaciones**, la instalación anterior quedó
a medio borrar: la entrada de "Aplicaciones" sigue en el Registro pero su desinstalador ya no funciona.

**Primero prueba lo sencillo**: cierra ElectronDB y ejecuta el instalador de la 0.1.9 o posterior. Desde esa
versión el instalador cierra la app si está abierta, ignora un desinstalador antiguo roto e instala encima,
reparando la entrada de "Aplicaciones".

Si aun así falla, límpialo a mano. **Tus datos no se tocan**: están en `%APPDATA%\ElectronDB`, una carpeta
distinta que no debes borrar. En PowerShell (sin administrador):

```powershell
# 0. (Opcional) copia de seguridad de tus datos
Copy-Item -Recurse "$env:APPDATA\ElectronDB" "$env:USERPROFILE\ElectronDB-copia-perfil"

# 1. Cierra ElectronDB y cualquier proceso suyo que haya quedado
Get-Process ElectronDB -ErrorAction SilentlyContinue | Stop-Process -Force

# 2. Mira dónde estaba instalada (normalmente %LOCALAPPDATA%\Programs\ElectronDB)
Get-ItemProperty 'HKCU:\Software\ed60cf51-f5c8-5d88-9777-022dc431ddb4' -ErrorAction SilentlyContinue |
  Select-Object InstallLocation

# 3. Borra la carpeta del PROGRAMA (usa la ruta del paso 2 si es otra)
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Programs\ElectronDB" -ErrorAction SilentlyContinue

# 4. Borra la entrada de "Aplicaciones" y la del instalador
Remove-Item -Recurse 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ed60cf51-f5c8-5d88-9777-022dc431ddb4' -ErrorAction SilentlyContinue
Remove-Item -Recurse 'HKCU:\Software\ed60cf51-f5c8-5d88-9777-022dc431ddb4' -ErrorAction SilentlyContinue

# 5. Accesos directos antiguos y caché de descargas de la actualización
Remove-Item "$([Environment]::GetFolderPath('Desktop'))\ElectronDB.lnk",
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\ElectronDB.lnk" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\electrondb-updater" -ErrorAction SilentlyContinue
```

Después ejecuta el instalador nuevo (`ElectronDB-<versión>-x64-setup.exe`): al abrir la app verás tus
conexiones, trabajos y ajustes.

- `ed60cf51-f5c8-5d88-9777-022dc431ddb4` es el identificador fijo de ElectronDB en Windows (electron-builder lo
  calcula a partir del `appId` `dev.y0rshb3.electrondb`); es el mismo en todas las versiones.
- Si la habías instalado **"para todos los usuarios"** (los instaladores hasta la 0.1.8 lo permitían), la
  carpeta es `C:\Program Files\ElectronDB` y las dos claves están en `HKLM:` en vez de `HKCU:`: repite los
  pasos 3 y 4 con esas rutas en un PowerShell **como administrador**. Desde la 0.1.9 el instalador es solo para
  tu usuario (sin permisos de administrador, en `%LOCALAPPDATA%\Programs\ElectronDB`) y avisa si encuentra
  una copia "para todos los usuarios".

### Si la usas desde la carpeta del código (`npm run dev`)

El aviso muestra **Cómo actualizar** con los comandos exactos para tu carpeta y un botón **Copiar comandos**.
Cierra la app y ejecuta:

```sh
cd ElectronDB      # tu carpeta
git pull
npm install        # solo hace algo si cambiaron las dependencias
npm run dev        # o vuelve a generar el instalador: npm run dist
```

Si estás en otra rama distinta de `main`, el diálogo te lo indica: `git pull` trae los cambios de esa rama. El
perfil no se toca al actualizar.

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
| Windows: "Failed to uninstall old application files" o no se puede desinstalar ElectronDB               | Ver [Windows: reparar una instalación rota](#windows-reparar-una-instalación-rota). Tus datos (`%APPDATA%\ElectronDB`) no se tocan.                                                                                                                                            |

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

| Comando                             | Qué hace                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `npm run dev`                       | App en modo desarrollo con recarga en caliente                              |
| `npm run check`                     | Lint + typecheck + tests unitarios (debe pasar antes de entregar un cambio) |
| `npm test`                          | Tests unitarios (Vitest, proyectos `node` y `web`)                          |
| `npm run test:watch`                | Tests en modo observación                                                   |
| `npm run test:integration`          | Tests contra un MySQL real (se omiten sin `ELECTRONDB_TEST_MYSQL_URL`)      |
| `npm run test:integration:required` | Igual, contra MySQL 8.4 **y** 5.7, y falla si falta alguna URL              |
| `npm run lint`                      | ESLint                                                                      |
| `npm run format`                    | Prettier                                                                    |
| `npm run build`                     | Compila a `out/`                                                            |
| `npm run dist[:mac/:win/:linux]`    | Instaladores en `release/`                                                  |
| `npm run screenshots`               | Capturas de todas las pantallas con un perfil y un MySQL desechables        |

### Tests de integración

Necesitan dos MySQL desechables: 8.4 en el puerto 33306 y 5.7 en el 33357 (siempre en `127.0.0.1`, nunca en
3306/3307). `tests/docker-compose.yml` los declara; los comandos valen igual en macOS, Linux y PowerShell:

```sh
docker compose -f tests/docker-compose.yml up -d --wait
# Si ya tienes el contenedor 8.4 antiguo (electrondb-test-mysql o navidog-test-mysql) en el 33306,
# arranca solo el 5.7:
docker compose -f tests/docker-compose.yml up -d --wait mysql57
# Para borrarlos (contenedores y datos):
docker compose -f tests/docker-compose.yml down -v
```

`mysql:5.7` solo existe para amd64: en Apple Silicon corre emulado y el primer arranque tarda más.
Sin Compose, el equivalente es:

```sh
docker run -d --name electrondb-test-mysql -e MYSQL_ROOT_PASSWORD=navidog -e MYSQL_DATABASE=navidog_test -p 127.0.0.1:33306:3306 mysql:8.4.7
docker run -d --name electrondb-test-mysql57 --platform linux/amd64 -e MYSQL_ROOT_PASSWORD=navidog -e MYSQL_DATABASE=navidog_test -p 127.0.0.1:33357:3306 mysql:5.7
# Espera a que cada uno termine de arrancar hasta ver "mysqld is alive":
docker exec electrondb-test-mysql mysqladmin ping -h127.0.0.1 -uroot -pnavidog --wait=30
docker exec electrondb-test-mysql57 mysqladmin ping -h127.0.0.1 -uroot -pnavidog --wait=60
```

`npm run test:integration:required` es la puerta de calidad: ejecuta las suites de MySQL y de backups contra
los dos servidores y **falla** (en vez de omitirlas) si falta `ELECTRONDB_TEST_MYSQL_URL` o
`ELECTRONDB_TEST_MYSQL57_URL`. `npm run test:integration` omite en silencio el servidor que no tenga URL.

```sh
# macOS / Linux
ELECTRONDB_TEST_MYSQL_URL='mysql://root:navidog@127.0.0.1:33306/navidog_test' \
ELECTRONDB_TEST_MYSQL57_URL='mysql://root:navidog@127.0.0.1:33357/navidog_test' \
npm run test:integration:required
```

```powershell
# Windows (PowerShell)
$env:ELECTRONDB_TEST_MYSQL_URL = 'mysql://root:navidog@127.0.0.1:33306/navidog_test'
$env:ELECTRONDB_TEST_MYSQL57_URL = 'mysql://root:navidog@127.0.0.1:33357/navidog_test'
npm run test:integration:required
```

Usa siempre bases de datos desechables: los tests crean y borran bases y tablas. La contraseña `navidog` y la
base `navidog_test` son los valores con los que se crean estos contenedores de prueba; no tienen relación con
tus datos. Los tests de «Restaurar todo en Local» entre versiones (copia en MySQL 5.7, restauración en 8.4)
usan los dos servidores.

Las expectativas son las mismas en las dos versiones salvo donde 5.7 se comporta de verdad distinto; cada
diferencia está comentada junto al test (`5.7 split`):

- sin `DEFAULT (expr)` (8.0.13+): la clave de `ed_ai` la rellena un trigger;
- sin CTE (`WITH`, 8.0): 5.7 devuelve un error de sintaxis y no hay resultado que editar;
- `COLUMN_TYPE` conserva el ancho de visualización (`int(10) unsigned`);
- `SHOW CREATE TRIGGER` devuelve el texto tal como se escribió (nombre sin comillas);
- un `ON UPDATE` omitido se informa como `RESTRICT` (8.x: `NO ACTION`);
- en vistas materializadas (`ALGORITHM=TEMPTABLE`, `GROUP BY`) las columnas no traen esquema, así que
  `SELECT * FROM vista` queda de solo lectura como "columnas calculadas" en lugar de "el origen es una vista";
- sin `utf8mb4_0900_ai_ci` ni el atributo de columna `SRID` (8.0): los backups usan `utf8mb4_unicode_ci` y el
  SRID va en cada valor;
- sin `information_schema_stats_expiry`: el test de backups hace `ANALYZE TABLE` tras la carga masiva para
  que la estimación de filas no sea la estadística antigua de InnoDB.

En macOS, el test de la migración de contraseñas contra un llavero real se activa aparte: crea un llavero
desechable en la carpeta que indiques (nunca usa el llavero de inicio de sesión) y lo borra al terminar.

```sh
ELECTRONDB_TEST_KEYCHAIN_DIR="$(mktemp -d)" npm run test:integration
```

### Capturas de pantalla

`npm run screenshots` siembra un perfil de prueba y el MySQL desechable (tablas `shot_*` en `navidog_test`),
compila y abre la app en una ventana de 1600×1000 que recorre las pantallas principales. Guarda `01-home.png` …
`19f-tree-typed-lock.png` e imprime un resumen `[screenshots] {...}`. Los pasos `16*` y `17*`
(«Restaurar todo en Local» y «Restaurar paquete en Local») usan también el MySQL 5.7 desechable como staging
(`ELECTRONDB_SHOTS_MYSQL57`, por defecto el puerto 33357). Los pasos `18*` (ventanas de actualización)
responden con una versión ficticia de `tests/fixtures/updates/latest-release.json` en vez de consultar GitHub, y
`18f-whats-new` simula una actualización de 0.1.2 a 0.1.4. Los pasos `19*` muestran las confirmaciones de borrado
en Local (se cancelan: no se borra nada) y la sección Seguridad de Ajustes; `19d`-`19f`, con Staging marcado en
Seguridad solo en memoria (no se guarda), los entornos que piden escribir el nombre, esa confirmación sobre
«Staging Demo» (se cancela) y el candado del árbol. Los pasos `20*` muestran el asistente de IA con el
proveedor falso `ELECTRONDB_AI_FIXTURE=1` (sin red ni claves reales): el panel con una conversación, la sección
IA de Ajustes, «Ver contexto enviado» y «Generar SQL con IA». Nunca usa tu perfil real y se niega a
sembrar un MySQL en los puertos locales habituales (3306-3309). **Solo macOS y Linux**: el script usa sintaxis de
shell POSIX y en Windows npm ejecuta los scripts con `cmd.exe`, aunque lo lances desde Git Bash o PowerShell.

```sh
npm run screenshots
# Rutas y MySQL configurables:
ELECTRONDB_SHOTS_DIR=/tmp/shots ELECTRONDB_SHOTS_PROFILE=/tmp/shots/profile \
ELECTRONDB_SHOTS_MYSQL='mysql://root:navidog@127.0.0.1:33306/navidog_test' npm run screenshots
# Solo algunos pasos (prefijos del nombre del PNG):
ELECTRONDB_SHOTS_ONLY=05,06 npm run screenshots
# Tour de bienvenida, detección de Navicat y «Mostrarme cómo» (pasos 21*):
ELECTRONDB_SHOTS_ONLY=21 ELECTRONDB_WHATS_NEW_FROM=0.1.5 ELECTRONDB_WHATS_NEW_VERSION=0.1.7 npm run screenshots
```

Por defecto escribe en `$TMPDIR/electrondb-shots`. El perfil (`.../profile`) se borra y se recrea en cada
ejecución, y su carpeta debe llamarse `profile`.

### Variables de entorno

| Variable                            | Efecto                                                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ELECTRONDB_USER_DATA=<carpeta>`    | Usa otro perfil (conexiones, trabajos, contraseñas, copias, registros). Con un perfil alternativo no se instalan LaunchAgents.                                                                                |
| `ELECTRONDB_PLAIN_SECRETS=1`        | Guarda las contraseñas solo en base64, sin cifrar. Solo para perfiles de prueba.                                                                                                                              |
| `ELECTRONDB_SMOKE=1`                | Arranca, prueba varios canales IPC, imprime `[smoke] {...}` y sale (0 = todo bien).                                                                                                                           |
| `ELECTRONDB_DEBUG=1`                | Registro a nivel `debug`, copiado también en la consola.                                                                                                                                                      |
| `ELECTRONDB_TEST_MYSQL_URL`         | MySQL 8.4 desechable para `npm run test:integration[:required]`.                                                                                                                                              |
| `ELECTRONDB_TEST_MYSQL57_URL`       | MySQL 5.7 desechable para `npm run test:integration[:required]` (incluye la restauración 5.7 → 8.4).                                                                                                          |
| `ELECTRONDB_TEST_KEYCHAIN_DIR`      | Carpeta desechable para el test del llavero de macOS en `npm run test:integration`.                                                                                                                           |
| `ELECTRONDB_SCREENSHOTS=<dir>`      | Arnés de capturas. Exige `ELECTRONDB_USER_DATA`.                                                                                                                                                              |
| `ELECTRONDB_UPDATES_FIXTURE=<json>` | Solo pruebas y capturas, y solo con `ELECTRONDB_USER_DATA`: responde a la búsqueda de actualizaciones con ese archivo en vez de GitHub (`{"httpStatus": 429}` simula un error).                               |
| `ELECTRONDB_UPDATES_RUN_MODE`       | Solo pruebas, y solo con `ELECTRONDB_USER_DATA`: `packaged` o `source` fuerza el modo de actualización mostrado.                                                                                              |
| `ELECTRONDB_WHATS_NEW_FROM`         | Solo pruebas y capturas, y solo con `ELECTRONDB_USER_DATA`: simula que la versión vista antes era esa (las novedades no salen en modo humo ni en capturas sin ella).                                          |
| `ELECTRONDB_AI_FIXTURE=1`           | Solo pruebas y capturas, y solo con `ELECTRONDB_USER_DATA`: el asistente de IA responde con textos fijos de un proveedor falso, sin red.                                                                      |
| `ELECTRONDB_WHATS_NEW_VERSION`      | Solo pruebas, y solo con `ELECTRONDB_USER_DATA`: simula la versión en ejecución para la ventana de novedades.                                                                                                 |
| `ELECTRONDB_NAVICAT_CANDIDATES`     | Solo pruebas y capturas, y solo con `ELECTRONDB_USER_DATA`: carpetas (separadas por `:`, o `;` en Windows) donde buscar Navicat en vez de las habituales; `npm run screenshots` usa `tests/fixtures/navicat`. |

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

| Carpeta           | Contenido                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/`     | Tipos del dominio y contrato IPC tipado (única API entre interfaz y proceso principal)                                             |
| `src/main/`       | Proceso principal de Electron: MySQL, copias `.nb3`, automatización, importación de Navicat, credenciales, asistente de IA (`ai/`) |
| `src/preload/`    | Puente `contextBridge`, sin lógica                                                                                                 |
| `src/renderer/`   | Interfaz Vue 3 + Vuetify 3 + Pinia                                                                                                 |
| `tests/fixtures/` | Archivos de Navicat anonimizados y un `.nb3` sintético                                                                             |

Las convenciones del proyecto están en [`CLAUDE.md`](CLAUDE.md) y los formatos de Navicat verificados en
[`docs/navicat-storage.md`](docs/navicat-storage.md). Léelos antes de tocar la importación o las copias.

## Seguridad

- **Búsqueda de actualizaciones**: lo único que la app envía a Internet por su cuenta es una petición anónima
  (`GET`) a `api.github.com` para leer la última versión publicada; no lleva identificadores ni datos tuyos. Solo
  abre en el navegador enlaces de las versiones de ElectronDB en GitHub. Se desactiva en **Ajustes**.
- **Actualización integrada**: solo descarga cuando la pides (o con **Descargar actualizaciones
  automáticamente**), solo de las versiones de este repositorio en GitHub, y comprueba cada archivo antes de
  usarlo (sha512 de `latest.yml` en Windows/Linux, SHA-256 de `SHA256SUMS.txt` en Mac). No acepta versiones
  anteriores ni preliminares. Las copias desde el código y las ejecuciones con un perfil de prueba
  (`ELECTRONDB_USER_DATA`) nunca descargan ni instalan nada. El registro anota versiones, nombres de archivo y
  errores, nunca datos tuyos.
- **Las copias `.nb3` no van cifradas.** Se escriben con permisos `0600` en tu
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
- Las conexiones de Producción (y las de los entornos marcados en **Ajustes › Seguridad**) exigen escribir su
  nombre para cualquier escritura, tanto en la interfaz como en el proceso principal; Producción no se puede
  quitar de la lista, ni editando `settings.json`. La confirmación de borrado en las demás conexiones es solo de
  la interfaz.

## Licencia

ElectronDB es software libre con licencia [MIT](LICENSE): puedes usarlo, copiarlo, modificarlo y distribuirlo,
también con fines comerciales, siempre que conserves el aviso de copyright y la licencia.

## Marcas

ElectronDB es un proyecto independiente. No está afiliado, patrocinado ni respaldado por PremiumSoft CyberTech Ltd.
Navicat es una marca de su propietario y se nombra solo para indicar con qué archivos es compatible la importación.
