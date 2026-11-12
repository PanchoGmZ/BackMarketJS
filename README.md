# BackMarketJS

Actor de Apify que recibe una URL de producto de Back Market, obtiene la ficha con Firefox y valida los datos comerciales antes de guardar un registro con el contrato JSON 1688 de once campos.

## Tecnologias

Node.js 24, Apify SDK, Playwright Firefox, `proxy-chain` para autenticar Apify UNBLOCKER y Cheerio para procesar los datos Nuxt.

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

Instala las dependencias con `npm ci` y Firefox con `npx playwright install firefox`. Crea `input.json` en la raiz con `{"url":"https://www.backmarket.com/en-us/p/switch-lite"}` y ejecuta `apify run` desde PowerShell. Se abre Firefox visible con conexion directa. El archivo local se usa cuando no hay input explicito del SDK y no se utiliza en Apify Cloud. Los resultados se guardan en `storage/`. Si el sitio muestra un desafio o rechaza el acceso, el Actor termina con un diagnostico.

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
