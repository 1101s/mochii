# Mochii single-file browser

`mochii-singlefile.html` is the ready-to-use artifact. It starts directly in the Mochii interface and includes the application JavaScript, CSS, fonts, saved catalogs, Epoxy transport and WASM, and four local apps (Auk, Vox, Desktops, and Mochii Cloud). No Mochii server, service-worker registration, `/sw.js`, `/proxy-host.html`, or separate local asset routes are used by this build. The normal multi-file build remains available.

Load it using the included `mochii-loader.svg`, or change the URL in your existing SVG loader to:

```js
const url = 'https://cdn.jsdelivr.net/gh/1101s/mochii@main/mochii-singlefile.html';
```

The loader fetches the HTML as text and writes it into its iframe. jsDelivr's HTML content type does not need to support direct document navigation. Open the SVG as a document; embedding it as an `<img>` does not execute its scripts. The host must permit inline scripts, WebAssembly, dedicated blob workers, and Wisp WebSocket connections. This does not bypass browser policies or an SVG sanitizer. For repeatable deployments, replace `@main` with the published commit SHA; a timestamp query is not a guarantee that jsDelivr has refreshed a branch alias.

## Runtime

The app creates a dedicated Web Worker (not a Service Worker) containing the transport and TLS WASM. Requests use configured external Wisp relays. jsDelivr distributes the application; the relays still handle its network traffic. The interface does not need a hosted Mochii runtime, but it is not an offline web browser.

The parent fetches each document, follows bounded redirects, rewrites stylesheets and static resource URLs into data URLs, and injects a message-channel bridge. The document runs in an opaque sandbox without `allow-same-origin`, so it cannot read the app's storage or DOM. Links and forms return to the parent navigator. The bridge proxies `fetch`, asynchronous XHR, and common dynamically assigned resource URLs. Existing Console, Inspect, and manually invoked Userscripts work through the message channel.

Game asset bursts are queued (24 active bridge calls, up to 512 waiting) rather than rejected by the host's concurrency limit. Service-worker feature detection reports unavailable in the sandbox so optional offline-cache setup does not crash game loops. Relative paths retain their document directory; explicit `/` paths retain their origin root, including broken paths already present in third-party game exports.

No browser cookies or authorization headers are forwarded. Remote cookies are not persisted. Top-level navigation and popups are not granted to remote content. A page's CSP is replaced with the sandbox document's restricted policy; this is a compatibility renderer, not the original site's browser origin or security model.

Navigation and closing a page cancel its pending work and terminate the dedicated transport worker. Epoxy has no effective per-request network abort: a parent request timeout/cancellation closes that worker and rejects sibling requests. An individual remote `fetch` abort rejects its caller immediately; its already-started network operation remains bounded by the host timeout. Media uses a separate bounded transport/cache.

Limits: eight active transport requests, 256 queued requests, 45 seconds per queued/request lifetime, 4 MiB uploads, 32 MiB response bodies, eight redirects, 500 page resources, and a 96 MiB decoded page budget. Images/media are buffered before use; this is not an unbounded streaming proxy.

## Compatibility

Supported and exercised: ordinary HTML, static CSS/images, classic scripts, common dynamic script/image URLs, relative links, GET/POST forms, `fetch`, asynchronous XHR, and remote inspector commands.

Known limitations:

- ES-module/import-map pages, service-worker applications, synchronous XHR, authenticated cookie sessions, WebSockets/EventSource inside remote pages, DRM and large streaming media are unsupported or unreliable.
- JavaScript `location` assignments, `document.write`, dynamic CSS, unusual URL escaping, workers, and complex client-side routers are not comprehensively virtualized. Some can leave the proxy frame or fail; this is not a complete network interception boundary.
- External iframe/embed content is replaced by a link that opens it as a proxy page. `srcset` uses the ordinary `src` or a first candidate rather than full responsive selection.
- Remote page history is not a full browser history. Reload/retry always starts a GET and never automatically resubmits a POST.
- Music depends on the existing external aggregator and public relays, and must fit the per-resource buffer limit. External games, Ruffle, emulator images, catalog updates, and optional theme assets still depend on their providers.
- AI coding help needs a separately hosted API and reports that it is unavailable in the CDN-only build. The separate-window cloak is disabled because this artifact is already portable. User-agent emulation and popup preferences do not provide full native-browser behavior.
- HTTPS-only checks apply to addresses entered into Mochii. Embedded links/forms can use HTTP, as in the existing preference description.

## Build and validation

Requires Node 22.12+ and pnpm. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build:singlefile
pnpm test:singlefile
node scripts/check-syntax.mjs
node --test test/*.test.mjs
```

The builder verifies existing script integrity hashes, embeds CDN fonts/editor libraries, and records their URLs and SHA-256 hashes in `singlefile/assets-manifest.json`. Download cache files live in ignored `.cache/singlefile/`. It rejects artifacts larger than 19 MiB. Source changes require rebuilding and committing `mochii-singlefile.html`.

For browser verification:

```sh
node singlefile/test/serve.mjs
```

Open `http://127.0.0.1:8767/loader.svg` to exercise the real SVG loader with live public relays. The fixture variant is `/loader.svg?fixture=1`. In that variant only, temporarily turn off “Require HTTPS for entered addresses” in the localhost app and open `http://fixture.mochii.test/fixture/page`. Its loopback-only Wisp server cannot connect to arbitrary destinations. The page displays script/fetch/XHR/dynamic-script/sandbox results and contains a form and relative link. Restore the HTTPS preference after the test. Fixture relay configuration is injected by the preview server and is never included in the published artifact.

## Licenses and source

Original Mochii code remains under [the repository license](../LICENSE), with attribution to NoseyGames. See [third-party sources](THIRD-PARTY-SOURCES.md) for catalogs, embedded apps, fonts, editor libraries and their separate terms. These builds do not grant rights to remote content.

The new transport uses `@mercuryworkshop/epoxy-transport` **2.1.29**, with `@mercuryworkshop/epoxy-tls` **2.1.20-1**, under AGPL-3.0-only. The embedded TLS build identifies revision [`9cde724aea1a0f5e46b1c962b3d19ca1389af074`](https://github.com/MercuryWorkshop/epoxy-tls/tree/9cde724aea1a0f5e46b1c962b3d19ca1389af074). [Transport source and build files](../licenses/sources/epoxy-transport-2.1.29/) are retained from the exact npm package. The artifact includes the full AGPL license and an application-source link. Earlier source archives remain for the earlier vendored components; they do not describe the new TLS release.

Build tools: esbuild 0.25.12 (MIT) and linkedom 0.18.12 (ISC), installed only for development. The new single-file proxy does not use Ultraviolet or BareMux to handle its requests.
