# ABEL · Red Neuronal

Tu asistente personal con voz y texto. Muestra todos tus proyectos como una red neuronal 3D y cada 5 minutos revisa cuáles funcionan y cuáles no: Railway, GitHub Pages, webs, bots de WhatsApp (Evolution API) y Claude.

## Qué tiene

- Red 3D con un núcleo "ABEL" en el centro y tus grupos alrededor: Tutu Automotores, Bots WhatsApp, AyN, Webs de clientes, Infraestructura y Descubiertos.
- Colores de cada proyecto:
  - Verde: funciona
  - Amarillo: con problemas (lento, desplegando, dormido)
  - Rojo titilando: caído
  - Azul: solo código (está en GitHub pero no tiene web para revisar)
  - Gris: sin datos
- Tocás un proyecto y ves qué falla: el link, el deploy de Railway, la conexión de WhatsApp y el último cambio en GitHub.
- Descubre solo los proyectos nuevos: todo repo de GitHub o servicio de Railway que no esté en `projects.json` aparece en "Descubiertos".
- Chat con Claude que conoce el estado en vivo: "¿qué está caído?", "¿cómo arreglo Ruthina?".
- Voz: tocás el micrófono, el núcleo o la barra espaciadora y le hablás. Te responde en voz alta y queda escuchando para seguir la charla.
- Si algo se cae mientras tenés la página abierta, te avisa con un cartel y por voz.

## Archivos

- `server.js`: el servidor que hace los chequeos y habla con Claude
- `projects.json`: la lista de tus proyectos (acá agregás o corregís)
- `public/index.html`: la red neuronal, el chat y la voz
- `package.json`: dependencias (solo express, Node 20)

## Cómo subirlo a Railway (paso a paso)

1. Creá un repo nuevo en GitHub, por ejemplo `osmarfernandez2555-cpu/abel-asistente`, y subí estos archivos tal cual (con la carpeta `public`).
2. En Railway: New Project → Deploy from GitHub repo → elegí `abel-asistente`.
3. En el servicio, pestaña Variables, cargá estas:
   - `APP_PASSWORD`: la contraseña para entrar (obligatoria, la página muestra el estado de todo)
   - `ANTHROPIC_API_KEY`: tu key de Claude (la misma que usa Ruthina sirve)
   - `GITHUB_TOKEN`: token de GitHub (ver abajo)
   - `RAILWAY_TOKEN`: token de cuenta de Railway (ver abajo)
   - `EVOLUTION_API_KEY`: la apikey global de tu Evolution API (para saber si WhatsApp está conectado)
   - `EVOLUTION_URL`: la dirección de tu Evolution, por ejemplo `https://evolution-api-production-a132.up.railway.app` (también sirve pegando el link del `/manager/`). Con esto y `EVOLUTION_API_KEY`, ABEL muestra todos tus números de WhatsApp en el grupo "Números de WhatsApp" y te avisa si alguno se desconecta.
   - Opcionales: `CLAUDE_MODEL` (por defecto `claude-sonnet-5-5`), `CHECK_EVERY_MIN` (por defecto 5), `GITHUB_USERS` (por defecto `osmarfernandez2555-cpu,natirodriguez32-sketch`)
4. Pestaña Settings → Networking → Generate Domain. Te queda algo como `abel-asistente-production.up.railway.app`.
5. Abrilo en Chrome, poné la contraseña y listo. El primer chequeo tarda unos segundos.

### Cómo sacar cada token

- GitHub: github.com → tu foto → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token. Repository access: All repositories. Permissions: Metadata = Read-only y Contents = Read-only. Sin token igual funciona, pero solo ve repos públicos y GitHub limita las consultas.
- Railway: railway.com → tu foto → Account Settings → Tokens → Create Token. Elegí tu cuenta personal (no un token de proyecto). Con esto ABEL ve TODOS tus servicios, si el último deploy salió bien, falló o se cayó, y sus dominios.
- Evolution API: es la variable `AUTHENTICATION_API_KEY` del servicio de Evolution en Railway.

## Alertas por WhatsApp

ABEL te escribe por WhatsApp usando tu Evolution API:

- 🔴 Cuando se cae una app. Antes de avisar lo confirma con un segundo chequeo al minuto, para no mandar falsas alarmas.
- 🟢 Cuando vuelve, con cuánto tiempo estuvo caída.
- ⏰ Si sigue caída, te lo recuerda cada 6 horas.
- 📋 Un reporte diario a las 9 de la mañana (hora de Argentina) con el resumen de todo.

