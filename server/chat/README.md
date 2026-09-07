# Fictional resident chat function

This is a separate Node.js 22 backend package. The static web build must not
import it. It contains no API keys and has no working cloud URL by default.
Local tests use only injected test doubles: passing them does not establish live
YDB transactions, Russian network reachability, model quality, or deployment.

```powershell
cd server/chat
npm ci --ignore-scripts
npm test
npm run package
npm run verify-package
```

The package command verifies the approved public manifest, then produces
`dist/demo-chat-function.zip` and `dist/package-evidence.json`. The ZIP contains
only the entrypoint, server modules, exact approved fictional profiles, the
shared pure profile generator, and locked dependency manifests. It never reads
environment variables or includes tests, `.env`, logs or credentials. Yandex
[installs locked production dependencies](https://yandex.cloud/ru/docs/functions/lang/nodejs/dependencies)
using `npm ci --production` when creating the function version. Package verification
unpacks into a unique temporary directory beneath `dist`, loads the exact package
configuration, checks its digest and profile-year consistency, and uses only a
local upstream test double. It removes that temporary directory afterward.
The archive's `index.js` uses the documented CommonJS `module.exports.handler`
entrypoint and dynamically imports `src/runtime.mjs`; the internal modules remain
ESM. The entrypoint test calls it in a child process with an empty environment
and network disabled. Archive verification also checks `require('./index.js')`.
This removes reliance on undocumented ESM entrypoint loading, but does not replace
a real Yandex runtime smoke-test. See the [handler contract](https://yandex.cloud/ru/docs/functions/lang/nodejs/handler).
The function obtains short-lived IAM credentials from the documented
[function metadata endpoint](https://yandex.cloud/ru/docs/functions/operations/function-sa),
refreshes them on use based on `expires_in` (including after idle), and passes
them through the YDB SDK's token-auth interface. No background warm-up or full
Yandex SDK dependency is needed. Deployment and private credential entry are described in
[`deploy/yandex/README.md`](../../deploy/yandex/README.md).

## Public protocol

All calls require the exact allowed `Origin` and `Content-Type: application/json`.
No browser API key or Authorization header is used. CORS and anonymous signed
sessions are not authentication; clients outside a browser can spoof Origin.

`POST /session` with `{}` returns `{sessionToken, expiresAt}`. The opaque HMAC
token expires after 24 hours and is bound to the allowed origin. Keep it in the
tab's memory or session storage. A token is not a real-person identity and may be
reissued; therefore the global quota and OpenRouter spending limit are the
authoritative spending safeguards.

`POST /chat` takes:

```json
{
  "personId": "approved-fictional-person-id",
  "datasetId": "omnitwin-public-fictional-chelyabinsk-v1",
  "scenario": "baseline",
  "year": 2026,
  "presentationMinutes": 600,
  "message": "Здравствуйте!",
  "history": [],
  "sessionToken": "opaque-token-from-session",
  "requestId": "fresh-random-uuid-per-explicit-send"
}
```

Allowed scenarios are `baseline`, `inflow`, `ageing`; years are 2026–2036;
presentation minutes are in `[0,1440)`. The resident must exist in the selected
scenario and year (`entryYear <= year < exitYear`, or no exit). A server-approved
profile is regenerated for that year by the same reviewed pure module used by
the frontend, so age, studies, employment and retirement remain consistent.
Client traits, biographies, instructions and arbitrary field names are rejected.

Input is at most 8,192 UTF-8 bytes including the session token. A message is at
most 600 JavaScript UTF-16 code units. Optional history has at most 4 entries,
each with exactly `role` (`user` or `assistant`) and `content` (up to 300 code
units). History is untrusted and never becomes a system instruction. The client
should select/truncate its visible recent history to these bounds before send.
Only the most recent reply is returned; there is no server transcript retrieval.

Success is `{reply, source:'llm', requestId, model}`. A controlled failure is
`{source:'unavailable', reason, requestId?}`. Reasons are bounded enums:
`origin_not_allowed`, `not_found`, `method_not_allowed`, `input_too_large`,
`invalid_input`, `invalid_session`, `request_conflict`, `request_in_progress`,
`already_processed`, `rate_limited`, `quota_unavailable`, `profile_unavailable`, `provider_unavailable`,
`service_not_configured`. The relevant HTTP status is 400/401/403/404/405/409/413/
429/503. Do not present a scripted fallback as an LLM response.

## Provider and quota policy

The server fixes the primary model to `qwen/qwen3-235b-a22b-2507` and fallback to
`qwen/qwen3-30b-a3b-instruct-2507`, with only `alibaba`, `parasail`, `deepinfra`
provider paths, a `data_collection:'deny'` routing filter, and price ceilings of
$0.25/million input tokens and $1/million output tokens. Requests are nonstreaming,
at most 220 output tokens. A 25-second handler deadline covers initialization,
quota work, the upstream fetch and finalization; any late quota completion cannot start a
new model call after the timeout. Both selected models
are non-thinking Instruct variants; no reasoning parameter is sent. A provider
policy mismatch or disappearing model fails closed. This policy is a starting
configuration, not a promise of a model's future availability or output quality.
See [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
and [model fallback](https://openrouter.ai/docs/guides/routing/model-fallbacks).

YDB serializable read-write transactions reserve 6 requests per UTC minute per
session, 30 per UTC day per session, and 100 per UTC day globally before any paid
call. Reservations are not refunded on timeout/provider failure: an upstream
failure can have an uncertain billing outcome. Only explicit YDB ABORTED
transactions retry; ambiguous commits fail closed. The upstream call is outside
all transaction retry callbacks. There is no production in-memory fallback.

An idempotency record stores only a SHA-256 fingerprint, status and expiry.
Duplicate IDs never repeat an inference call; a changed payload returns
`request_conflict`, a running/uncertain request returns `request_in_progress`,
and a completed/failed request returns `already_processed`. No reply is cached:
the browser must retain its own received reply. Do not automatically retry with
a fresh request ID after an uncertain timeout; require an explicit new send.
Request records expire after 48 hours. Counter expiry is checked in code because
YDB TTL cleanup is asynchronous. Records remain small, but Yandex's free tier is
not an absolute bill cap under arbitrary hostile traffic.

## Privacy and operator prerequisites

No prompts, history, replies, raw IPs or credentials are persisted or logged by
this application. YDB contains pseudonymous random session hashes, request
fingerprints/statuses and counters only. The SDK logger is disabled. Platform
access metadata can still be retained by Yandex; keep platform retention short
and do not enable request-body logging. OpenRouter and the selected model
provider necessarily receive the submitted text; routing preferences are not a
claim of zero retention by all intermediaries. Warn visitors not to submit
personal or sensitive information. The characters and demographic scenarios
are explicitly fictional, not observed people or validated scientific results.

The owner privately creates a dedicated OpenRouter key with a $5 total spending
limit, **no periodic reset and no automatic top-up**. Never paste it into chat or
Git. Enter it only in the function environment, together with an independently
generated high-entropy session secret. Function editor/admin access must be
restricted. Provider-key limits do not cap Yandex usage charges; configure its
budget notifications separately.

Live acceptance still requires a deployed private function + YDB database,
approved Gateway origin, real no-duplicate transaction tests, Russian region
egress to the pinned provider paths, and a consented bounded paid inference.
Test the published Pages-to-Gateway flow again after a cold start. None of those
external checks is inferred from the local mocked test suite.

## V2 canonical profiles (source-ready, not yet live acceptance)

The Firebase package can resolve `omnitwin-fictional-city-v2` through the exact
shared `demo-population/index.mjs` and `spatial.mjs` modules used by the frontend.
The legacy approved ~17 MB profile manifest and dataset adapter remain available.
No million-person profile collection is created in Firestore or YDB.

V2 is enabled only when **all four non-secret runtime pins** are configured:
`V2_POPULATION_MANIFEST_URL`, `V2_POPULATION_MANIFEST_SHA256`,
`V2_SPATIAL_MANIFEST_URL`, `V2_SPATIAL_MANIFEST_SHA256`. URLs must be HTTPS, without
credentials, query or fragment; all asset paths stay within each approved
manifest directory. Redirects are rejected. The spatial manifest must bind the
exact population, geography and shared-codec hashes. Partial configuration,
changed bytes, invalid membership or missing assignments fail closed. Published
asset pins must be updated together with the matching reviewed server modules.
This does not authorize a cloud deployment or a key/configuration change.

`/session` does not fetch V2. A signed, shape-validated `/chat` context resolves
only the requested person's shard, household membership, relevant member shards,
and assignment shard. `profileFor` computes the canonical profile with the
scenario/year-active household size. `presenceFor` supplies the server's
fictional semantic presence; no browser biography, location, role or URL is
accepted. A travel endpoint schedule does **not** establish a route, address or
vehicle and the prompt says so. Presence remains visual synthesis, not observed
occupancy or validated behavior.

Bounds: manifests ≤2 MiB each, shards ≤2 MiB each, verified-shard LRU ≤32 entries
and ≤8 MiB raw bytes, at most 32 asset reads/12 MiB downloaded per resolution,
two concurrent resolutions, 10-second resolver timeout inside the unchanged
25-second request deadline. These are implementation bounds, not a claim that
total process memory is 8 MiB (the retained legacy manifest and runtime also use
memory). Before **any V2 manifest/shard I/O**, the existing durable quota reserves
one attempt, using the pinned revision known locally. Exhausted, replayed or
quota-unavailable requests do not fetch profiles. Syntactically valid but
unknown/inactive V2 people consume that attempt (`invalid_input`); asset/hash
failures also consume it (`profile_unavailable`), without inference or refund.
Malformed context is rejected before admission. Legacy local-profile validation
retains its earlier ordering. Idempotency binds the selected dataset's manifest
and codec revision. Values remain 6/minute, 30/session/day and 100/global/day.
Sessions/CORS are not authentication; rejected requests and session requests
still incur platform work, so these quotas are not an absolute cloud-spend cap.

Offline checks, with no credentials/network/LLM calls:

```text
node --test --test-concurrency=1 test/*.test.mjs
node scripts/verify-population.mjs
```

The second command requires the completed generated public population and
spatial packs; it samples nine canonical contexts without loading all people.
Firebase deployment details and the owner's current **no OpenRouter cap change**
decision supersede the historical Yandex/$5 instructions above; see
[Firebase README](../../deploy/firebase/README_RU.md).
