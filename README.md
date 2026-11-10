# Back Market URL Extractor - JavaScript

Version independiente del Actor Python de TU CUMPA. Node.js 22+ (Docker Node 24), Apify SDK, Playwright, Undici y Cheerio. Tres transportes seleccionables comparten el parser Nuxt que produjo resultados en Python. No necesita Python, Crawl4AI, LLM ni servicios de IA.

## Estado comprobado

- Comparacion offline exacta de los once campos con las capturas comerciales autenticas y las salidas Python guardadas del iPhone 15 Plus (413 USD) e iPhone 14 Pro (379 USD).
- El JSON Python del iPhone 14 Plus (299 USD, 6 imagenes, 27 caracteristicas, 4 grupos y 15 opciones) fue facilitado por el usuario. Se valida su contrato y peso de 7 oz. Falta su HTML/Nuxt o respuestas originales para repetir su transformacion desde los mismos datos.
- El usuario ha confirmado extracciones reales de telefonos en Apify Cloud. La ampliacion de URLs cortas se valida offline; las pruebas de transporte utilizan dobles de Playwright, sin sockets.
- Firefox normal con proxy-chain + UNBLOCKER queda confirmado por el usuario en dos fichas Cloud: un iPhone 14 con `success` y once campos, y un iPhone 12 Pro Max con `partial` por datos secundarios de variantes. El modo rápido nuevo sigue pendiente de comparación real.
- Dockerfile preparado; Docker Desktop esta instalado pero el motor Linux no esta disponible. La imagen no se ha construido.

El Actor Python original y su repositorio permanecen intactos. Chromium, Firefox y Undici pertenecen a este mismo BackMarketJS y al mismo Actor existente.

## Entrada

Introduce una ficha HTTPS de `www.backmarket.com/en-us/p/slug/UUID` o una URL corta `www.backmarket.com/en-us/p/slug`. Se aceptan los parametros comerciales comprobados `l` y `offerType`; se conserva la URL y su seleccion. Otros parametros se rechazan expresamente hasta contar con evidencia de su uso, sin descartarlos silenciosamente. Se rechazan otros dominios, credenciales, fragmentos, categorias y busquedas.

Las fichas con UUID conservan la verificacion existente. Para una URL corta, el UUID debe proceder de la URL final de la misma navegacion, de un canonical con el mismo slug de la pagina solicitada/final, o de un Product JSON-LD asociado a esa pagina. Las evidencias contradictorias se rechazan. No se sigue el canonical con otra solicitud. El parser Nuxt actual verifica despues el producto y el precio seleccionado; en esta via tambien se exige que la oferta o alguna opcion seleccionada declare el mismo UUID. Solo entonces se vincula la identidad al input interno para pasar la comprobacion existente del Actor. `PRODUCT_METADATA.productIdentity` conserva el origen. No se elige el primer UUID de una cache ni un producto recomendado.

Sin identidad u oferta verificables se devuelve `SHORT_URL_IDENTITY_UNVERIFIED`, `SHORT_URL_IDENTITY_AMBIGUOUS` o `SHORT_URL_SELECTED_OFFER_UNVERIFIED`, sin guardar un producto falso. Las URLs cortas se resuelven con el HTML ya recibido; no se atribuyen respuestas JSON de UUID desconocidos ni se hacen peticiones para descubrir variantes. Una pagina de familia sin seleccion comercial explicita puede no ser extraible por esta via.

**Pendiente de Cloud:** iPad Air 2022, MacBook Pro M3, Apple Watch Series 11 y Xbox Series S. Sus cuatro URLs se admiten estructuralmente; no hay HTML comercial local de estas categorias y no se afirma extraccion completa. Las pruebas de alias usan capturas autenticas de telefonos con anclas/serializacion de prueba claramente sinteticas; no son capturas de nuevas categorias. Los grupos de variantes se siguen leyendo dinamicamente. Peso y dimensiones conservan su normalizacion y ausencia existentes; no se agregan valores ni reglas de categoria sin evidencia.

    {
      "url": "PEGA_AQUI_UNA_URL_COMPATIBLE",
      "transport": "firefox",
      "firefoxFastMode": false,
      "outputFormat": "reference1688",
      "diagnosticMode": false,
      "diagnosticTimeoutSeconds": 180,
      "disableHttp2": false,
      "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["UNBLOCKER"] },
      "proxyAccessAuthorized": false
    }

