# Back Market URL Extractor - JavaScript

Version independiente del Actor Python de TU CUMPA. Node.js 22+ (Docker Node 24), Apify SDK, Playwright y Cheerio. Prioriza el parser Nuxt que produjo resultados en Python. No necesita Python, Crawl4AI, LLM ni servicios de IA.

## Estado comprobado

- Comparacion offline exacta de los once campos con las capturas comerciales autenticas y las salidas Python guardadas del iPhone 15 Plus (413 USD) e iPhone 14 Pro (379 USD).
- El JSON Python del iPhone 14 Plus (299 USD, 6 imagenes, 27 caracteristicas, 4 grupos y 15 opciones) fue facilitado por el usuario. Se valida su contrato y peso de 7 oz. Falta su HTML/Nuxt o respuestas originales para repetir su transformacion desde los mismos datos.
- No se ha ejecutado navegacion real de esta version JavaScript ni un run de Apify Cloud. Las pruebas de transporte utilizan dobles de Playwright, sin sockets.
- Dockerfile preparado; Docker Desktop esta instalado pero el motor Linux no esta disponible. La imagen no se ha construido.

El Actor Python original y su repositorio permanecen intactos. Esta carpeta debe publicarse, si se desea, en OTRO repositorio y en OTRO Actor.

## Entrada

Introduce una ficha HTTPS completa de www.backmarket.com/en-us/p/slug/UUID. Se aceptan los parametros l y offerType; se conserva la seleccion. Se rechazan otros dominios, credenciales, fragmentos, parametros desconocidos y enlaces sin UUID.

    {
      "url": "PEGA_AQUI_UNA_URL_COMPATIBLE",
      "outputFormat": "reference1688",
      "diagnosticMode": false,
      "diagnosticTimeoutSeconds": 180,
      "proxyConfiguration": { "useApifyProxy": false },
      "proxyAccessAuthorized": false
    }

Los identificadores de prueba solo aparecen en fixtures. El extractor obtiene el UUID dinamicamente de la URL.

## Ejecucion local con F5

1. Abre esta carpeta JavaScript en VS Code.
2. Ejecuta npm ci si trasladas el proyecto a otra computadora.
3. Edita storage/key_value_stores/default/INPUT.json y guarda la URL.
4. Selecciona "Back Market JS - Extraer producto" en Run and Debug y pulsa F5.
5. Revisa storage/datasets/default/ y RUN_STATE/PRODUCT_METADATA en storage/key_value_stores/default/.

La configuracion F5 importa INPUT.json al SDK. Se usa el nombre estandar para que el SDK conserve el archivo editable al limpiar sus registros locales de ejecucion. El SDK inicializa el almacenamiento local de este proyecto; sus registros no son los del Actor Python. En Windows se utiliza el Chrome existente mediante Playwright, visible y con perfil temporal nuevo. En Linux se usa Chromium headless; instalarlo con npx playwright install --with-deps chromium si ejecutas fuera de Docker.

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
- Identidad no verificada o documento de verificacion: no se guarda un producto inventado. Datos incompletos verificables: partial. Errores y bloqueos: diagnosticos separados. Un producto HTTP 200 previo y ya valido puede conservarse con estado blocked/error si ocurre un fallo posterior.

No se guardan HTML completo, configuracion de pagos, cookies, perfiles ni credenciales. Los fixtures HTML son capturas comerciales filtradas ya existentes.

## Adquisicion, red y TLS

Una sola page.goto() con domcontentloaded, sin networkidle, reintentos, navegaciones adicionales ni peticiones directas a endpoints. Los eventos HTTP se registran antes de navegar. Se aprovecha HTML Nuxt completo temprano y JSON comercial que la pagina haya solicitado normalmente.

Documento principal o fuente comercial con 401/403 o desafio explicito: parada. HTTP 502 del documento: error de adquisicion. Reseñas 403: error opcional, sin descartar el producto. /testchallengepage: ACCESS_CHALLENGE. No se implementa resolucion de desafios, cambio de identidad ni rotacion de IP ante una denegacion.

Apify Proxy esta apagado por defecto. Para una fuente autorizada, selecciona grupos disponibles en la cuenta y confirma proxyAccessAuthorized. El SDK usa la autenticacion del entorno Apify; no se admiten URLs privadas ni credenciales en el input.

- Datacenter y RESIDENTIAL: una URL y una sesion interna por trabajo.
- UNBLOCKER: grupo unico y newUrl() SIN sessionId. No se mezcla con Residential ni se garantiza IP persistente.
- configured solo acredita la configuracion del SDK. connected requiere una respuesta HTTP observada del documento; HTTP 200 no acredita por si solo una extraccion valida.
- Los servicios pueden generar cargos; el tiempo y la memoria NO constituyen un presupuesto monetario. No se activan automaticamente.

