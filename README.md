# BackMarketJS

Actor de Apify que recibe una URL de producto de Back Market, obtiene la ficha con Firefox y valida los datos comerciales antes de guardar un registro con el contrato JSON 1688 de once campos.

## Tecnologias

Node.js 24, Apify SDK, Playwright Firefox, `proxy-chain` para autenticar Apify UNBLOCKER en Cloud y Oxylabs Web Unblocker en local, y Cheerio para procesar los datos Nuxt.

## Estructura

```text
src/
  acquisition/  Firefox, pagina y proxy
  platform/     Actor y validacion del input
  product/      Parser Nuxt, identidad, extraccion, peso y contrato
  shared/       Limites, diagnosticos y utilidades
  main.js       Inicio del Actor
.actor/         Esquemas de input, Dataset y output de Apify
```

## Input

El formulario publico solicita un unico campo obligatorio: la URL HTTPS de una ficha de Back Market. El esquema valida el dominio y la ruta de producto. Firefox/Playwright, el proxy Apify UNBLOCKER en Cloud y la salida `reference1688` se configuran internamente. Inputs antiguos enviados por API se aceptan cuando sus campos tecnicos conocidos son validos, pero Cloud fuerza UNBLOCKER y no depende de `proxyAccessAuthorized`.

```json
{
  "url": "https://www.backmarket.com/en-us/p/ipad-air-2020-a14-series"
}
```

## Ejecucion en Apify

En el Actor existente de Apify, actualiza el codigo desde este repositorio y crea un build desde la raiz. Docker instala Firefox y sus dependencias Linux. Introduce solamente la URL del producto y ejecuta el Actor. Cloud selecciona Apify UNBLOCKER automaticamente; el acceso efectivo sigue sujeto a los permisos de la cuenta Apify. No hace falta seleccionar un navegador ni configurar opciones tecnicas.

## Ejecucion local en Windows

Instala las dependencias con `npm ci` y Firefox con `npx playwright install firefox`. Crea `input.json` en la raiz con `{"url":"https://www.backmarket.com/en-us/p/switch-lite"}` y ejecuta `apify run` desde PowerShell. Si no hay credenciales Oxylabs, se abre Firefox visible con conexion directa. El archivo local se usa cuando no hay input explicito del SDK y no se utiliza en Apify Cloud. Los resultados se guardan en `storage/`. Si el sitio muestra un desafio o rechaza el acceso, el Actor termina con un diagnostico.

#### Oxylabs Web Unblocker local

Node.js 24 carga `.env.local` automaticamente durante la ejecucion local. El archivo no se lee en Apify Cloud. Desde PowerShell, crea y abre el archivo:

```powershell
Copy-Item .env.local.example .env.local
notepad .env.local
```

Reemplaza `REEMPLAZAR_LOCALMENTE` en `OXYLABS_PASSWORD` por la contrasena de Oxylabs y guarda el archivo. El signo `=` puede escribirse directamente, por ejemplo `OXYLABS_PASSWORD=valor=resto`. No agregues la contrasena a `input.json`, al Input de Apify ni a archivos versionados. Con usuario y contrasena validos, el modo local selecciona `local-external-proxy` automaticamente: Firefox headless usa el puente `proxy-chain` en `127.0.0.1`, que autentica contra `https://unblock.oxylabs.io:60000`. No se usa perfil persistente ni espera de verificacion manual en este modo. Las excepciones de certificados necesarias se limitan a las conexiones de Oxylabs y a la respuesta HTTPS recibida mediante Web Unblocker; no se desactiva TLS globalmente.

Ejecuta la extraccion:

```powershell
apify run
```

Confirma en el log `[PROXY]` que aparece `mode: local-external-proxy` y `[PROXY_BRIDGE]` con `status: ready` y `listenHost: 127.0.0.1`. Los logs no imprimen la URL ni las credenciales del upstream. El Dataset local esta en `storage/datasets/default/`; el Dataset no se considerara verificado hasta que completes una extraccion.

