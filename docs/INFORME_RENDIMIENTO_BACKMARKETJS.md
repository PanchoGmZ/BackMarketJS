# Rendimiento de BackMarketJS

## Resumen ejecutivo

Las extracciones rápidas observadas usaron Firefox normal y una sola navegación. En dos ejecuciones Cloud, la adquisición duró 2,36 y 3,16 s; también hay ejecuciones del mismo día que tardaron 24,12 y 36,62 s solo en adquirir el documento. Los registros no permiten atribuir toda la mejora a un cambio de código concreto: la duración hasta los encabezados y la lectura del cuerpo varió mucho. UNBLOCKER y el sitio están dentro de esa ruta de red; sus tiempos internos no se miden por separado.

## Arquitectura y camino crítico

Cloud: SDK de Apify → configuración UNBLOCKER → puente local proxy-chain → Firefox/Playwright → respuesta HTML y posibles datos comerciales → parser Nuxt y validaciones → Dataset → cierre. Local: Firefox visible y conexión directa; el mismo parser y Dataset. Los límites y el cierre son parte del flujo, no operaciones opcionales.

En modo normal `page.goto` usa `domcontentloaded`. En paralelo, el listener lee `response.body()` del documento; si el HTML contiene los indicadores comerciales, lo acepta y `Promise.race` puede continuar antes de terminar la espera de navegación. Esto no elimina la validación posterior ni garantiza que el cuerpo siempre esté completo. Si no sirve la respuesta se usa el DOM. Las esperas de tiempo máximo son límites, no pausas obligatorias; existe una espera de hasta 200 ms para tareas pendientes. El modo rápido `commit` y el bloqueo de imágenes/fuentes son opcionales, desactivados por defecto y no explican los ejemplos normales.

## Historial comprobado en Git

- `199c52d`: ya contenía captura del cuerpo de navegación, carrera entre HTML/navegación y una navegación. No se puede atribuir esa técnica a un cambio reciente de Firefox.
- `a1273f7`: evita volver a ejecutar la detección de desafío sobre el mismo HTML ya comprobado. Reduce trabajo duplicado, pero no hay medición aislada de su efecto.
- `3ec410c` y `51043ea`: incorporan Firefox y el puente de autenticación. Hicieron posible la arquitectura actual; no demuestran por sí solos una reducción de latencia.
- `a74f3b9`: incorpora métricas y modo rápido opcional. Las ejecuciones analizadas indican `mode: normal`.
- `e3c2958`: limpieza y consolidación del Actor Firefox. La respuesta de navegación y la carrera ya existían antes; el diff no demuestra que la limpieza causara las mejoras de red.
- `d14e508`, `f2dd584`, `98fab53`: correcciones comerciales y de identidad. No hay evidencia de que expliquen la disminución de latencia.
- `bb2e21b` y posteriores: modo local y espera manual, sin impacto previsto en la ruta Cloud.

## Mediciones disponibles

Las mediciones siguientes proceden de logs facilitados por el usuario. Los dos ejemplos rápidos tienen `HTML_LISTO` con `source: navigation-response`; el iPad Air terminó `partial` y el iPad Pro `success`, ambos con un registro.

| Métrica, segundos | iPad Air | iPad Pro | Otra ejecución | Otra ejecución |
|---|---:|---:|---:|---:|
| Inicio de Firefox | 0,309 | 0,342 | 0,378 | 0,337 |
| Inicio de navegación desde adquisición | 0,897 | 0,931 | 1,059 | 1,444 |
| Navegación a encabezados | 0,873 | 1,561 | 16,025 | 27,305 |
| Lectura de cuerpo | 0,162 | 0,186 | 4,426 | 5,575 |
| Cierre navegador | 0,429 | 0,480 | 2,502 | 2,194 |
| Adquisición, incluido cierre | 2,364 | 3,163 | 24,117 | 36,624 |
| Transformación completa | 0,097 | 0,174 | 2,909 | 4,698 |
| Dataset | 0,074 | 0,097 | 0,390 | 0,351 |
| Total Actor | 3,977 | 5,026 | 29,067 | 43,053 |

