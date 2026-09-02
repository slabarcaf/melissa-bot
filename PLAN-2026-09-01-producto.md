# Sydney — de bot personal a producto multi-usuario (plan por fases)

> **Estado al 2026-09-01:** Fase 0 ✅ y Fase 1 ✅ completadas y desplegadas.
> Pendientes: Fase 2 (documentar), Fase 3 (cuentas reales), Fase 4 (web/PWA), Fase 5 (módulos).
> El detalle de lo hecho está en `HANDOFF-2026-09-01.md`. Este archivo es la hoja de ruta;
> el handoff es el estado.

## Contexto

Sydney funciona bien para Santiago e the second user en Telegram, pero tres cosas bloquean que otros la usen:
los briefs se ven feos, las cuentas de los usuarios no son reales, y no hay más UI que Telegram.
Este plan las ataca en orden de dependencia, no de deseo.

Hallazgos de esta sesión que cambian el planteamiento original:

1. **La causa del formato feo está identificada.** `sendMessage` (melissa.js:712) nunca manda
   `parse_mode` a Telegram — `parse_mode` aparece **0 veces** en todo el archivo. Por eso cada
   `*negrita*` sale con asteriscos literales: `*TAREAS*`, `*Finanzas*`. No es un problema de diseño
   del brief, es un parámetro faltante de una línea.
2. **El task-dashboard ya tiene una app web funcionando** en `~/demo/task-dashboard`: Next.js 14 +
   TypeScript + Tailwind, login con Google, onboarding de categorías, vista lista **y vista canvas de
   6 columnas**, filtros, buscador, modal de edición, updates optimistas. Son 1.687 líneas en
   `src/app/page.tsx`. No hay que construir desde cero.
3. **Riesgo grave e inmediato:** el árbol de trabajo de task-dashboard está sucio, y la capa que
   autentica al bot (`getBotUserIfAuthorized`, la ruta `DELETE`) **existe solo en este Mac y en el
   build de Vercel**. Se desplegó con `vercel --prod` desde la copia local, nunca se commiteó.
   GitHub está atrás de producción. Si se pierde ese directorio, se pierde ese código.
4. **El token del bot colapsa a todos los usuarios en uno.** `getBotUserIfAuthorized` resuelve
   siempre a `DEFAULT_OWNER_EMAIL` sin importar qué chat de Telegram escribió. Las tareas de the second user
   están hoy en la cuenta de Santiago, separadas solo por la etiqueta `[uid:CHATID]` dentro del
   título. La web ve una sola bandeja compartida.
5. **La prioridad (🔴) no existe en la base de datos.** Vive en `/root/.openclaw/priority.json` en la
   VM, indexada por rowId. Ninguna UI web puede mostrarla ni cambiarla sin migrarla.
6. **El onboarding no está documentado en ninguna parte.** Las 11 etapas viven solo en
   `melissa.js:464-572`. Es exactamente lo que pediste documentar.
7. **Defecto vivo sin arreglar** (handoff 2026-08-26): ni `tgRequest` ni `downloadFile` tienen
   timeout. Un `504` de Telegram deja la promesa colgada para siempre y traba la cola FIFO de ese
   chat indefinidamente. Solo un restart lo destraba.

Decisiones tomadas contigo: formato **negrita + bullet limpio con fecha entre paréntesis**; **pulir
el dashboard existente** en vez de reescribir; **cuentas reales por usuario**; **PWA ahora, App Store
después**. Se mantiene **gpt-5-mini compartido** para todos los usuarios (ya es así: una sola API key
en la VM).

## Estado de partida (verificado hoy)

| Cosa | Estado |
|---|---|
| Rama en producción | `pause-morning-brief` @ `a181b45` — **no `main`**, que está 11 commits atrás |
| Repo vs VM | md5 idéntico (`465049a1...`), en sync |
| Modelo | `gpt-5-mini` |
| Task API | `https://task-dashboard-nine-ashen.vercel.app`, Postgres en Neon vía `pg` |
| Usuarios | 2 (Santiago, the second user) |
| task-dashboard | `~/demo/task-dashboard`, árbol **sucio**, prod adelante de GitHub |

