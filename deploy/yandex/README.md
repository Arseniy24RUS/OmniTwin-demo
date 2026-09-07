# Yandex deployment preparation

This directory is a reviewable deployment scaffold. No resources, credentials,
or live inference are created by reading or validating it. The server package is
built separately by `server/chat`; use its package command and resulting ZIP.

The selected topology is GitHub Pages → API Gateway → private Cloud Function →
OpenRouter, with a small YDB Serverless table for persistent quota state. The
function uses its attached service account to obtain YDB credentials from the
metadata service. No long-lived IAM key is required.

## Resources and permissions

1. Use a Yandex billing account in `ACTIVE` paid-consumption state and a dedicated
   project folder. A starter grant is optional; this design does not depend on
   its expiry date.
2. Create one YDB database in **Serverless / on-demand** mode. Set provisioned
   throughput to **0 RU/s**. Run `schema.yql` once in that database. If the table
   already exists, inspect its schema and TTL settings; do not delete it.
3. Create a function service account, for example `demo-chat-runtime`. Grant it
   `ydb.editor` on this database only. This role allows the SDK to read and write
   the quota table. Keep this account separate from deployment administration.
4. Create a private Cloud Function, for example `demo-chat`. Attach the runtime
   service account to its version. Do not grant invocation to `allUsers` or
   `allAuthenticatedUsers`.
5. Create a separate account, for example `demo-chat-gateway`. Grant it
   `functions.functionInvoker` on this function only. Put its ID in the Gateway
   template; it needs neither YDB access nor function editing permissions.