TLS se verifica en conexion directa y Residential (`ignoreHTTPSErrors=false`). Solo con UNBLOCKER se establece `ignoreHTTPSErrors=true` en el contexto real de Playwright y se registra `[TLS] verified=false`; es una excepcion temporal de diagnostico para observar la respuesta posterior al error de CA. En ese modo Chromium no valida la identidad HTTPS del servidor. No es seguro para produccion ni debe considerarse una solucion de confianza TLS. No se modifica la verificacion TLS de los otros modos.

Documentacion: https://docs.apify.com/sdk/js/docs/concepts/proxy-management
y https://docs.apify.com/proxy/unblocker

## Tiempos y recursos

Modo normal: maximo interno de 55 s desde el proceso/inicio Apify disponible, adquisicion hasta 48 s y trabajo hasta 52 s. Diagnostico: limite 30..180 s, adquisicion hasta total-20 s y trabajo hasta total-2 s. Apify debe tener un timeout externo acorde (55 s normal; 180 s diagnostico). Una sola pagina/concurrencia 1.

BACKMARKET_TIMEOUT_SECONDS permite reducir adquisicion normal (5..48). BACKMARKET_MAX_HTML_BYTES: 1024..8388608 (predeterminado 4194304). BACKMARKET_MAX_MEMORY_MB: 256..2048 (predeterminado 1024).

En Linux con cgroups se observa memoria del contenedor. Fuera de cgroups se registra solo RSS de Node, no el total de Chromium; el limite de memoria del run de Apify sigue siendo necesario. Los timers Node no interrumpen codigo sincronico bloqueado; tamanos/grafos estan acotados y el timeout externo es la salvaguarda final. No se ha medido latencia Cloud ni garantizado el limite externo de 60 s con arranque frio.

Logs: INICIO, LIMITES, PROXY, TLS, HTTP, CUERPO, REDIRECCION, CAUSA_NAVEGACION, HTML_LISTO, DOCUMENTO_PRODUCTO, PRECIO_VERIFICADO, PESO, DATOS_FALTANTES, GUARDADO y FIN. RUN_STATE conserva etapas, HTTP, CF-Ray disponible, tiempos, estado y numero de resultados. Ninguna excepcion bruta se imprime.

## Validacion

    npm test
    npm run test:sdk-offline
    node scripts/validate.js
    apify validate-schema
    npm run validate:reference -- --source test/fixtures/reference/393000c0-1f19-43fc-9f89-e6faf3f3bd46/commercial.html --expected test/fixtures/reference/393000c0-1f19-43fc-9f89-e6faf3f3bd46/python-output.json

Las pruebas no hacen scraping, no lanzan navegador real y no consumen proxy. Incluyen equivalencia autentica, serializacion Nuxt sintetica de esos mismos datos, precios/IDs, pesos, privacidad, proxy/sesiones, HTTP, contrato y ciclo SDK simulado. La comprobacion offline real del SDK usa almacenamiento nuevo separado. No convierte una captura en prueba de acceso actual.

## Crear un Actor JavaScript separado en Apify

1. Publica SOLO esta carpeta en un repositorio nuevo, revisando las exclusiones. No sobrescribas el repositorio Python.
2. En Apify Console crea otro Actor, por ejemplo backmarket-url-extractor-js, fuente Git y rama del repositorio nuevo.
3. Construye con este Dockerfile y Node 24. El build instala Chromium con sus bibliotecas de sistema.
4. Primera prueba manual autorizada: memoria 2048 MB, diagnosticMode=true y timeout de run 180 s. Mantener proxy desactivado salvo configuracion y permisos explicitos.
5. Compara el JSON y PRODUCT_METADATA con la version Python usando el MISMO producto/seleccion y datos contemporaneos. Los precios pueden cambiar.
6. Solo tras validar navegacion, dos productos, TLS, precios/pesos y presupuestos, considera sustituir la integracion. El Actor Python sigue siendo la referencia.

No se ha creado un Actor, desplegado, hecho login, commit ni push desde esta preparacion.

## Diferencias conocidas

- Migracion inicial solo Nuxt, JSON incrustado y respuestas comerciales observadas. Los metodos Playwright DOM/Crawl4AI CSS no se han portado.
- No hay pipeline Markdown ni Crawl4AI. Playwright entrega HTML/JSON y Cheerio inspecciona scripts.
- TLS estricto tambien para Unblocker. Esto puede impedir el acceso que dependia del ignore inseguro del prototipo.
- JSON-LD aislado se diagnostica como parcial y no se guarda sin identidad comercial verificada.
- Metricas de memoria y cierre usan APIs Node/cgroup; no son las mediciones privadas de psutil.
- El caso iPhone 14 Plus necesita el payload de origen para comparar los once campos desde la misma entrada comercial. Su salida esperada se conserva sin inventar fuentes.
- Build Docker y extraccion real Node en Cloud pendientes.
