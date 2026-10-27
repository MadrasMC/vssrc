# vssrc

vssrc is a browser-based tool for viewing decompiled Vintage Story C# source code, inspired by https://mcsrc.dev.

The page reads the Linux client tarball locally, keeps the game assemblies in IndexedDB per version, and decompiles types in a Web Worker with ICSharpCode.Decompiler on .NET WebAssembly. Nothing is uploaded.

Deployed at https://madrasmc.ftrs.im/vssrc/.

## Requirements

- [Bun](https://bun.sh)
- .NET 10 SDK in `.dotnet/` (the build runs `.dotnet/dotnet`), installed with Microsoft's dotnet-install script:

```powershell
Invoke-WebRequest https://dot.net/v1/dotnet-install.ps1 -OutFile dotnet-install.ps1; ./dotnet-install.ps1 -Channel 10.0 -InstallDir .dotnet
```

```bash
curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 10.0 --install-dir .dotnet
```

## Build

```bash
bun install
```

```bash
bun run emit
```

`emit` publishes the decompiler, then writes `dist/` from scratch. It fetches the version list from api.vintagestory.at, so it needs network access.

| flag | effect |
| --- | --- |
| – | embed the latest stable Linux client only |
| `--embed-versions` | embed every Linux client version, stable and pre-release |
| `--use-proxy` | load the full list from the server at runtime, replacing the embedded versions (see Version list proxy) |
| `--skip-dotnet` | reuse the last `dotnet publish` |

The flags combine. `bun run check` type-checks the page, the worker and the build script.

## Deploy

Set `SITE` in `build.ts` to the deployed URL; it is used only for the canonical and og tags, which need absolute URLs. Everything else in the page is relative, so `dist/` works as any folder, served with a trailing slash (`/vssrc/`, not `/vssrc`).

| file | caching |
| --- | --- |
| `index.html`, `og.png` | revalidate |
| everything else (`*.<hash>.*`) | immutable |

The page works under this Content-Security-Policy:

```
default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' blob: data:
```

## Version list proxy

api.vintagestory.at sends no CORS headers, so the page can only read the version list if the server proxies it next to the page, at `versions/stable.json` and `versions/unstable.json`. Build with `--use-proxy` for such a server. If the requests fail, the embedded versions stay.

nginx, with the page at `/vssrc/`. In the `http` block:

```nginx
proxy_cache_path /var/cache/nginx/vsapi keys_zone=vsapi:1m max_size=10m inactive=1d;
```

In the `server` block:

```nginx
location = /vssrc/versions/stable.json {
	proxy_pass https://api.vintagestory.at/stable.json;
	include snippets/vsapi.conf;
}
location = /vssrc/versions/unstable.json {
	proxy_pass https://api.vintagestory.at/unstable.json;
	include snippets/vsapi.conf;
}
```

`/etc/nginx/snippets/vsapi.conf` (relative `include` paths resolve against `/etc/nginx`):

```nginx
proxy_ssl_server_name on;
proxy_set_header Host api.vintagestory.at;
proxy_cache vsapi;
proxy_cache_valid 200 15m;
proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
proxy_hide_header Set-Cookie;
```

The cache directory must exist and belong to the nginx user:

```bash
sudo install -d -o www-data -g www-data /var/cache/nginx/vsapi
```

Don't put `add_header` in these locations: nginx then drops every `add_header` inherited from the `server` block, including the security headers.

## Link preview

`src/og.png` (1200×630) is rendered from `src/og.html` and committed; the build copies it into `dist/`. To re-render, from the project root:

```bash
google-chrome --headless=new --allow-file-access-from-files --hide-scrollbars --window-size=1200,630 --screenshot=src/og.png src/og.html
```
