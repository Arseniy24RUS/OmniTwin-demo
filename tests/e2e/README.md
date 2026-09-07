# Real-browser demo QA

The flow under test is: world → analytics → scenario comparison → resident →
map and clearly labelled local chat → Back/reload. Responsive runs use the real
menu, presentation controls, analytical filters, and resident inspector.

Before starting, confirm the intended demo server and browser are ready. These
tests deliberately do not start or stop any server or scientific/model process.
The default target is `http://127.0.0.1:5178/OmniTwin-demo/`.

```powershell
npx tsc -p tests/e2e/tsconfig.json
npx playwright test --list
npm run test:e2e
```

One headed Chromium worker runs at 1920×1080, 390×844, and 844×390. No API, tile,
canvas, clock, or renderer mocks are installed. Readiness requires actual source
features, exactly one world canvas, rendered buildings, and actors submitted to
the drawing layer. Governor state is recorded, not forced. Analytics must have
no remaining canvas. A separate map test clicks actual projected person,
vehicle, and building candidates, records short motion evidence, and exercises
real mouse pan/wheel and the 2D/3D control.

The chat test first reads the actual `runtime-config.json` and requires
`chatApiUrl: null`. It must not be used to invoke a configured paid model. The
browser checks the visible local-reply label and the absence of session/chat
requests. No credentials or request/response bodies are collected.

Artifacts are written outside this repository to an environment-selected
directory, or `omnitwin-demo-qa` under the operating system temporary directory.
`OMNITWIN_DEMO_QA_ARTIFACTS` selects a fresh iteration directory so a
rerun can preserve earlier failures. `OMNITWIN_DEMO_QA_URL` may select another
explicit loopback port for production-preview checks, but must retain the exact
`/OmniTwin-demo/` base path. Public deployment is not performed by these tests.

Each captured stage has viewport/full-page PNGs and DOM/render-state evidence.
Each test has console, page-error, network, and run manifests. Failed HTTP
requests and console errors are not hidden or reclassified as a pass. Dev-server
HMR errors should be investigated and distinguished from a production run.

All timing is `contaminated_diagnostic`: concurrent model workloads are neither
stopped nor controlled. Passing tests prove the exercised interactions, not
performance, long-term reliability, visual fidelity, or scientific validity.
Open the actual PNGs before making visual claims. The Browser plugin/skill was
not available for this workflow, so it uses the repository's Playwright runner.
