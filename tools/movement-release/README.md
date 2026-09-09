# Immutable movement overlay publication

`tools/publish-city-movement-assets.mjs` prepares the existing bounded
`source-mode-v2` overlay for explicit deployment. It does not compile new routes,
change population/household assignments, rewrite source manifests, activate a
runtime configuration or contact cloud services during a dry-run.

```powershell
node tools/publish-city-movement-assets.mjs --report-dir .cache/city-movement-publication-v1
```

The default source is the previously verified
`.cache/movement-mode-v2/manifest-625391b37ea50add.json`, pinned by full SHA
`625391b37ea50add3c40c4ad715124e8fcf395cbd5610f55bc7f5a68b74a7245`.
Alternate prepared roots require matching `--overlay-root`, `--manifest-name`
and `--manifest-sha` arguments. `--public-root` selects the three fixed source
manifests used for lineage verification, never additional uploaded files.

## Exact closure and transport

The planner follows only root `bindings`, `cells[].context` and `cells[].pages[]`,
including each explicitly declared gzip equivalent. It verifies SHA/bytes,
gzip-to-raw equality, source lineage/counts and current runtime codec hashes.
Every context/page is decoded with the existing bounded movement codecs. Cell
bindings/roads must match the global overlay dictionary; person/household/building
ordinals and ordered page ranges must fit the source counts. Unknown descriptor
families, escapes, symlinks/junctions, corruption, missing dependencies and
inconsistent counts fail closed. Filesystem directories and provenance URLs are
not traversed.

Caps: 2 MiB root manifest, 8 MiB per leaf, 256 cells, 8 192 pages, 32 768 objects,
512 MiB verified raw-plus-gzip bytes. The planner does not compare every embedded
person byte against every canonical source shard. Its input manifest is
independently pinned to the previously verified compiler snapshot; full household
and unchanged-source behavior is covered by compiler/provider tests.

The release prefix is
`packs/<releaseSHA>/movement-overlay-v2/`. Relative paths and manifest bytes stay
unchanged. Canonical JSON URLs deliver their verified gzip bytes with
`Content-Encoding: gzip`; explicit `.json.gz` aliases deliver the same bytes as
`application/gzip` without Content-Encoding. This matches `VerifiedShardStore`.
The root manifest uses identity delivery.

The existing create-only GCS transport verifies project/bucket and exact remote
metadata, allows at most two concurrent leaf uploads, and publishes the root
last. Resume never repairs or overwrites mismatches. Every source and overlay
file is reverified before auth, and outgoing bodies before POST.

After QA and authorization, the API accepts a trusted refresh-capable
`getAccessToken` callback. CLI execution requires `--execute --bucket
omnitwin-demo-city-assets --expected-release SHA_FROM_REVIEWED_DRY_RUN` and a
trusted pre-supplied `FIREBASE_CITY_ASSET_ACCESS_TOKEN`. No credential discovery,
login, IAM/ACL/CORS changes or runtime pointer update is performed.

## Public activation and chat compatibility

The historical manifest retains `scope: local_preview` and
`chatCompatibility: pending`. Public transport is a separate deployment
descriptor in `runtime-config.json.movementOverlay`:

```json
{
  "contract": "CityMovementActivationV1",
  "version": 1,
  "datasetId": "omnitwin-fictional-city-v2",
  "presentation": "bounded_source_overlay",
  "chatCompatibility": "pending",
  "baseHashes": {
    "population": "<exact population manifest SHA>",
    "spatial": "<exact spatial manifest SHA>",
    "geography": "<exact geography manifest SHA>"
  },
  "manifest": {
    "url": "https://storage.googleapis.com/omnitwin-demo-city-assets/packs/<releaseSHA>/movement-overlay-v2/manifest-<manifestSHA16>.json",
    "bytes": 109055,
    "sha256": "<full manifest SHA>"
  }
}
```

The namespace, independent manifest bytes/SHA and all three loaded source pins
are checked before the overlay is accepted. Public origins and production builds
use the explicit public activation. Only a DEV application on same-origin HTTP(S)
loopback uses the local city and local overlay, while retaining any published
population/spatial SHA pins and the local_preview/pending disclosure. A local
failure does not retry against cloud resources. A clean local V2 URL can use the
preview; explicit native/legacy links keep their existing choice. The legacy
dataset does not load either overlay. Without public activation, the existing
source behavior is retained.

Publisher reports always keep `chatCompatibility: pending` and
`publicReady: false`. The only additional accepted attestation is
`base_profiles_unchanged`, set separately by the release owner after backend V2
rollout, read-back and tests. It relaxes the chat guard only after the same three
base pins have been verified. It does not claim observed traffic or change the
old manifest's provenance. Traffic behavior and public browser/video QA remain
separate acceptance gates.

## Offline snapshot — 2026-09-09

Verified **481 files / 112 011 796 raw-plus-gzip bytes**; **33 854 989 stored
bytes**. Decoded closure: **34 cells, 205 pages, 151 covered buildings,
381 732 person-cell associations**. Root: **109 055 bytes** with the unchanged SHA
above. Release SHA:

```text
a825cb2f215a04483ff7ba4932dde38c34763260177aa6da5ab9920263a4a019
```

No auth/network/upload or public activation occurred in this preparation.

Checks: 37 combined population/visual/movement publisher tests pass, covering
malformed closure, corrupted bytes, gzip, source-pin changes, upload order,
create-only resume and delivery headers. Runtime checks include independent
public activation, all-three-pin failures, exact manifest bytes, pending chat,
and 18 source-vs-overlay profile/household/home/work/study comparisons across
three scenarios and two years. These bounded fixtures do not establish full
public traffic or chat acceptance.