Yandex supports [database-scoped roles](https://yandex.cloud/ru/docs/ydb/security/)
and [private function invocation by a gateway account](https://yandex.cloud/ru/docs/api-gateway/concepts/extensions/cloud-functions).

## Function version

| Setting | Value |
|---|---|
| Runtime | `nodejs22` |
| Entrypoint | `index.handler` |
| Package | ZIP built by `server/chat`, with entrypoint at archive root |
| Memory | 256 MB initially; measure before considering 128 MB |
| Execution timeout | 30 seconds |
| Prepared instances | `provisioned_instances_count = 0` |
| Per-instance concurrency | 1 initially |
| Network | Default network; no dedicated NAT or VPC resources needed |
| Log retention | Short retention, for example 3 days; metadata/error codes only |

`nodejs22` is a supported runtime in the [official runtime table](https://yandex.cloud/ru/docs/functions/lang/nodejs/).
Check the package root and export before upload: `index.handler` must resolve to
the server's CommonJS `index.js` export, which dynamically loads the internal
`src/runtime.mjs` handler. Local and archive tests verify the documented
[`module.exports.handler` contract](https://yandex.cloud/ru/docs/functions/lang/nodejs/handler).
The browser application and its Node
build requirements are separate from the function runtime.

Enter these values in the **function version's console environment settings**:

| Name | Value / source |
|---|---|
| `OPENROUTER_API_KEY` | Owner's dedicated, budget-limited key; enter privately |
| `SESSION_SIGNING_SECRET` | Independently generated high-entropy secret, at least 32 bytes |
| `ALLOWED_ORIGINS` | Exact HTTPS Pages origin, e.g. `https://owner.github.io`; no repository path or trailing slash |
| `PROFILE_MANIFEST_PATH` | `data/chat-profiles.json` |
| `PROFILE_MANIFEST_SHA256` | SHA-256 of the exact approved file included in the ZIP |
| `YDB_ENDPOINT` | Database connection endpoint beginning `grpcs://` |
| `YDB_DATABASE` | Database path shown by Yandex, e.g. `/ru-central1/.../...` |
| `YDB_TABLE` | `demo_chat_state` |

The packaging source is `apps/web/public/demo/chat-profiles.json`; the server ZIP
must contain the reviewed file at `data/chat-profiles.json`. Compute the checksum
from that exact file, not from a reserialized copy. A changed profile bundle
requires a new review, a rebuilt archive, and the matching environment checksum.
Do not use an empty or guessed checksum.

Environment values are [server configuration](https://yandex.cloud/ru/docs/functions/operations/function/environment-variables-add).
Function editors/admins can read them; ordinary invocation permission cannot.
Limit [editing roles](https://yandex.cloud/ru/docs/functions/security/) to trusted
operators. Do not put secret values into Git, Gateway YAML, command history,
screenshots, logs, build-time browser variables, or an exported Terraform state.
The quota table stores only counters and request fingerprints/status, never
conversation text or responses. SDK trace logging must stay disabled.

## Gateway and browser

Copy `gateway.openapi.template.yaml` into the API Gateway editor and replace:

- `REPLACE_FUNCTION_ID` with the private function ID.
- `REPLACE_GATEWAY_SERVICE_ACCOUNT_ID` with the gateway invoker account ID.
- `REPLACE_PAGES_ORIGIN` with the same single HTTPS origin as `ALLOWED_ORIGINS`.

The template exposes `POST /session` and `POST /chat`, uses payload format `1.0`,
and lets the documented [CORS extension](https://yandex.cloud/ru/docs/api-gateway/concepts/extensions/cors)
handle `OPTIONS` preflights automatically. The server must also return its normal
CORS headers for successful and failed POST responses. CORS alone does not
authorize a caller: session verification and durable quotas remain in the server.
Keep unknown routes closed. Set the frontend's public API base URL to the resulting
HTTPS Gateway URL; publish no credentials with it.

The application uses short JSON replies, capped at 8 KB, rather than a persistent
HTTP stream. Keep the upstream model timeout below the function's 30-second
deadline so the handler can return its controlled unavailable response.

## Idle time, quotas, and cost

There is no reserved server in this configuration. A normal function instance
may stop during inactivity; a later request creates or resumes an instance.
Do not add scheduled warm-up requests or prepared instances. Cold-start latency
is expected after a long idle period. [Function lifecycle](https://yandex.cloud/ru/docs/functions/concepts/function)
describes this behavior; keeping an account in good billing standing remains
necessary.

The [monthly free tier](https://yandex.cloud/ru/docs/billing/concepts/serverless-free-tier)
currently covers 1 million function calls, 10 GB-hours of function execution,
100,000 Gateway requests, and YDB's first 1 million RU plus 1 GB/month of storage.
These allowances are shared across a billing account and are independent of the
starter grant. Above them, usage is billed. YDB on-demand does not bill RU when
there are no requests; nonzero provisioned throughput creates recurring charges.
See [YDB pricing](https://yandex.cloud/ru/docs/ydb/pricing/serverless).

The table's TTL cleans expired state one hour after `expires_at`; YDB may remove
rows later, so application expiry checks are still mandatory. This keeps stored
quota state small without a scheduled cleanup function. [TTL semantics](https://ydb.tech/docs/ru/concepts/ttl)

Server policy is initially 6 chat requests/minute and 30/day per session, with
100/day globally. Review the implemented server policy before deployment; these
are application limits, not a promise of a zero bill under arbitrary traffic.
Configure a Yandex budget notification and a separate OpenRouter key credit cap.
A [Yandex budget notification does not stop resource consumption](https://yandex.cloud/ru/docs/billing/concepts/budget).

## Checks before publishing the live API URL

After deployment is separately authorized, verify from the intended Pages origin:

- `OPTIONS /session` and `/chat` allow only the configured origin and headers.
- Missing/expired sessions, changed profile hashes, overlarge input, quota
  exhaustion, and repeated request IDs fail without a duplicate model request.
- Function invocation through its direct public URL is denied.
- A valid bounded request reaches OpenRouter from the chosen Yandex region and
  returns the short JSON format. The [default function network provides IPv4 internet access](https://yandex.cloud/ru/docs/functions/concepts/networking),
  but this does not establish the reachability of every provider.
- Browser bundles, responses, logs, and quota rows contain no API key, signing
  secret, or raw IP address. Logs and quota rows contain no conversation text.
- A second visit after idle time succeeds with the same persistent quota state.

Do not advertise successful deployment or end-to-end availability until these
checks have run. OpenRouter's [Cloudflare edge infrastructure](https://openrouter.ai/docs/guides/best-practices/latency-and-performance)
is an external connectivity dependency. A response-size cap does not prove that
the region-to-provider route is reliable.

The scaffold and sources were reviewed on 2026-09-07. Recheck runtime support and
pricing before a later deployment. No future availability guarantee is implied.