Para volver al modo directo sin borrar las credenciales, ejecuta en esa misma ventana de PowerShell:

```powershell
$env:BACKMARKET_LOCAL_PROXY_MODE = 'direct'
apify run
```

Para volver al modo automatico despues, ejecuta `Remove-Item Env:BACKMARKET_LOCAL_PROXY_MODE`. Tambien puedes renombrar `.env.local` para que la siguiente ejecucion seleccione el modo directo. En modo directo se conserva Firefox visible, el diagnostico actual y la espera manual local de 10 segundos.

Si quieres solicitar Oxylabs explicitamente, puedes definir `$env:BACKMARKET_LOCAL_PROXY_MODE = 'oxylabs'`; si faltan usuario o contrasena, el Actor falla con `OXYLABS_CREDENTIALS_MISSING` en vez de cambiar a modo directo. El Input publico sigue teniendo solamente el campo `url`.

La espera manual local de la pagina de verificacion es de 10 segundos por defecto, limitada tambien por el presupuesto restante. Para utilizar los 30 segundos de la configuracion local anterior, ejecuta `$env:BACKMARKET_LOCAL_CHALLENGE_SECONDS = '30'` en PowerShell antes de `apify run`. Se admiten enteros entre 1 y 120; valores invalidos usan 10. La opcion solo afecta al modo local directo.

## Dataset

El Actor guarda un registro por URL con exactamente estas once claves:

`url`, `title`, `price`, `productLadderPrices`, `moq`, `weight`, `dimensions`, `images`, `characteristics`, `variations`, `productId`.

El precio solo se guarda si la oferta seleccionada se puede verificar contra el producto solicitado. Si falta evidencia o hay datos secundarios incompletos, el estado puede ser `partial` o `error`; el extractor no completa valores ausentes con datos inventados.

Las condiciones se representan en `variations`, dentro del grupo `grades` (o el identificador de condiciones recibido), conservando las etiquetas y el orden originales. Cada `price` corresponde a su condicion. Solo se publica si pertenece al mismo UUID, sin conflictos de slug o seleccion conocida y con precio, moneda y disponibilidad comprobables. Un picker que cambia color o almacenamiento no acredita el precio de esa condicion para el producto solicitado y queda con `price: null`. `PRODUCT_METADATA.variantGroups[].options[]` conserva moneda, disponibilidad y motivo de verificacion; el contrato de variantes no tiene una clave de moneda. `productLadderPrices` permanece vacio porque representa precios por volumen, no condiciones.

El peso se publica como numero en kg redondeado a dos decimales; el valor convertido original y su origen se conservan en metadata. Si un peso positivo quedara redondeado a cero, se devuelve `null` y se registra `POSITIVE_WEIGHT_BELOW_TWO_DECIMAL_PRECISION`.

Para URLs cortas se consideran URL final, canonical y JSON-LD vinculados a la pagina, ademas del estado Nuxt asociado a esa pagina y sus opciones seleccionadas. Si cambia el slug, la URL final solo se acepta con una redireccion registrada desde la URL solicitada. La identidad debe ser unica y la oferta y el precio deben corresponder al producto seleccionado. Sin UUID verificable se devuelve `SHORT_URL_IDENTITY_UNVERIFIED`; con UUIDs contradictorios, `SHORT_URL_IDENTITY_AMBIGUOUS`.

## Limitaciones

- Requiere acceso de cuenta al grupo Apify UNBLOCKER cuando el proxy esta habilitado.
- La informacion de la ficha puede variar por disponibilidad, seleccion comercial y cambios del sitio.
- El modo rapido no esta confirmado en Apify Cloud; usar el modo normal para produccion.
- La limpieza se valido offline con HTML de referencia; no se ejecutaron extracciones nuevas en Apify Cloud.