---

## Fase 0 — Red de seguridad (primero, antes de tocar nada)

Sin esto, todo lo demás se construye sobre arena.

- **Commitear y pushear la capa de auth del bot** en `~/demo/task-dashboard`: los cambios sin
  commitear en `src/app/api/tasks/route.ts`, `src/app/api/tasks/[id]/route.ts`,
  `src/lib/server/auth.ts`, `src/lib/server/db.ts`, `.gitignore`. Borrar el archivo basura `pwd`.
  Revisar el diff antes de commitear para confirmar que no hay secretos.
- **Resolver la divergencia de ramas** en melissa-bot. Tercer handoff seguido arrastrando esto.
  Recomendación: hacer que `pause-morning-brief` sea la rama por defecto en GitHub, o mergearla a
  `main` y cambiar el deploy. Clonar el default hoy entrega código que no es el que corre.
- **Registrar task-dashboard en la documentación de melissa-bot** — hoy `CLAUDE.md` no menciona que
  existe ni dónde vive. Es la mitad del sistema.

**Riesgo si se salta:** pérdida irrecuperable de la integración bot↔API.

---

## Fase 1 — Telegram se ve bien (tu punto 1)

**1A. Renderizar el formato de verdad.** `sendMessage` pasa a usar `parse_mode: "HTML"`, no Markdown:
HTML solo exige escapar `&`, `<`, `>`, mientras que Markdown se rompe con cualquier `*`, `_` o `[`
que venga en el texto de una tarea escrita por el usuario y devuelve error 400. Cambios:

- Helper `esc()` para escapar contenido de usuario; las etiquetas `<b>` las pone el bot.
- Reemplazar `*texto*` por `<b>texto</b>` y `_texto_` por `<i>texto</i>` en todo el prompt y en los
  mensajes de onboarding (que hoy salen con asteriscos a la vista de the second user).
- **Reintento defensivo:** si Telegram responde error de parseo, reenviar sin `parse_mode`. Un brief
  nunca debe perderse por un carácter raro.
- Cuidado con el troceado de 4000 caracteres: cortar a la mitad una etiqueta `<b>` rompe el mensaje.
  Trocear por saltos de línea, no por índice ciego.

**1B. El formato que elegiste.** Objetivo:

```
✅ TAREAS            (negrita real)

Finanzas             (negrita real)
• Pagar la tarjeta (3-Mar)
• 🔴 Renovar el seguro (5-Mar)
```

Dos lugares hay que tocar, y uno de ellos **no está en el repo**:

- `melissa.js` → sección `== FORMAT RULES ==` (línea ~97): plantillas a `• [tarea] ([fecha])`.
- `tasks-mcp.js` **en la VM** (`/opt/melissa/.openclaw/skills/`, con backup): su `fmtDate` produce
  hoy `"Lun 3 mar"`. Pasa a `3-Mar`, consistente con la regla `D-MMM` que ya introdujimos. La línea
  que arma es `${flag}${marker}${cat}${toDo} — ${date} ${id}`.

