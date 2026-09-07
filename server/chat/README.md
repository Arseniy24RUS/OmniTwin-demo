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
`already_processed`, `rate_limited`, `quota_unavailable`, `provider_unavailable`,
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