Al arrancar o redesplegar no avisa lo que ya estaba caído; eso aparece en el reporte diario.

### Variables para activarlas

- `ALERT_WHATSAPP_TO`: tu número con código de país, sin 0 ni 15. Para Argentina: 549 + característica + número, por ejemplo `5493511234567`. Para avisar a varias personas, separalos con comas.
- `ALERT_EVOLUTION_INSTANCE`: la instancia de Evolution que manda los avisos.
- `EVOLUTION_API_KEY`: la apikey global de Evolution (la misma que ya usa ABEL para ver si WhatsApp está conectado).
- Opcionales:
  - `ALERT_EVOLUTION_URL`: si no la ponés, usa la de Evolution que figura en `projects.json`.
  - `ALERT_DAILY_HOUR`: hora del reporte diario (por defecto `9`; poné `off` para no recibirlo).
  - `ALERT_REMIND_HOURS`: cada cuántas horas recordar algo caído (por defecto `6`; `0` lo apaga).
  - `ALERT_CONFIRM_CHECKS`: cuántos chequeos seguidos tienen que dar caído antes de avisar (por defecto `2`).

### Qué instancia usar

- Lo mejor es una instancia nueva en Evolution, por ejemplo `alertas`, con un chip aparte. Así los avisos no salen del número de ventas y te suenan como cualquier mensaje.
- Si usás la del bot de ventas (`tutu-ventas2`), funciona igual, pero no le respondas a los avisos: el bot te va a contestar como si fueras un cliente.
- No conectes la instancia con tu propio número: WhatsApp no te notifica los mensajes que te mandás a vos mismo.

### Cómo probar

En ABEL tocá la chapita **WhatsApp**. Ahí ves si las alertas están activadas y tenés los botones **Mandar mensaje de prueba** y **Mandar el reporte ahora**.

### Si no llegan

- "Faltan variables": cargá las que dice el panel en Railway.
- "Evolution respondió 401": la `EVOLUTION_API_KEY` está mal.
- "Evolution respondió 404": el nombre de la instancia está mal escrito o la instancia no existe.
- "Evolution respondió 400" o el mensaje no llega: revisá el número (549 + característica + número) y que la instancia esté conectada (estado `open`, si no hay que escanear el QR).
- Si la instancia se desconecta, ABEL no puede avisarte por WhatsApp; lo vas a ver en rojo en la chapita WhatsApp de la página.

## Cómo agregar o corregir un proyecto

Editá `projects.json`. Cada proyecto tiene:

- `id`: nombre corto sin espacios (el asistente lo usa para abrirlo)
- `name`, `group` (`tutu`, `bots`, `ayn`, `clientes`) y `desc`
- `urls`: los links a revisar
- `repos`: los repos exactos de GitHub, por ejemplo `osmarfernandez2555-cpu/RUTHINA`
- `railway`: palabras que aparecen en el nombre del servicio de Railway, por ejemplo `["compara"]`
- `evolution`: `{ "url": "...", "instance": "tutu-ventas2" }` para revisar un WhatsApp

Guardás, hacés commit y Railway lo redepliega solo.

## Si algo no anda

- La página dice "Contraseña incorrecta": revisá `APP_PASSWORD` en Variables (sin espacios al final).
- El chat responde "Todavía no tengo cerebro": falta `ANTHROPIC_API_KEY`.
- El chat responde "Claude devolvió model not found": cambiá `CLAUDE_MODEL` por un modelo que tenga tu cuenta, por ejemplo el mismo que usa Ruthina.
- La chapita de GitHub está amarilla o roja con "límite de consultas": poné `GITHUB_TOKEN`.
- La chapita de Railway dice "Not Authorized": el token es de proyecto o de otro workspace; creá uno de cuenta.
- Un servicio de Railway aparece en "Descubiertos" en vez de su grupo: agregá una palabra de su nombre en el campo `railway` del proyecto correcto.
- El micrófono no funciona: usá Chrome o Edge y dale permiso al micrófono (candado al lado de la dirección). En iPhone, Safari reconoce voz desde iOS 14.5 pero a veces hay que tocar el micrófono cada vez.
- Un proyecto con login aparece verde: es correcto, un 401/403 significa que está en línea y protegido.
- Un backend sin página de inicio ("Cannot GET /") aparece verde: está vivo.
- Deploy falla en Railway con error de Node: confirmá que `package.json` tiene `"node": "20.x"`.