Los identificadores de prueba solo aparecen en fixtures y pruebas. El extractor obtiene el UUID dinamicamente de la URL o de las evidencias comerciales verificadas de una ficha corta.

En Apify, el selector **Transporte de adquisicion** ofrece `firefox`, `chromium` y `undici`. Si falta `transport`, se utiliza Firefox en modo normal; Chromium sigue disponible seleccionándolo explícitamente y Undici continúa experimental. Firefox usa Playwright + proxy-chain y comparte la adquisición de documento, el parser y las validaciones. Sus fichas reales en Cloud fueron confirmadas por el usuario. `firefoxFastMode` está desactivado por defecto; al activarlo, Firefox navega con `waitUntil: "commit"` y bloquea solo imágenes, fuentes y multimedia del navegador. Los scripts y las solicitudes XHR/fetch siguen activos. `extractionMethod` sigue siendo `nuxt` en estado y metadata; no se reutiliza para elegir transporte. No hay fallback automático.

Input concreto para una prueba manual Undici en el Actor existente (la oferta/precio actual puede cambiar):

```json
{
  "url": "https://www.backmarket.com/en-us/p/iphone-15-plus-128-gb-yellow-unlocked/eda80a12-a40b-4faa-b0f6-438bea90f1e5?l=12&offerType=0",
  "transport": "undici",
  "outputFormat": "reference1688",
  "diagnosticMode": true,
  "diagnosticTimeoutSeconds": 180,
  "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["UNBLOCKER"] },
  "proxyAccessAuthorized": true
}
```

El usuario ejecutara las pruebas Cloud; no se han solicitado fichas reales con este modulo. El formulario nuevo requiere construir la version actualizada del mismo Actor desde `origin/main`. No hay que crear otro Actor. Para comparar, utiliza la misma URL/seleccion y cambia solo `transport`; configura un timeout externo de 180 s en este ejemplo.

Firefox se instala junto con Chromium en Docker con `npx playwright install --with-deps chromium firefox`. `package-lock.json` fija Playwright 1.64.1 y Firefox revision 1555 (Firefox 157.0). La dependencia `proxy-chain` 3.0.1 admite Node 20.11+ y se instala en la imagen mediante `npm ci`. Para Firefox, `anonymizeProxy()` conserva el proxy autenticado del SDK como upstream y devuelve un proxy HTTP local en `127.0.0.1`; Firefox recibe solo esa dirección sin credenciales. proxy-chain gestiona autenticación Basic upstream y túneles HTTPS CONNECT. Las pruebas offline verifican loopback, cierre, opciones y clasificación. Firefox mantiene `ignoreHTTPSErrors` limitado al contexto actual para UNBLOCKER.

Input para probar Firefox en el mismo Actor:

```json
{
  "url": "https://www.backmarket.com/en-us/p/iphone-14-128-gb-midnight-att/ec6b3e5e-676e-40f9-91a6-1c9d8537209b?l=12",
  "transport": "firefox",
  "firefoxFastMode": false,
  "diagnosticMode": true,
  "diagnosticTimeoutSeconds": 180,
  "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["UNBLOCKER"] },
  "proxyAccessAuthorized": true
}
```

Para comparar el modo rápido, cambia solo `firefoxFastMode` a `true`; usa la misma URL, selección, proxy autorizado y presupuesto de diagnóstico. Compara identidad, precio, imágenes, variantes, contrato del Dataset y `FIREFOX_TIMING` con una ejecución normal contemporánea. El modo rápido no está validado en Cloud.

