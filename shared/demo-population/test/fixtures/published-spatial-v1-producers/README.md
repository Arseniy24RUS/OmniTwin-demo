# Producer archive for the unchanged public spatial base

These are exact source bytes from commit
`21ee9a4543f7ee1acc4004fe5c11aea043490724`, retained as non-executable test
provenance. They produced spatial manifest
`ec886d770baa1bbb83afab4973b857a6d50d9a1eac0135c1f90508a88557567d`.

- `route-corridors.mjs.txt`: original `shared/demo-population/route-corridors.mjs`,
  SHA-256 `62eebac77125233eeddf97c2c95e67c6e55cd4cf87d1f6f7af3bcf49cc8c03b9`.
- `build-city-spatial-v2.mjs.txt`: original `tools/build-city-spatial-v2.mjs`,
  SHA-256 `961525efb9e1a0aa0ab233051df78f3ba7a083fcbc46b354bdf8f00ba025a05d`.

The full-artifact test accepts this archive only for that exact manifest hash.
Other generations must match current producer files. All generations must match
current population/geography manifests and runtime decoding modules. The new
movement overlay pins its own current producers separately; it does not rewrite
or re-sign the existing base population or spatial artifacts.
