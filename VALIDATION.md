# Validacion de la migracion JavaScript

## Integracion de transportes seleccionables (2026-11-10)

Base verificada: `2522391a7c9bc3324eb5938ff65c5d89141ed451`, coincidente con `origin/main` tras fetch, arbol limpio y 47 pruebas previas aprobadas. Respaldo: `stable/chromium-before-undici-20261110`. El historial/reflog revisado no muestra otra base de transporte descartada; la opcion HTTP/2 existente sigue desactivada por defecto.

- `transport` admite `chromium` (predeterminado) y `undici`, en el mismo Actor y repositorio. El metodo de extraccion sigue siendo Nuxt.
- `src/browser.js`, proxy oficial, parser Nuxt, identidad, precios, peso, contrato, fixtures y esquema del Dataset permanecen intactos.
- 94 pruebas offline aprobadas (47 anteriores y 47 nuevas): regresion Chromium completa, Undici 6.29.1 con MockAgent y red deshabilitada, adquisicion simulada a traves del Actor, equivalencia exacta de once campos para dos productos y estados success/partial/error/blocked.
- Se prueban consultas comerciales, UUID/seleccion, Nuxt sintetico basado en comercio real, headers/cuerpo, limite del HTML descomprimido, 3xx/403/429, TLS/CONNECT/DNS/TCP/timeout, cierre, privacidad y diagnosticos.
- SDK local real con entorno sin tokens/IDs Cloud, Dataset offline separado; esquemas Input/Dataset/Output/KVS comprobados mediante scripts y `apify validate-schema`.
- No hay fallback ni nuevos parametros comerciales aceptados: se conservan `l` y `offerType`, y se rechazan los demas hasta contar con evidencia.
- No se lanzaron navegadores reales, solicitudes a Back Market, proxies pagados ni runs Cloud. Las capturas son comerciales filtradas; el Nuxt usado en pruebas se identifica como sintetico. Acceso a fichas reales, seleccion aplicada por el servidor, cobertura y tiempos quedan pendientes de las pruebas manuales del usuario.

Las siguientes secciones describen la validacion historica de la migracion; sus recuentos corresponden a esa etapa.

Referencia Python: commit 78533283ac738ca82220da0bbf507d768a5800a9. El proyecto original se consulto en lectura y no se modifico.

## Equivalencia del parser

| Referencia autentica guardada | Comparacion de once campos |
| --- | --- |
| iPhone 15 Plus / Yellow, 413.00 USD | Igualdad completa, incluidas las seis imagenes y peso oficial de 0.201 kg |
| iPhone 14 Pro / Deep Purple, 379.00 USD | Igualdad completa; se conserva la opcion sin ID/moneda/precio como null y se diagnostica como parcial |
| iPhone 14 Plus / Blue, 299.00 USD | Salida Python aportada por el usuario: contrato, 6 imagenes, 27 caracteristicas, 4 grupos, 15 opciones y 7 oz = 0.198446661875 kg comprobados. Payload de origen pendiente para comparar la transformacion completa |

Los hashes de las copias de las capturas y outputs se guardan en test/fixtures/reference/manifest.json. Son HTML comerciales filtrados, no paginas completas. La serializacion de esos datos a tablas Nuxt en tests es sintetica y se identifica como tal.

## Comprobaciones realizadas

- 23 pruebas Node:test: parser, devalue/Nuxt, seleccion UUID/precio/moneda, ausencia de campos, pesos, contrato, proxy oficial, sesiones, privacidad, HTTP y ciclo del Actor simulado.
- Sintaxis de todos los modulos, esquemas JSON y lockfile.
- CLI oficial apify validate-schema: input, dataset, output y key-value store validos.
- SDK Apify real en modo offline, entorno sin tokens/IDs Cloud/proxy heredados, almacenamiento nuevo y aislado: un registro de once campos en offline-validation, status=partial y extractionPerformed=false.
- Dependencias: Apify 3.7.2, Playwright 1.64.1, Cheerio 1.1.2; Node local 24.20.0. Sin runtime Python.
- Docker instalado pero daemon Linux no disponible; no se pudo construir ni ejecutar la imagen.

## Pendientes de ingenieria

1. Construir Docker en un motor disponible o Apify Cloud.
2. Validar Chromium/Linux, cierre y memoria con una prueba autorizada.
3. Confirmar acceso HTTP real en Node, sin atribuir al parser los bloqueos del proveedor.
4. Confiar en una CA oficial verificada si Unblocker devuelve TLS_ERROR; no se porta la excepcion TLS insegura del prototipo.
5. Obtener HTML/Nuxt/JSON comercial y PRODUCT_METADATA del iPhone 14 Plus para comparacion completa desde el mismo origen.
6. Medir latencia de dos fichas y presupuesto externo de 60 s tras demostrar la extraccion real.

No hubo scraping real, navegacion a Back Market, uso de proxies, runs pagados, creacion de Actor, despliegue, commit ni push. La equivalencia offline no acredita acceso actual.