## Ejecucion local con F5

1. Abre esta carpeta JavaScript en VS Code.
2. Ejecuta npm ci si trasladas el proyecto a otra computadora.
3. Edita storage/key_value_stores/default/INPUT.json y guarda la URL.
4. Selecciona "Back Market JS - Extraer producto" en Run and Debug y pulsa F5.
5. Revisa storage/datasets/default/ y RUN_STATE/PRODUCT_METADATA en storage/key_value_stores/default/.

La configuracion F5 importa INPUT.json al SDK. Se usa el nombre estandar para que el SDK conserve el archivo editable al limpiar sus registros locales de ejecucion. El SDK inicializa el almacenamiento local de este proyecto; sus registros no son los del Actor Python. En Windows se utiliza Chrome para Chromium; Firefox requiere el binario Playwright instalado localmente. En Linux se usan Chromium/Firefox headless; instala ambos con `npx playwright install --with-deps chromium firefox` si ejecutas fuera de Docker.

Desde terminal:

    npm start -- --input storage/key_value_stores/default/INPUT.json

Prueba offline del SDK (no abre navegador; estado partial y dataset separado offline-validation):

    npm start -- --input test/fixtures/reference/eda80a12-a40b-4faa-b0f6-438bea90f1e5/python-output-input.json --offline test/fixtures/reference/eda80a12-a40b-4faa-b0f6-438bea90f1e5/commercial.html

Ese archivo de input de prueba contiene solo la URL de la captura correspondiente. No se utiliza como input predeterminado.

## Resultados y contrato

Un producto agregado se guarda mediante Actor.pushData() en el Dataset predeterminado. Los esquemas .actor/dataset_schema.json y .actor/output_schema.json enlazan ese Dataset a Runs -> Results/Output.

Exactamente once campos: url, title, price, productLadderPrices, moq, weight, dimensions, images, characteristics, variations, productId.

- price: cadena de selectedOffer.price.amount, nunca priceWhenNew ni precio JSON-LD. La moneda y la seleccion se verifican contra IDs y precios de las opciones seleccionadas. Una inconsistencia deja price=null.
- characteristics: objetos {attrName,attrValue}.
- variations: grupos {name,variants:[{name,price,image}]}; solo opciones publicadas, sin producto cartesiano.
- currency, oferta, disponibilidad, IDs, seleccion y procedencia del peso: PRODUCT_METADATA, fuera de los once campos.
- weight: {value,unit:"kg"} o null. Conversion explicita de g/kg/oz/lb, limites de plausibilidad por tipo de producto y exclusion del peso de envio. Solo el modelo estructurado exacto Apple/iPhone 15 Plus admite la referencia oficial de 201 g; nunca se aplica a otro modelo.
- moq y dimensions: null; precios escalonados: []. La forma null/array de cada campo conserva el contrato Python.
- Identidad o precio seleccionado no verificados: error y no se guarda el producto. Un producto live con identidad y precio seleccionados verificados se guarda una vez y termina con exit code 0 aunque las opciones alternativas tengan metadatos incompletos; `RUN_STATE.status` y `PRODUCT_METADATA.missingFields` mantienen `partial` y la lista de advertencias. Fallos de persistencia son errores. Un producto HTTP 200 previo y ya valido puede conservarse con estado blocked/error si ocurre un fallo posterior.

No se guardan HTML completo, configuracion de pagos, cookies, perfiles ni credenciales. Los fixtures HTML son capturas comerciales filtradas ya existentes.

## Adquisicion, red y TLS

Con `chromium`: una sola page.goto() normal con domcontentloaded, sin networkidle ni peticiones directas a endpoints. Si `page.goto()` falla exclusivamente con `CHROMIUM_ERR_TOO_MANY_RETRIES` y no se observó respuesta HTTP del documento principal, el Actor cierra Chromium, espera 2,5 s y permite un segundo intento en un navegador nuevo. Máximo dos navegaciones en total; usa la misma URL, proxy y presupuesto acumulado, y omite la recuperación si no quedan al menos 12 s útiles después de la espera. No reintenta respuestas HTTP, autenticación, TLS, desafíos ni restricciones. Ambos intentos y sus tiempos quedan en `RUN_STATE.acquisition.attempts`; la falla inicial también se conserva en `recovery.initialFailure`. El resultado final solo se considera recuperado después de verificar producto/precio y guardar el registro.

