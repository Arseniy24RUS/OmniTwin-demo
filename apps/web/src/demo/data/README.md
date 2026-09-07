# Public fictional demo data

This directory does not implement, calibrate or invoke the RUSDEM scientific model.
All public person identities, employment, schedules, scenario transitions and exact
building assignments are fictional interface fixtures. No national person file is read.

`tools/build-demo-data.mjs` reproduces the checked-in `public/demo` files using the
small preserved legacy JSON export. Running it twice yields identical SHA-256 hashes.
The optional `--import-legacy <fixture-directory> --python <python-executable>` command
imports only three named Parquet files from `synthetic-chelyabinsk-v1`, after checking
their original hashes and enforcing a 100 KB per-file bound. It does not modify inputs.

The original two stock dates (8,225 and 8,246) and every original aggregate event row
remain in `legacy-synthetic-chelyabinsk-v1.json`, together with the original run and
completion manifest. Parent aggregate rows are retained for parity; consumers must
filter an exact geography, not sum the entire hierarchical cube.

The new scenario fixture starts with one fictional row per member of the 8,246-person
demo stock. Initial age/sex/district counts exactly match the original 2026 aggregates.
Thereafter three authored schedules of integer events select exits and create entries.
Annual aggregates are calculated from those resulting person records, with
`stock[t] - stock[t-1] = births - deaths + arrivals - departures` checked at build time.
These authored counts are NOT fitted coefficients, observed events or a forecast.
Events attached to stock year 2027 describe the interval 2026–2027. Year 2026 event
fields are null because there is no preceding transition in the new scenario fixture.

`StaticDemoProvider` is instantiated once and shared by all tabs. Presentation minutes
never change demographic year or scenario. Runtime source-backed building/road
features are registered separately; without footprints people remain `unplaced`, not
assigned to invented geometry. Household assignments and source IDs are retained.
Profile, building roster and vehicle passengers query the same presence function.

`chat-profiles.json` is a server deployment input, not a browser loading dependency.
The server can derive age/year-correct traits through the shared pure
`fictionalProfile.mjs`; per-scenario `householdSizes` arrays are indexed by year minus
2026 and use null outside membership. Never replace this bundle with restricted model
microdata without a separate privacy review.
