# Current graphics: deferred limitations

The owner requested publication of the current version on 2026-09-09 and
deferred individual remaining bugs. Activation commit `4c62a5a` is deployed;
the minimal public smoke passed. This note does not claim complete artistic
acceptance or replace the deferred extended camera/traffic regressions.

- At wide views, neutral landuse ground can exceed its preparation memory bound
  and contact lighting can exceed its grid bound. Each keeps its previous valid
  coverage; a cold view may initially have none of that synthesized detail.
  Individual owners report `error_retained` even when Worker transport is healthy.
- Road markings are capped; wide road coverage can be explicitly partial.
  Source courtyard holes outside complete verified coverage receive no synthesized
  paving. Native geography remains available.
- The repeated exact-user moving run removed the earlier 993/636 ms frame gaps:
  cold pan/zoom maxima were 123/104 ms. Short hitches remain. Warm-return mouse
  protocol pacing accumulated up to 640 ms lateness; this is not an
  input-to-photon measurement. Settled pause produced zero frames over 2.2 seconds.
- Metal roof normal filtering now reduces the witnessed fine stripe contrast by
  53–56% while retaining nearby corrugation and fixture shadows. Regular facade
  cadence, smooth tree crowns and broad plain ground remain content limitations.
- The eight-family source audit identified building
  `openmaptiles_buildings:7409875430`: its source wall material is `brick`, while
  the industrial visual family assigns `metal`. Deferred correction: honor the
  verified wall-material tag before the generic family material default.
- Surface-worker source packets remain below the outer protocol limits: the
  startup diagnostic used about 10.7 MB and 53,087 coordinate tuples against
  64 MiB and 1,000,000 limits. Structured-clone posting still runs on main:
  its measured maximum was 19.5 ms in that diagnostic and 21.1 ms in combined02.
  These outer bounds do not prevent the individual landuse/contact limits above.

See [combined moving evidence](../evidence/moving-combined02-evidence-20260909.json)
and [roof comparison](../evidence/roof-normal-filter-v3-evidence-20260909.json).
The underlying images were inspected. Neither counters nor those stills establish
literal SimCity equivalence or every-frame collision and coverage correctness.