Con `undici`: `src/http_undici.js` recibe la URL completa y hace una llamada fetch con dispatcher propio (Agent en directo o ProxyAgent con las credenciales oficiales del SDK). Conserva `l`/`offerType`, usa HTTP/1.1 y `Accept: text/html`, no sigue redirecciones y no hace peticiones a APIs. Un 3xx se rechaza; las URLs cortas que necesiten redireccionar pueden no funcionar en esta primera version. No hay navegador, hidratacion, cookies de navegacion ni JSON generado por JS. El HTML recibido pasa al mismo `extractHtml`, verificaciones y Dataset. `disableHttp2` solo afecta a Chromium.

Undici aplica el limite de bytes al stream decodificado, incluso si el HTML esta comprimido. Su timeout cubre headers y cuerpo, respeta el presupuesto global y `timeoutSeconds`, y reserva dos segundos para cancelar/cerrar recursos. Cierra el dispatcher, con destroy acotado si falla el cierre normal. Registra HTTP 403/429 y fallos de TLS, DNS, TCP, CONNECT y timeout con codigos seguros; nunca imprime errores brutos. Undici fetch puede ocultar los detalles de un HTTP 407 del destino: sin evidencia se conserva NETWORK_ERROR; un 407 observado o de CONNECT se identifica como PROXY_AUTH_ERROR. `httpRequestCount` cuenta llamadas de la aplicacion, no reinicios internos del cliente o del proveedor.

**Limitacion comercial pendiente:** preservar la URL no demuestra que el servidor haya aplicado `l`/`offerType`. El parser existente conserva su verificacion de coherencia comercial, incluida la limitacion auditada de las URLs largas con oferta sin productId y cero opciones seleccionadas. No se ha reforzado ni relajado el parser en este cambio. No se debe dar por confirmada la equivalencia HTTP hasta contrastar fichas, ofertas y variantes reales con la version estable. Si faltan identidad u oferta verificables, no hay datos inventados ni fallback.

Documento principal o fuente comercial con 401/403 o desafio explicito: parada. HTTP 502 del documento: error de adquisicion. Reseñas 403: error opcional, sin descartar el producto. /testchallengepage: ACCESS_CHALLENGE. No se implementa resolucion de desafios, cambio de identidad ni rotacion de IP ante una denegacion.

UNBLOCKER queda seleccionado por defecto, tanto en el formulario como cuando falta `proxyConfiguration` en la entrada. Puedes desactivarlo (`useApifyProxy:false`) o elegir otro grupo; una configuracion explicita tiene prioridad. Confirma `proxyAccessAuthorized` para declarar que el uso esta autorizado y presupuestado. `Actor.createProxyConfiguration()` valida el acceso al grupo mediante el SDK. Si el grupo no esta habilitado para la cuenta, el Actor falla con `APIFY_PROXY_GROUP_UNAVAILABLE`, sin cambiar a conexion directa ni a otro proxy. El SDK usa la autenticacion del entorno Apify; no se admiten URLs privadas ni credenciales en el input. La recuperación Chromium descrita arriba no rota manualmente IPs y no aplica a denegaciones de acceso.

- Datacenter y RESIDENTIAL: una URL y una sesion interna por trabajo.
- UNBLOCKER: grupo unico y newUrl() SIN sessionId. No se mezcla con Residential ni se garantiza IP persistente.
- configured solo acredita la configuracion del SDK. connected requiere una respuesta HTTP observada del documento; HTTP 200 no acredita por si solo una extraccion valida.
- Los servicios pueden generar cargos; el tiempo y la memoria NO constituyen un presupuesto monetario. No se activan automaticamente.

