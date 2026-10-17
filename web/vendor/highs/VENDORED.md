# HiGHS for supply scans

Pinned npm package: `highs@1.15.3`, MIT. Upstream sources:

- https://github.com/lovasoa/highs-js
- https://github.com/ERGO-Code/HiGHS

The application imports the unmodified `build/highs.mjs` and loads
`build/highs.wasm` locally inside the scan worker. No CDN or external service
is used at runtime. LICENSE, package metadata, README and API types are retained.
Only the ESM runtime is distributed here; the package's CommonJS entry is omitted.

To reproduce, use `npm pack highs@1.15.3 --ignore-scripts`, verify the archive
SHA-256 below, and extract `package/build/highs.mjs`, `package/build/highs.wasm`,
`package/LICENSE`, `package/package.json`, `package/README.md` and
`package/types.d.ts` with `--strip-components=1` into this directory. Do not
regenerate or modify the minified runtime.

SHA-256:

```text
highs-1.15.3.tgz 218533577886c69023739024bb92cfc2831ba45ff1fd1fd981753c04cded9793
build/highs.mjs f2bdfd071d19c3745756a087026589e9240f329e38315a86f626823ae78a4036
build/highs.wasm 528be4365bea1d4188988646b244263f50320df55782e14d6af5bce7cd45c840
```
