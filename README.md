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

El Actor procesa una URL HTTPS de `www.backmarket.com/en-us/p/...`, con UUID o con una identidad explicita verificable en el documento. Conserva la URL completa, incluidos `l`, `offerType`, parametros picker adicionales y fragmentos. No se asume que omitir `closestPickerConfig` o `pickerClicked` sea comercialmente equivalente: se conservan y los parametros de consulta se comparan despues de las redirecciones. La identidad y la oferta se validan con los datos recibidos.

```json
{
  "url": "https://www.backmarket.com/en-us/p/iphone-14-128-gb-midnight-att/ec6b3e5e-676e-40f9-91a6-1c9d8537209b?l=12",
  "outputFormat": "reference1688",
  "proxyAccessAuthorized": true
}
```

Apify UNBLOCKER viene seleccionado en `proxyConfiguration`. La cuenta debe tener acceso al grupo y presupuesto autorizado. `proxy-chain` crea un puente local temporal para la autenticacion; no se introducen credenciales en el input. El modo normal es el predeterminado. `firefoxFastMode` es opcional, experimental y permanece desactivado por defecto.

## Ejecucion en Apify

En el Actor existente de Apify, actualiza el codigo desde este repositorio y crea un build desde la raiz. Docker instala Firefox y sus dependencias Linux. Configura la URL, confirma la autorizacion del proxy y ejecuta el Actor. No hace falta crear otro Actor ni seleccionar un navegador.

## Dataset

El Actor guarda un registro por URL con exactamente estas once claves:

`url`, `title`, `price`, `productLadderPrices`, `moq`, `weight`, `dimensions`, `images`, `characteristics`, `variations`, `productId`.

El precio solo se guarda si la oferta seleccionada se puede verificar contra el producto solicitado. Si falta evidencia o hay datos secundarios incompletos, el estado puede ser `partial` o `error`; el extractor no completa valores ausentes con datos inventados.

Las condiciones se representan en `variations`, dentro del grupo `grades` (o el identificador de condiciones recibido), conservando las etiquetas y el orden originales. Cada `price` corresponde a su condicion. Solo se publica si pertenece al mismo UUID, sin conflictos de slug o seleccion conocida y con precio, moneda y disponibilidad comprobables. Un picker que cambia color o almacenamiento no acredita el precio de esa condicion para el producto solicitado y queda con `price: null`. `PRODUCT_METADATA.variantGroups[].options[]` conserva moneda, disponibilidad y motivo de verificacion; el contrato de variantes no tiene una clave de moneda. `productLadderPrices` permanece vacio porque representa precios por volumen, no condiciones.

El peso se publica como numero en kg redondeado a dos decimales; el valor convertido original y su origen se conservan en metadata. Si un peso positivo quedara redondeado a cero, se devuelve `null` y se registra `POSITIVE_WEIGHT_BELOW_TWO_DECIMAL_PRECISION`.

Para URLs cortas se consideran URL final, canonical y JSON-LD vinculados a la pagina, y registros Nuxt de producto o picker seleccionado asociados a su slug. La identidad debe ser unica y su oferta debe verificarse. Sin vinculo explicito se devuelve `SHORT_URL_IDENTITY_UNVERIFIED`; si hay identidades contradictorias, `SHORT_URL_IDENTITY_AMBIGUOUS`.

## Limitaciones

- Requiere acceso de cuenta al grupo Apify UNBLOCKER cuando el proxy esta habilitado.
- La informacion de la ficha puede variar por disponibilidad, seleccion comercial y cambios del sitio.
- El modo rapido no esta confirmado en Apify Cloud; usar el modo normal para produccion.
- La limpieza se valido offline con HTML de referencia; no se ejecutaron extracciones nuevas en Apify Cloud.