TLS se verifica en conexion directa y Residential. En Chromium sigue intacta la excepcion `ignoreHTTPSErrors=true` solo para UNBLOCKER. En Undici solo con proxy UNBLOCKER se aplica `requestTls.rejectUnauthorized=false` al dispatcher propio; `proxyTls` conserva su configuracion predeterminada. No se usa `NODE_TLS_REJECT_UNAUTHORIZED` ni se cambia TLS global. `[TLS] verified=false` indica que no se valida la identidad HTTPS del destino; es una excepcion temporal de diagnostico, no una solucion de confianza TLS para produccion.

`ERR_TOO_MANY_RETRIES` conserva causa subyacente `undetermined`. La [definicion de Chromium](https://chromium.googlesource.com/chromium/src/+/main/net/base/net_error_list.h) contempla reintentos internos por autenticacion o certificados y posibles fallos de su pila de red; el codigo solo no demuestra bloqueo de IP ni identifica cual ocurrio. La unica recuperacion de aplicacion es el segundo intento acotado descrito arriba; no se agregan otros reintentos ni fallback. En `RUN_STATE.acquisition.navigationError` y `attempts` se guardan categoria, origen, duracion, respuestas HTTP, causa del intento inicial y senales de `requestfailed`. `[PROXY_TRANSPORTE]` registra solo presencia de los campos de autenticacion, nunca sus valores; no acredita autenticacion exitosa.

Documentacion: https://docs.apify.com/sdk/js/docs/concepts/proxy-management
y https://docs.apify.com/proxy/unblocker

## Tiempos y recursos

Experimento opcional: `disableHttp2` es `false` por defecto. Al ponerlo en `true`, se agrega unicamente `--disable-http2` a `chromium.launch({args: [...]})`, conservando los argumentos predeterminados de Playwright. `[PROXY_TRANSPORTE] http2Disabled` y `RUN_STATE.acquisition.http2Disabled` registran la opcion enviada. El [codigo oficial de Chromium](https://chromium.googlesource.com/chromium/src/+/main/components/network_session_configurator/browser/network_session_configurator.cc) desactiva HTTP/2 con ese argumento; [Playwright admite argumentos adicionales](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-args). No se desactiva QUIC/HTTP3 ni se modifica TLS, User-Agent o proxy. El argumento no controla el protocolo entre Unblocker y el destino ni prueba cual se negocio. Para comparar, utiliza el mismo build/input y cambia solo `disableHttp2`; contrasta HTTP, errores, tiempos y producto guardado. Una diferencia aislada no demuestra que HTTP/2 cause `ERR_TOO_MANY_RETRIES`.

Modo normal: maximo interno de 55 s desde el proceso/inicio Apify disponible, adquisicion hasta 48 s y trabajo hasta 52 s. Diagnostico: limite 30..180 s, adquisicion hasta total-20 s y trabajo hasta total-2 s. Apify debe tener un timeout externo acorde (55 s normal; 180 s diagnostico). Una sola pagina/concurrencia 1.

BACKMARKET_TIMEOUT_SECONDS permite reducir adquisicion normal (5..48). BACKMARKET_MAX_HTML_BYTES: 1024..8388608 (predeterminado 4194304). BACKMARKET_MAX_MEMORY_MB: 256..2048 (predeterminado 1024).

En Linux con cgroups se observa memoria del contenedor. Fuera de cgroups se registra solo RSS de Node, no el total de Chromium; el limite de memoria del run de Apify sigue siendo necesario. Los timers Node no interrumpen codigo sincronico bloqueado; tamanos/grafos estan acotados y el timeout externo es la salvaguarda final. No se ha medido latencia Cloud ni garantizado el limite externo de 60 s con arranque frio.

Logs: INICIO, TRANSPORTE, LIMITES, PROXY, PROXY_BRIDGE, TLS, INTENTO, INTENTO_RESULTADO, RECUPERACION, ESPERA_RECUPERACION, RECUPERACION_OMITIDA, HTTP, CUERPO, REDIRECCION, CAUSA_NAVEGACION, HTML_LISTO, TIEMPO_ADQUISICION, DOCUMENTO_PRODUCTO, PRECIO_VERIFICADO, PESO, DATOS_FALTANTES, GUARDADO, RECUPERACION_EXITOSA, RECUPERACION_FALLIDA y FIN. RUN_STATE y PRODUCT_METADATA registran `transport` por separado de `extractionMethod`. `TIEMPO_ADQUISICION.seconds` y `RUN_STATE.timings.acquisition` incluyen adquisicion, espera y cierre; `FIN.seconds` conserva la duracion total observada hasta la finalizacion del trabajo. RUN_STATE conserva intentos, navegaciones, HTTP, CF-Ray disponible, tiempos, estado y numero de resultados. Ninguna excepcion bruta se imprime.

## Validacion

    npm test
    npm run test:sdk-offline
    node scripts/validate.js
    apify validate-schema
    npm run validate:reference -- --source test/fixtures/reference/393000c0-1f19-43fc-9f89-e6faf3f3bd46/commercial.html --expected test/fixtures/reference/393000c0-1f19-43fc-9f89-e6faf3f3bd46/python-output.json

Las pruebas no hacen scraping, no lanzan navegador real y no consumen proxy. Incluyen equivalencia autentica, serializacion Nuxt sintetica de esos mismos datos, precios/IDs, pesos, privacidad, proxy/sesiones, HTTP, contrato y ciclo SDK simulado. La comprobacion offline real del SDK usa almacenamiento nuevo separado. No convierte una captura en prueba de acceso actual.

## Probar los tres transportes en el Actor existente

1. Usa el mismo repositorio BackMarketJS, rama `main`, y el mismo Actor JavaScript ya configurado en Apify.
2. Construye la nueva version cuando quieras probarla; no se han cambiado ajustes de la cuenta ni desplegado desde esta integracion.
3. Conserva ambos navegadores instalados; Firefox normal es ahora el transporte predeterminado y Chromium sigue disponible.
4. Compara `transport: "firefox"` primero con `firefoxFastMode: false` y luego `true`, con proxy autorizado, diagnosticMode=true y timeout externo 180 s.
5. Compara contra `transport: "chromium"` con el MISMO producto/seleccion y datos contemporaneos; los precios pueden cambiar. Revisa JSON y PRODUCT_METADATA, no solo HTTP 200.
6. Usa `transport: "undici"` como metodo experimental independiente.
7. Antes de retirar un motor, comprueba otras selecciones, variantes, URLs cortas y latencia real. La referencia Git de Firefox normal validado es `stable/firefox-proxy-chain-cloud-20261110`.

No se ha creado otro Actor ni ejecutado scraping, pruebas Cloud o solicitudes pagadas durante esta optimización. La confirmación de Firefox normal corresponde a las ejecuciones Cloud informadas por el usuario; las pruebas de modo rápido quedan a su cargo.

## Diferencias conocidas

- Migracion inicial solo Nuxt, JSON incrustado y respuestas comerciales observadas. Los metodos Playwright DOM/Crawl4AI CSS no se han portado.
- No hay pipeline Markdown ni Crawl4AI. Playwright entrega HTML/JSON y Cheerio inspecciona scripts.
- La excepcion temporal TLS de UNBLOCKER se conserva por transporte; no acredita confianza HTTPS.
- JSON-LD aislado se diagnostica como parcial y no se guarda sin identidad comercial verificada.
- Metricas de memoria y cierre usan APIs Node/cgroup; no son las mediciones privadas de psutil.
- El caso iPhone 14 Plus necesita el payload de origen para comparar los once campos desde la misma entrada comercial. Su salida esperada se conserva sin inventar fuentes.
- Build Docker real y comparación de latencia/contenido del modo rápido pendientes.