**1C. Timeouts en la ruta de voz** (defecto vivo, ~20 líneas, el ítem #1 del handoff vigente).
Opción `timeout` + `req.on('timeout')` + `req.destroy()` en `tgRequest` y `downloadFile`, limpieza
del temporal parcial, y `AbortSignal` en la llamada a Whisper. Está aquí porque es lo único de la
lista que **rompe el bot entero en silencio**, y porque vamos a estar editando esos mismos archivos.
Si prefieres dejarlo fuera de esta fase, es separable.

---

## Fase 2 — Documentar lo que existe (habilita todo lo demás)

Pediste documentar el onboarding: hoy **no existe ese documento**.

- **`ONBOARDING.md`** en melissa-bot: las 11 etapas
  (`new → awaiting_language → awaiting_name → awaiting_location → [awaiting_tz_confirm] →
  awaiting_briefs → awaiting_tasks_ack → awaiting_debts_ack → awaiting_cats → awaiting_custom_cat →
  done`), el texto exacto de cada pregunta en ES/EN, la inferencia ciudad→zona horaria con su
  fallback a Américas y la confirmación de un reintento, los acks del tutorial que avanzan con
  cualquier respuesta, los defaults de categorías, y que al llegar a `done` se dispara
  `scheduleCrons()`. Más el flujo de invitación (`/invite`, códigos de 8 caracteres, throttle).
  Este documento es la **fuente única** para el onboarding web de la Fase 4: si divergen, la
  experiencia se parte en dos.
- **`MODULES.md`**: qué puede decir un usuario para cada módulo (tareas, deudas, calendario, gmail,
  networking), qué significan los flags de `features`, y qué ve alguien con un módulo apagado.
- **Arreglar `openclaw-project-summary.md`**, hoy activamente engañoso: dice servicio `whatsapp-bot`,
  ruta `/root/whatsapp-bot/`, modelo `gpt-4.1-mini` — los tres falsos desde julio/agosto. Es además
  el único lugar donde viven el handle del bot y la URL del task API. Marcarlo como histórico y
  mover esos datos a `README.md`.
- **Handoff nuevo** al cerrar cada fase, siguiendo el patrón existente.

---

## Fase 3 — Cuentas reales (el arreglo arquitectónico)

Es el requisito duro para que alguien que no seas tú use el producto en la web.

- **Esquema:** `users.telegram_chat_id` (único, nullable) y `tasks.is_priority BOOLEAN`. El patrón de
  migración ya existe: `initialize()` en `src/lib/server/db.ts` hace `CREATE TABLE IF NOT EXISTS` +
  `ALTER TABLE ADD COLUMN IF NOT EXISTS` de forma idempotente.
- **Auth:** `getBotUserIfAuthorized` pasa a leer una cabecera con el chat_id (p. ej.
  `X-Telegram-Chat-Id`) y resuelve el usuario por `telegram_chat_id`, cayendo al owner solo cuando no
  viene. Comparar el secreto con `timingSafeEqual` en vez de `!==`. El bot manda esa cabecera desde
  `tasks-mcp.js` en cada llamada.
- **Migración de datos** (irreversible, con respaldo previo de la tabla y aprobación explícita tuya):
  crear la fila de usuario de the second user, mover sus tareas `[uid:<second-user-chat-id>]` a su `user_id`, y quitar la
  etiqueta del título. Migrar `priority.json` a la columna `is_priority`.
- **Vínculo Telegram ↔ Google:** comando `/link` que emite un código corto; el usuario lo pega en la
  web ya logueado con Google y se asocian ambas identidades. Sin esto, quien entre por la web no ve
  las tareas que creó por Telegram.
- **Trampa de zona horaria:** `statusNextStep` se calcula en UTC en el lambda de Vercel mientras el
  bot calcula "hoy" en la zona del usuario. Cerca de medianoche discrepan en un día. Hay que pasar la
  zona del usuario al cálculo.

**Riesgo principal de todo el plan.** Toca datos de producción en uso. Va con respaldo, verificación
por lectura posterior, y un camino de rollback escrito antes de empezar.

---

## Fase 4 — Web y PWA (tu punto 3)

Sobre el dashboard existente, no desde cero.

- **UX/UI:** rediseño visual de `page.tsx`, que hoy es un único componente cliente de 1.687 líneas.
  Partirlo en componentes antes de rediseñar. Reutilizar el kit propio en `src/components/ui/`
  (Badge, Button, Input, Modal, Select, Tabs, Toast) y la escala `brand` de `tailwind.config.ts`.
  La vista canvas de 6 columnas (`Overdue / Today / Tomorrow / This Week / Later / No Due Date`) ya
  es la base de lo que pediste.
- **Lo que falta en la UI:** borrar (la ruta `DELETE` existe pero `src/lib/api.ts` no la llama),
  prioridad 🔴 (llega con la Fase 3), y virtualización cuando las listas crezcan.
- **Onboarding web** espejo del de Telegram, desde `ONBOARDING.md`: mismos pasos, presentación
  propia de la web. Aquí sí controlamos la interfaz, así que es donde el onboarding puede verse bien.
- **PWA:** manifest, íconos, service worker, `display: standalone`. Instalable en iPhone y Android
  sin App Store ni cuenta de desarrollador. Limitación honesta: las notificaciones push en iOS
  requieren que el usuario la instale primero, y son menos fiables que las nativas — por eso los
  briefs siguen llegando por Telegram, que es donde ya funcionan.
- **Landing page** al final, cuando haya producto que mostrar.
- **Unificar el vocabulario de categorías.** Hoy hay **tres listas distintas**: `TIPO_OPTIONS`
  (legacy), `ONBOARDING_SUGGESTED_TIPOS` (inglés) y `categories.json` en la VM. La columna `tipo` es
  TEXT sin restricción, así que los datos ya son una mezcla. Hay que elegir una y migrar.

---

## Fase 5 — Módulos para otros usuarios (tu punto 2)

Hoy calendario, Gmail y networking son solo para Santiago, y no por diseño de producto sino porque
los servidores MCP arrancan con **un solo token OAuth global**: habilitárselos a otro usuario le daría
acceso a tu cuenta de Google. Es el hallazgo F2 de la revisión de seguridad, aplazado desde julio.

- **OAuth por usuario**, token por llamada en vez de token global al arrancar. Calendario primero,
  que es el de mayor valor y menor superficie.
- **Aislar la hoja de networking** antes de habilitarla a cualquiera (hoy no tiene aislamiento).
- Recién entonces los flags de `features` significan algo real para un usuario nuevo.

Va al final a propósito: sin las cuentas de la Fase 3, no hay a quién colgarle un token.

---

## Riesgos y trampas conocidas

- **`tasks-mcp.js` y `calendar-mcp.js` no están en el repo.** Viven solo en la VM y el script de
  deploy no los toca. Editarlos es editarlos por SSH, con backup. Las Fases 1 y 3 los tocan.
- **No hay tests.** La validación es `node --check` más `SELFCHECK=1`. Cualquier cambio de formato se
  verifica extrayendo la función y ejecutándola contra la config real, sin mandarte un mensaje
  (receta en el handoff del 2026-08-26).
- **journald no es persistente** en la VM: los logs desaparecen en horas. Capturar lo que haga falta
  durante el debug, en el momento.
- **Historial de fiabilidad:** este código tiene un patrón recurrente de "el modelo dice que hizo algo
  que no hizo". Se arregló tres veces; los arreglos solo-de-prompt fallaron dos. **Preferir guardas en
  código sobre texto en el prompt.**
- **Un solo proceso puede hacer polling del token de Telegram.** Dos pollers se roban los updates en
  silencio.
- **Costo:** gpt-5-mini compartido está bien hoy con 2 usuarios. Cada usuario nuevo suma briefs
  diarios (2 llamadas con herramientas) más su conversación. Vale la pena mirar `get_usage` antes de
  abrir a un grupo más grande.

## Verificación

- **Fase 0:** `git status` limpio en ambos repos; `git log origin/main` contiene la capa de auth;
  clonar el repo en un directorio temporal y confirmar que el default trae el código que corre.
- **Fase 1:** ejecutar la receta de `buildBriefingText` del handoff contra la config real (no manda
  mensajes); luego un brief real a tu chat y confirmar visualmente negrita y `• Tarea (3-Mar)`.
  Probar una tarea con `*`, `_` y `<` en el título para verificar el escapado y el reintento.
  Para voz: mandar una nota de voz y ver `[voice]` seguido de `[voice→text]` en journalctl.
- **Fase 2:** que alguien (o una sesión nueva de Claude sin este contexto) siga `ONBOARDING.md` y
  reproduzca el flujo sin leer `melissa.js`.
- **Fase 3:** `/resetuser` sobre una cuenta de prueba; crear tareas desde Telegram y verlas en la web
  logueado como ese usuario; confirmar por SQL que las tareas de the second user tienen su `user_id` y ya no la
  etiqueta `[uid:]`; confirmar que el token del bot ya no da acceso cruzado.
- **Fase 4:** `npm run build` y `npm run lint`; Lighthouse para el criterio de instalabilidad PWA;
  probar en móvil real; verificar en el navegador con las herramientas de preview.
- **Fase 5:** dos cuentas Google distintas, cada una viendo solo su propio calendario.

---

## Tus dos preguntas del final

### ¿Está la documentación completa en tu computador?

**Parcialmente, con un agujero serio.** Lo bueno: `melissa-bot/CLAUDE.md`, `README.md` (19 KB) y tres
`HANDOFF-*.md` fechados son documentación de operación de calidad poco común — invariantes,
despliegue, historial de bugs y decisiones que no hay que relitigar.

Lo que falta o engaña, hoy:

1. **El código de task-dashboard no está commiteado** y producción va adelante de GitHub. Es el
   riesgo real de pérdida, no un tema de documentación. Fase 0 lo cierra.
2. **El onboarding no está documentado** en ningún archivo. Fase 2 lo cierra.
3. **`openclaw-project-summary.md` es engañoso** en tres hechos centrales, y es el único lugar donde
   viven el handle del bot y la URL del task API.
4. **`melissa-bot/CLAUDE.md` no menciona task-dashboard.** Quien lea el repo del bot no se entera de
   que existe la otra mitad del sistema, ni de que vive en `~/demo/`.
5. **`~/.claude/plans/` no existe.** El handoff del 2026-07-09 apunta a un plan que ya fue borrado.
   Los planes en esa carpeta se evaporan: **este plan hay que copiarlo al repo** para que sobreviva.
6. **`tasks-mcp.js`, `calendar-mcp.js` y `config.json` solo existen en la VM.** Sin acceso SSH no se
   pueden leer.

### ¿Puedes cambiar de cuenta de Claude y seguir?

Sí, con una condición importante: **una cuenta nueva empieza sin memoria de esta conversación.**
Solo sabe lo que esté en disco y en GitHub. No hereda ni el historial ni los archivos de memoria de
`~/.claude/projects/.../memory/`, que son locales a esta cuenta.

Qué se conserva y qué no, si la otra cuenta corre **en este mismo Mac**:

- **Se conserva:** los repos, la documentación, tus llaves SSH (`~/.ssh/id_ed25519` → acceso a la VM),
  y `gh` autenticado. Es decir, todo el acceso operativo.
- **No se conserva:** la memoria de Claude, el historial de la conversación, y los planes en
  `~/.claude/plans/`.

Desde otra máquina, además faltarían las llaves SSH y el directorio `~/demo/task-dashboard` sin
commitear — ahí sí quedaría bloqueada.

**¿Basta con pegar el plan?** Ayuda mucho, pero no basta por sí solo. Para que una cuenta nueva
retome limpio hacen falta tres cosas, todas dentro del plan:

1. Fase 0 — que el código esté commiteado y que la rama por defecto sea la que corre.
2. Copiar **este plan al repo** (por ejemplo `melissa-bot/PLAN-2026-09-01-producto.md`) y añadir un
   puntero en `CLAUDE.md`, igual que se hace con los handoffs. Un plan que nadie abre no sirve.
3. Fase 2 — el onboarding y los módulos documentados.

Con eso, una cuenta nueva en este Mac que lea `CLAUDE.md` llega sola al handoff, al plan y a los
invariantes, y puede continuar sin depender de esta conversación. Sin eso, dependería de que le
pegues el contexto a mano cada vez.