La métrica llamada `nuxtParserSeconds` refleja la etapa completa `extraction`, incluidas validaciones y transformación, no únicamente el parser Nuxt. Los tiempos de eventos pueden solaparse; no deben sumarse ciegamente. `domContentLoadedSeconds` en estos registros mide desde el inicio del intento y puede corresponder al documento inicial vacío: no prueba cuándo terminó el DOM comercial. `navigationWaitSeconds: null` indica que la respuesta ganó la carrera antes de que se registrara ese valor. Los logs recortan campos de `FIREFOX_TIMING`.

El usuario reportó además un iPhone 14 con adquisición de 3,96 s, transformación de ~0,175 s, Dataset ~0,067 s y total 16,60 s. No se dispone aquí del desglose completo verificable de esa ejecución ni de los logs completos de las ejecuciones anteriores de 43–64 s. El intervalo ACTOR/start, arranque de Node, importaciones, inicialización SDK y cierre no está desglosado suficientemente en todos los registros; no puede atribuirse una cifra exacta a cada componente. Para comparaciones futuras conservar timestamps de creación, entrada al proceso, inicialización SDK y FIN.

## Interpretación y límites

La comparación de logs muestra diferencias de 0,87 frente a 27,31 s hasta encabezados, y de 0,16 frente a 5,58 s en lectura de cuerpo. Eso basta para explicar una gran diferencia entre esas ejecuciones, sin identificar su causa. La respuesta del proxy, destino, red y tamaño/contenido pueden influir, pero no se han medido independientemente. No hay evidencia para atribuirlo a IP, cookies, caché, sesiones o Cloudflare. Tampoco hay una prueba controlada antes/después con la misma ficha y condiciones. No prometer tiempos constantes de 4–5 s.

## Transferencia a BackMarketBuscador

Revisión de solo lectura de `backmarket-buscador/src`: el buscador usa Undici `fetch` y `ProxyAgent`, lee el cuerpo por streaming con límite de 4 MiB, valida HTML y cierra el dispatcher. Ya hace una solicitud principal sin reintentos en Cloud; en directo sigue redirecciones limitadas y validadas. Solo admite la página 1 verificada. Procesa tarjetas de búsqueda, no el estado Nuxt y oferta seleccionada de una ficha. El margen de 30 s en `runtime.js` es un presupuesto documentado, no un `sleep`; no se identificó una espera fija equivalente en la ruta de adquisición.

**Alta prioridad:** añadir tiempos separados y monotónicos de configuración proxy, solicitud hasta encabezados, lectura de cuerpo, parseo, Dataset y cierre; registrar bytes y conteos sin credenciales ni consultas. El buscador ya registra tiempo HTTP total, Dataset y parseo en diagnóstico, pero no separa encabezados/cuerpo ni cierre. Mantener el contrato y los límites.

**Prioridad media:** medir CPU y asignaciones del parser con HTML real guardado y comparar costos de concatenación de chunks (`Buffer.from`/`Buffer.concat`). Cambiar únicamente si la medición justifica el riesgo y se verifican resultados, límites y multibyte. Medir diferencias por tamaño y cantidad de tarjetas. Evaluar reutilización de conexiones solo para varias solicitudes autorizadas dentro de una misma ejecución; hoy hay una solicitud principal.

**Prioridad baja:** experimentar con otros transportes o estrategias de concurrencia solo tras pruebas controladas. La captura de `response.body()` de Playwright, `domcontentloaded`, arranque/cierre de Firefox y bloqueo de recursos no se trasladan directamente a Undici. Migrar de transporte podría cambiar redirects, TLS, autenticación, compresión y resultados. No se recomienda migrar a Firefox por estos logs.

## Plan de pruebas del buscador

1. Establecer línea base con fixtures auténticos y comparar exactamente Dataset, deduplicación, precios, resultados vacíos y errores.
2. Medir encabezados, cuerpo, parseo, escritura y cierre por separado, sin reducir timeouts ni introducir reintentos.
3. Aplicar una mejora por vez; repetir pruebas offline de límites de bytes, Unicode, redirecciones y bloqueos.
4. Solo con autorización y presupuesto, comparar en Cloud varias ejecuciones de las mismas consultas, con misma configuración y distribución de tiempos; registrar fallos y no atribuir causalidad a una sola muestra.
5. Verificar que no cambien contrato, seguridad de credenciales ni el comportamiento de acceso antes de publicar.
