import { z } from "zod";

import type { ClockStateV1 } from "./generated";

export { GENERATED_SCHEMA_SHA256 } from "./generated";
export type {
  AgentCatalogResponseV1,
  AgentPresentationDayResponseV1,
  AgentProfileResponseV1,
  AgentTimelineResponseV1,
  ApiErrorV1,
  BoundaryPackManifestV1,
  ClockStateV1,
  CompletionReportV1,
  CubeResponseV1,
  EventDatumV1,
  GeographyCatalogV1,
  GeographyFeatureV1,
  MetricCatalogV1,
  MetricDefinitionV1,
  PopulationDatumV1,
  RunCatalogV1,
  RunManifestV1,
  ScenarioDraftV1,
  ScientificDatumV1,
  SettlementPointSliceV1,
  TerritoryMetricSliceV1,
  TerritoryNodeV2,
  TerritorySearchResponseV1,
  TerritorySliceV1,
  VisualEntityV1,
  WorldViewportResponseV1,
} from "./generated";

export const BUNDLE_FORMAT = "omnitwin.bundle.v1" as const;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const IsoDateSchema = z
  .string()
  .regex(ISO_DATE_PATTERN, "Expected ISO date")
  .refine((value) => {
    if (value.startsWith("0000-")) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }, "Expected ISO calendar date");
const IsoDateTimeSchema = z.string().datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, "Expected lowercase SHA-256");
const ReservedRunIds = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);
const SafeRunIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,127}$/u, "Expected a lowercase portable run slug")
  .refine((value) => !ReservedRunIds.has(value), "Reserved device names are forbidden");

export const RunModeSchema = z.enum([
  "conditioned_reconstruction",
  "free_run_backtest",
  "forecast",
  "scenario",
  "synthetic",
]);

const ScientificProvenanceSchema = z.enum([
  "observed",
  "derived",
  "imputed",
  "latent",
  "simulated",
  "prior",
  "calibrated",
  "synthetic",
]);

const UncertaintySchema = z.object({ lower: z.number().finite().nullable(), upper: z.number().finite().nullable() }).strict();

export const RunCatalogV1Schema = z
  .object({
    items: z.array(
      z
        .object({
          runId: SafeRunIdSchema,
          runMode: RunModeSchema,
          status: z.literal("complete"),
          dataCutoff: IsoDateSchema,
          geographyVintage: z.string().min(1),
          scientificClaim: z.boolean(),
          completedAt: IsoDateTimeSchema,
        })
        .strict(),
    ),
    count: z.number().int().nonnegative(),
    activeRunId: SafeRunIdSchema.nullable(),
  })
  .strict()
  .superRefine((catalog, context) => {
    const expected = catalog.items[0]?.runId ?? null;
    if (catalog.count !== catalog.items.length || catalog.activeRunId !== expected) {
      context.addIssue({ code: "custom", message: "Run catalog count/activeRunId invariant failed" });
    }
  });

export const PopulationDatumV1Schema = z
  .object({
    metric: z.literal("population"),
    geographyId: z.string().min(1),
    ageBand: z.string().min(1),
    sex: z.enum(["female", "male"]),
    value: z.number().finite().nullable(),
    unit: z.literal("persons"),
    periodStart: z.null(),
    periodEnd: z.null(),
    stockAsOf: IsoDateSchema,
    provenance: ScientificProvenanceSchema,
    uncertainty: UncertaintySchema,
    coverage: z.number().min(0).max(1),
    geographyVintage: z.string().min(1),
    runMode: RunModeSchema,
  })
  .strict();

export const EventDatumV1Schema = z
  .object({
    metric: z.string().min(1),
    eventType: z.string().min(1),
    geographyId: z.string().min(1),
    value: z.number().finite().nullable(),
    unit: z.literal("events"),
    periodStart: IsoDateSchema,
    periodEnd: IsoDateSchema,
    stockAsOf: z.null(),
    provenance: ScientificProvenanceSchema,
    uncertainty: UncertaintySchema,
    coverage: z.number().min(0).max(1),
    geographyVintage: z.string().min(1),
    runMode: RunModeSchema,
  })
  .strict();

export const CubeResponseV1Schema = z
  .object({
    runId: SafeRunIdSchema,
    cube: z.enum(["population", "events"]),
    geographyVintage: z.string().min(1),
    items: z.array(z.union([PopulationDatumV1Schema, EventDatumV1Schema])),
    count: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((cube, context) => {
    if (cube.count !== cube.items.length) {
      context.addIssue({ code: "custom", message: "Cube count must match items" });
    }
    if (cube.items.some((item) => (cube.cube === "population") !== (item.metric === "population" && "ageBand" in item))) {
      context.addIssue({ code: "custom", message: "Cube discriminator must match every item" });
    }
  });

export const RunManifestV1Schema = z
  .object({
    format: z.literal(BUNDLE_FORMAT),
    runId: SafeRunIdSchema,
    version: z.string().min(1),
    status: z.literal("complete"),
    runMode: RunModeSchema,
    forecastOrigin: IsoDateSchema.nullable(),
    dataCutoff: IsoDateSchema,
    geographyVintage: z.string().min(1),
    scenarioId: z.string().min(1).nullable(),
    seed: z.number().int().nonnegative(),
    scientificClaim: z.boolean(),
    predictiveValidation: z.boolean(),
    stableReleaseEligible: z.boolean(),
    completedAt: IsoDateTimeSchema,
    hashes: z.record(z.string().min(1), Sha256Schema).refine((hashes) => Object.keys(hashes).length > 0),
    provenance: z.object({
      classification: z.enum(["synthetic", "observed", "derived", "imputed", "simulated"]),
      source: z.string().min(1),
      notes: z.string(),
    }),
  })
  .strict()
  .superRefine((manifest, context) => {
    const synthetic = manifest.runMode === "synthetic";
    if (synthetic) {
      if (
        manifest.provenance.classification !== "synthetic" ||
        manifest.forecastOrigin !== null ||
        manifest.scenarioId !== null ||
        manifest.scientificClaim ||
        manifest.predictiveValidation ||
        manifest.stableReleaseEligible
      ) {
        context.addIssue({ code: "custom", message: "Synthetic runs cannot carry scientific claims or non-synthetic metadata" });
      }
    } else if (manifest.provenance.classification === "synthetic") {
      context.addIssue({ code: "custom", message: "Non-synthetic runs cannot use synthetic provenance" });
    }
    if (["free_run_backtest", "forecast"].includes(manifest.runMode) && manifest.forecastOrigin === null) {
      context.addIssue({ code: "custom", message: "Free-run backtests and forecasts require forecastOrigin" });
    }
    if (manifest.forecastOrigin !== null && manifest.dataCutoff > manifest.forecastOrigin) {
      context.addIssue({ code: "custom", message: "dataCutoff must not be after forecastOrigin" });
    }
    if ((manifest.runMode === "scenario") !== (manifest.scenarioId !== null)) {
      context.addIssue({ code: "custom", message: "scenarioId is required only for scenario runs" });
    }
    if (manifest.scientificClaim && !manifest.predictiveValidation) {
      context.addIssue({ code: "custom", message: "scientificClaim requires predictiveValidation" });
    }
    if (manifest.stableReleaseEligible && (!manifest.scientificClaim || !manifest.predictiveValidation)) {
      context.addIssue({ code: "custom", message: "stableReleaseEligible requires a validated scientific claim" });
    }
  });

export const CompletionFileV1Schema = z
  .object({
    path: z.string().min(1),
    sha256: Sha256Schema,
    bytes: z.number().int().nonnegative(),
    rows: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const CompletionReportV1Schema = z
  .object({
    format: z.literal(BUNDLE_FORMAT),
    status: z.literal("complete"),
    immutable: z.literal(true),
    runId: SafeRunIdSchema,
    geographyVintage: z.string().min(1),
    completedAt: IsoDateTimeSchema,
    files: z.array(CompletionFileV1Schema).min(1),
  })
  .strict()
  .superRefine((report, context) => {
    const paths = report.files.map((item) => item.path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({ code: "custom", message: "Completion inventory paths must be unique" });
    }
  });

export const ScientificDatumV1Schema = z
  .object({
    metric: z.string().min(1),
    geographyId: z.string().min(1),
    value: z.number().finite().nullable(),
    unit: z.string().min(1),
    periodStart: IsoDateSchema.nullable(),
    periodEnd: IsoDateSchema.nullable(),
    stockAsOf: IsoDateSchema.nullable(),
    provenance: z.enum([
      "observed",
      "derived",
      "imputed",
      "latent",
      "simulated",
      "prior",
      "calibrated",
      "synthetic",
    ]),
    uncertainty: z
      .object({
        lower: z.number().finite().nullable(),
        upper: z.number().finite().nullable(),
      })
      .strict(),
    coverage: z.number().min(0).max(1),
    geographyVintage: z.string().min(1),
  })
  .strict()
  .superRefine((datum, context) => {
    const hasPeriod = datum.periodStart !== null && datum.periodEnd !== null;
    const hasStock = datum.stockAsOf !== null;
    if (hasPeriod === hasStock) {
      context.addIssue({
        code: "custom",
        message: "Exactly one temporal contract is required: periodStart/periodEnd or stockAsOf",
      });
    }
    if ((datum.periodStart === null) !== (datum.periodEnd === null)) {
      context.addIssue({ code: "custom", message: "periodStart and periodEnd must be supplied together" });
    }
  });

export const VisualEntityKindSchema = z.enum([
  "focus_person_1to1",
  "aggregate_proxy",
  "ambient_only",
]);

export const VisualEntityV1Schema = z
  .object({
    id: z.string().min(1),
    representation: VisualEntityKindSchema,
    representedCount: z.number().int().nonnegative(),
    sourceGeographyId: z.string().min(1),
    longitude: z.number().min(-180).max(180),
    latitude: z.number().min(-90).max(90),
    heading: z.number().min(0).lt(360),
    activity: z.enum(["home", "work", "study", "travel", "leisure", "ambient"]),
    modelTime: IsoDateTimeSchema,
    presentationTime: IsoDateTimeSchema,
    positionOrigin: z.enum(["privacy_grid_centroid", "deterministic_viewport_synthesis"]),
    spatialResolutionM: z.number().int().min(250).nullable(),
    presentationCellId: z.string().regex(/^z(?:[0-9]|1[0-6])\/[0-9]+\/[0-9]+$/u).nullable(),
    rawSourceCoordinateUsed: z.literal(false),
  })
  .strict()
  .superRefine((entity, context) => {
    if (entity.representation === "focus_person_1to1" && entity.representedCount !== 1) {
      context.addIssue({ code: "custom", message: "A focus person must represent exactly one synthetic person" });
    }
    if (entity.representation === "ambient_only" && entity.representedCount !== 0) {
      context.addIssue({ code: "custom", message: "Ambient entities cannot represent scientific population" });
    }
    if (entity.representation === "aggregate_proxy" && entity.representedCount < 1) {
      context.addIssue({ code: "custom", message: "Aggregate proxies must represent at least one person" });
    }
    if (entity.representation === "focus_person_1to1") {
      if (entity.positionOrigin !== "privacy_grid_centroid" || entity.spatialResolutionM === null || entity.presentationCellId === null) {
        context.addIssue({ code: "custom", message: "Focus people require an explicit >=250m privacy grid" });
      }
    } else if (entity.positionOrigin !== "deterministic_viewport_synthesis" || entity.spatialResolutionM !== null || entity.presentationCellId !== null) {
      context.addIssue({ code: "custom", message: "Non-focus entities cannot claim focus privacy-grid metadata" });
    }
  });

export const ClockStateV1Schema = z
  .object({
    modelTime: IsoDateTimeSchema,
    presentationTime: IsoDateTimeSchema,
    speed: z.enum(["paused", "1x", "4x", "16x"]),
    visualSynthesisSeed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const ScenarioParameterValueSchema = z.union([
  z.number().finite(),
  z.string(),
  z.boolean(),
  z.null(),
]);

export const ScenarioDraftV1Schema = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(120),
    description: z.string().max(2000),
    geographyId: z.string().min(1),
    baselineRunId: z.string().min(1),
    parameters: z.record(z.string().min(1), ScenarioParameterValueSchema),
    revision: z.number().int().positive(),
    status: z.literal("draft"),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const GeographyFeatureV1Schema = z
  .object({
    id: z.string().min(1),
    parentId: z.string().min(1).nullable(),
    level: z.enum(["country", "federal_district", "subject", "municipality", "settlement", "district"]),
    nameRu: z.string().min(1),
    nameEn: z.string().min(1),
    geographyVintage: z.string().min(1),
    centroid: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
    bbox: z.tuple([
      z.number().min(-180).max(180),
      z.number().min(-90).max(90),
      z.number().min(-180).max(180),
      z.number().min(-90).max(90),
    ]),
  })
  .strict();

export const GeographyCatalogItemV1Schema = GeographyFeatureV1Schema.extend({
  childrenIds: z.array(z.string().min(1)),
  pathIds: z.array(z.string().min(1)).min(1),
  childCount: z.number().int().nonnegative(),
  hasPopulation: z.boolean(),
  hasFocusPeople: z.boolean(),
}).superRefine((item, context) => {
  if (new Set(item.childrenIds).size !== item.childrenIds.length) {
    context.addIssue({ code: "custom", message: "childrenIds must be unique" });
  }
  if (new Set(item.pathIds).size !== item.pathIds.length) {
    context.addIssue({ code: "custom", message: "pathIds must be unique" });
  }
  if (item.childCount !== item.childrenIds.length) {
    context.addIssue({ code: "custom", message: "childCount must match childrenIds" });
  }
});

export const GeographyCatalogV1Schema = z
  .object({
    runId: z.string().min(1),
    geographyVintage: z.string().min(1),
    rootIds: z.array(z.string().min(1)).min(1),
    sliceRootId: z.string().min(1),
    defaultFocusId: z.string().min(1),
    selectionBasis: z.enum([
      "focus_settlement_ancestor",
      "population_settlement",
      "population_hierarchy",
    ]),
    items: z.array(GeographyCatalogItemV1Schema).min(1),
    count: z.number().int().positive(),
  })
  .strict()
  .superRefine((catalog, context) => {
    const ids = catalog.items.map((item) => item.id);
    const known = new Set(ids);
    if (new Set(catalog.rootIds).size !== catalog.rootIds.length) {
      context.addIssue({ code: "custom", message: "rootIds must be unique" });
    }
    if (catalog.count !== catalog.items.length) {
      context.addIssue({ code: "custom", message: "count must match items" });
    }
    if (!known.has(catalog.sliceRootId) || !known.has(catalog.defaultFocusId)) {
      context.addIssue({ code: "custom", message: "Catalog defaults must reference catalog items" });
    }
  });

export const GeographyLevelSchema = z.enum([
  "country",
  "federal_district",
  "subject",
  "municipality",
  "settlement",
  "district",
]);

const TerritoryCoverageStatusSchema = z.enum([
  "complete",
  "partial",
  "presentation_only_provisional",
  "unavailable",
]);

const TerritoryRepresentationSchema = z.enum([
  "source_boundary",
  "source_point",
  "presentation_only_provisional",
  "model_bundle_fallback",
]);

export const TerritoryNodeV2Schema = z
  .object({
    id: z.string().min(1),
    parentId: z.string().min(1).nullable(),
    level: GeographyLevelSchema,
    nameRu: z.string().min(1),
    nameEn: z.string().min(1),
    geographyVintage: z.string().min(1),
    centroid: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
    bbox: z.tuple([
      z.number().min(-180).max(180),
      z.number().min(-90).max(90),
      z.number().min(-180).max(180),
      z.number().min(-90).max(90),
    ]),
    pathIds: z.array(z.string().min(1)).min(1),
    childCount: z.number().int().nonnegative(),
    coverageStatus: TerritoryCoverageStatusSchema,
    representation: TerritoryRepresentationSchema,
    hasModelData: z.boolean(),
    modelGeographyId: z.string().min(1).nullable(),
    canEnter3d: z.boolean(),
  })
  .strict()
  .superRefine((node, context) => {
    if (new Set(node.pathIds).size !== node.pathIds.length || node.pathIds.at(-1) !== node.id) {
      context.addIssue({ code: "custom", message: "pathIds must be unique and terminate at id" });
    }
    if (node.hasModelData !== (node.modelGeographyId !== null)) {
      context.addIssue({ code: "custom", message: "hasModelData must match modelGeographyId availability" });
    }
    if (
      node.canEnter3d &&
      (node.level !== "settlement" || node.modelGeographyId === null || node.coverageStatus === "presentation_only_provisional")
    ) {
      context.addIssue({ code: "custom", message: "Only linked, non-provisional settlements can enter 3D" });
    }
  });

export const TerritorySliceV1Schema = z
  .object({
    runId: SafeRunIdSchema,
    geographyVintage: z.string().min(1),
    source: z.enum(["national_boundary_pack", "model_bundle_fallback"]),
    parent: TerritoryNodeV2Schema,
    items: z.array(TerritoryNodeV2Schema),
    count: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((slice, context) => {
    if (slice.count !== slice.items.length) {
      context.addIssue({ code: "custom", message: "count must match items" });
    }
    if (slice.items.some((item) => item.parentId !== slice.parent.id)) {
      context.addIssue({ code: "custom", message: "Every item must be an immediate child of parent" });
    }
  });

export const TerritorySearchResponseV1Schema = z
  .object({
    runId: SafeRunIdSchema,
    geographyVintage: z.string().min(1),
    query: z.string().min(2).max(120),
    scopeParentId: z.string().min(1).nullable(),
    items: z.array(TerritoryNodeV2Schema),
    count: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.count !== result.items.length) {
      context.addIssue({ code: "custom", message: "count must match items" });
    }
  });

export const MetricDefinitionV1Schema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u),
    labelRu: z.string().min(1),
    labelEn: z.string().min(1),
    unit: z.string().min(1),
    valueKind: z.enum(["count", "rate", "share", "density"]),
    aggregation: z.enum(["sum", "ratio"]),
    cube: z.enum(["population", "events"]),
    sourceMetric: z.string().min(1),
    temporalKind: z.enum(["stock", "period"]),
    isDefault: z.boolean(),
  })
  .strict();

export const MetricCatalogV1Schema = z
  .object({
    runId: SafeRunIdSchema,
    geographyVintage: z.string().min(1),
    defaultMetricId: z.literal("population.total"),
    items: z.array(MetricDefinitionV1Schema).min(1),
    count: z.number().int().positive(),
  })
  .strict()
  .superRefine((catalog, context) => {
    const defaults = catalog.items.filter((item) => item.isDefault);
    if (catalog.count !== catalog.items.length || defaults.length !== 1 || defaults[0]?.id !== catalog.defaultMetricId) {
      context.addIssue({ code: "custom", message: "Metric catalog count/default invariant failed" });
    }
  });

const TerritoryMetricDatumV1Schema = z
  .object({
    territoryId: z.string().min(1),
    modelGeographyId: z.string().min(1).nullable(),
    value: z.number().finite().nullable(),
    unit: z.string().min(1),
    status: z.enum(["available", "missing", "not_linked"]),
    stockAsOf: IsoDateSchema.nullable(),
    periodStart: IsoDateSchema.nullable(),
    periodEnd: IsoDateSchema.nullable(),
    coverage: z.number().min(0).max(1).nullable(),
    provenance: z.array(ScientificProvenanceSchema),
  })
  .strict()
  .superRefine((datum, context) => {
    if ((datum.status === "available") !== (datum.value !== null)) {
      context.addIssue({ code: "custom", message: "Only available metric data may carry a value" });
    }
    if ((datum.status === "not_linked") !== (datum.modelGeographyId === null)) {
      context.addIssue({ code: "custom", message: "not_linked must match modelGeographyId availability" });
    }
    const stock = datum.stockAsOf !== null;
    const period = datum.periodStart !== null && datum.periodEnd !== null;
    if (datum.status === "available" && stock === period) {
      context.addIssue({ code: "custom", message: "Available data requires exactly one temporal contract" });
    }
  });

export const TerritoryMetricSliceV1Schema = z
  .object({
    runId: SafeRunIdSchema,
    geographyVintage: z.string().min(1),
    territoryId: z.string().min(1),
    metric: MetricDefinitionV1Schema,
    source: z.literal("model_bundle"),
    items: z.array(TerritoryMetricDatumV1Schema).min(1),
    count: z.number().int().positive(),
    complete: z.boolean(),
  })
  .strict()
  .superRefine((slice, context) => {
    if (slice.count !== slice.items.length || slice.complete !== slice.items.every((item) => item.status === "available")) {
      context.addIssue({ code: "custom", message: "Metric slice count/complete invariant failed" });
    }
  });

const SettlementPointV1Schema = z
  .object({
    id: z.string().min(1),
    nameRu: z.string().min(1),
    nameEn: z.string().min(1),
    centroid: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
    settlementType: z.string().min(1).nullable(),
    coverageStatus: TerritoryCoverageStatusSchema,
    representation: z.enum(["source_point", "presentation_only_provisional", "model_bundle_fallback"]),
    population: z.number().int().nonnegative().nullable(),
    populationStatus: z.enum(["available", "missing", "not_linked"]),
    populationStockAsOf: IsoDateSchema.nullable(),
    populationCoverage: z.number().min(0).max(1).nullable(),
    populationProvenance: z.array(ScientificProvenanceSchema),
    populationSource: z.literal("model_bundle"),
    scientificClaim: z.boolean(),
    modelGeographyId: z.string().min(1).nullable(),
    canEnter3d: z.boolean(),
  })
  .strict()
  .superRefine((point, context) => {
    if ((point.populationStatus === "available") !== (point.population !== null)) {
      context.addIssue({ code: "custom", message: "Only available model population may carry a value" });
    }
    if ((point.populationStatus === "not_linked") !== (point.modelGeographyId === null)) {
      context.addIssue({ code: "custom", message: "not_linked must match modelGeographyId availability" });
    }
    if (
      point.canEnter3d &&
      (point.modelGeographyId === null || point.coverageStatus === "presentation_only_provisional")
    ) {
      context.addIssue({ code: "custom", message: "Only linked, non-provisional settlements can enter 3D" });
    }
  });

export const SettlementPointSliceV1Schema = z
  .object({
    runId: SafeRunIdSchema,
    municipalityId: z.string().min(1),
    geographyVintage: z.string().min(1),
    source: z.enum(["national_boundary_pack", "model_bundle_fallback"]),
    items: z.array(SettlementPointV1Schema),
    count: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((slice, context) => {
    if (slice.count !== slice.items.length) {
      context.addIssue({ code: "custom", message: "count must match items" });
    }
  });

const RelativeBoundaryAssetPathSchema = z
  .string()
  .regex(/^[A-Za-z0-9._/-]+$/u)
  .refine((path) => !path.startsWith("/") && !/(?:^|\/)\.\.(?:\/|$)/u.test(path), "Expected safe relative path");
const BoundaryAssetUrlSchema = z.string().regex(/^\/v2\/territories\/artifacts\/[A-Za-z0-9._/-]+$/u);
const BoundaryAssetDescriptorSchema = z
  .object({
    path: RelativeBoundaryAssetPathSchema,
    url: BoundaryAssetUrlSchema,
    sha256: Sha256Schema,
    bytes: z.number().int().positive(),
    featureCount: z.number().int().nonnegative(),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  })
  .strict();

export const BoundaryPackManifestV1Schema = z
  .object({
    format: z.literal("omnitwin.boundary-pack-manifest.v1"),
    version: z.number().int().positive(),
    datasetVersion: z.string().min(1),
    geographyVintage: z.string().min(1),
    generatedAt: IsoDateTimeSchema,
    transport: z.literal("compressed_geojson_shards_v1"),
    contentEncoding: z.literal("gzip"),
    contentType: z.literal("application/geo+json"),
    bbox: z.tuple([
      z.number().min(-180).max(180),
      z.number().min(-90).max(90),
      z.number().min(-180).max(180),
      z.number().min(-90).max(90),
    ]),
    national: BoundaryAssetDescriptorSchema.extend({
      featureCount: z.number().int().positive(),
      levels: z.array(z.enum(["country", "federal_district", "subject"])).min(3),
    }).strict(),
    municipalityShards: z.array(BoundaryAssetDescriptorSchema.extend({
      subjectId: z.string().min(1),
      levels: z.tuple([z.literal("municipality")]),
      coverageStatus: TerritoryCoverageStatusSchema,
    }).strict()),
    settlementSlices: z.array(BoundaryAssetDescriptorSchema.extend({
      subjectId: z.string().min(1),
      municipalityId: z.string().min(1),
      levels: z.tuple([z.literal("settlement")]),
      coverageStatus: TerritoryCoverageStatusSchema,
    }).strict()),
    coverage: z.object({
      countryCount: z.number().int().positive(),
      federalDistrictCount: z.number().int().nonnegative(),
      subjectCount: z.number().int().nonnegative(),
      presentationOnlySubjectCount: z.number().int().nonnegative(),
      expectedMunicipalitySubjectShardCount: z.number().int().nonnegative(),
      compiledMunicipalitySubjectShardCount: z.number().int().nonnegative(),
      compiledMunicipalityFeatureCount: z.number().int().nonnegative(),
      expectedMunicipalityDimensionCount: z.number().int().nonnegative(),
      compiledSettlementSliceCount: z.number().int().nonnegative(),
      compiledSettlementPointCount: z.number().int().nonnegative(),
      provisionalMunicipalityFeatureCount: z.number().int().nonnegative(),
      checkpointPartial: z.boolean(),
    }).strict(),
    simplification: z.object({
      method: z.literal("shapely.coverage_simplify_or_topology_preserving_fallback"),
      subjectToleranceDegrees: z.number().nonnegative(),
      municipalityToleranceDegrees: z.number().nonnegative(),
      coordinatePrecisionDecimals: z.number().int().min(0).max(15),
      makeValid: z.literal(true),
      antimeridianPolicy: z.literal("unwrap_split_at_180_normalize_rfc7946"),
    }).strict(),
    sourceLedger: z.array(z.object({
      sourceId: z.string().min(1),
      role: z.string().min(1),
      pathHint: z.string().min(1),
      sha256: Sha256Schema,
      bytes: z.number().int().nonnegative(),
      license: z.string().min(1),
      rightsStatus: z.string().min(1),
    }).strict()),
    quality: z.object({
      makeValidFeatureCount: z.number().int().nonnegative(),
      antimeridianSplitFeatureCount: z.number().int().nonnegative(),
      coverageSimplificationFallbackGroupCount: z.number().int().nonnegative(),
      publicReleaseEligible: z.boolean(),
      publicReleaseBlockers: z.array(z.string().min(1)),
    }).strict(),
    semantics: z.object({
      containsModelMetrics: z.literal(false),
      populationReference2021: z.literal("source_reference_not_model_metric"),
      runtimeNameJoinAllowed: z.literal(false),
      runtimeSpatialJoinAllowed: z.literal(false),
    }).strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (new Set(manifest.national.levels).size !== manifest.national.levels.length) {
      context.addIssue({ code: "custom", message: "national levels must be unique" });
    }
    if (new Set(manifest.municipalityShards.map((item) => item.subjectId)).size !== manifest.municipalityShards.length) {
      context.addIssue({ code: "custom", message: "municipality shard subjectIds must be unique" });
    }
    if (new Set(manifest.settlementSlices.map((item) => item.municipalityId)).size !== manifest.settlementSlices.length) {
      context.addIssue({ code: "custom", message: "settlement slice municipalityIds must be unique" });
    }
  });

export const WorldViewportResponseV1Schema = z
  .object({
    runId: SafeRunIdSchema,
    geographyId: z.string().min(1),
    geographyVintage: z.string().min(1),
    classification: z.literal("visual_synthesis"),
    scientificClaim: z.literal(false),
    seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    modelTime: IsoDateTimeSchema,
    representedPopulation: z.number().int().nonnegative(),
    renderedPopulationEntities: z.number().int().nonnegative(),
    ambientEntities: z.number().int().nonnegative(),
    entities: z.array(VisualEntityV1Schema),
  })
  .strict();

const OpaqueIdSchema = z.string().regex(/^agt_[a-f0-9]{24,64}$/u);
const AgentCatalogItemSchema = z
  .object({
    opaqueId: OpaqueIdSchema,
    geographyId: z.string().min(1),
    ageBand: z.string().min(1),
    sex: z.enum(["female", "male"]),
    employmentStatus: z.string().min(1),
  })
  .strict();

export const AgentCatalogResponseV1Schema = z
  .object({
    runId: SafeRunIdSchema,
    classification: z.literal("local_restricted_focus_sample"),
    synthetic: z.boolean(),
    runMetadata: z
      .object({
        runId: SafeRunIdSchema,
        runMode: RunModeSchema,
        dataCutoff: IsoDateSchema,
        geographyVintage: z.string().min(1),
        scientificClaim: z.boolean(),
      })
      .strict(),
    privacy: z.object({ identifier: z.literal("run_local_opaque"), rawPersonIdAvailable: z.literal(false) }).strict(),
    items: z.array(AgentCatalogItemSchema),
    count: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((catalog, context) => {
    if (catalog.count !== catalog.items.length) {
      context.addIssue({ code: "custom", message: "Agent catalog count must match items" });
    }
    if (catalog.synthetic !== (catalog.runMetadata.runMode === "synthetic")) {
      context.addIssue({ code: "custom", message: "Synthetic flag must match run mode" });
    }
  });

export const AgentProfileResponseV1Schema = z
  .object({
    agent: AgentCatalogItemSchema.extend({
      householdSize: z.number().int().positive(),
      scientificState: z
        .object({
          stockAsOf: IsoDateSchema,
          provenance: ScientificProvenanceSchema,
          geographyVintage: z.string().min(1),
        })
        .strict(),
    }).strict(),
    privacy: z
      .object({
        scope: z.literal("local_only"),
        identifier: z.literal("run_local_opaque"),
        rawPersonIdAvailable: z.literal(false),
        personalExportAllowed: z.literal(false),
      })
      .strict(),
  })
  .strict();

const ClockTimeSchema = z.string().regex(/^(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00)$/u);
export const AgentPresentationDayResponseV1Schema = z
  .object({
    opaqueId: OpaqueIdSchema,
    modelTime: IsoDateTimeSchema,
    presentationDate: IsoDateSchema,
    classification: z.literal("visual_synthesis"),
    scientificClaim: z.literal(false),
    schedule: z.array(
      z
        .object({
          start: ClockTimeSchema,
          end: ClockTimeSchema,
          activity: z.enum(["home", "work", "study", "travel", "leisure"]),
          placeKind: z.enum(["home", "route", "work", "study", "leisure"]),
        })
        .strict(),
    ),
  })
  .strict();

export const AgentTimelineResponseV1Schema = z
  .object({
    opaqueId: OpaqueIdSchema,
    scientificEvents: z.tuple([]),
    scientificEventsStatus: z.literal("not_available_in_focus_projection"),
    presentationEvents: z.array(
      z
        .object({
          time: ClockTimeSchema,
          kind: z.string().min(1),
          classification: z.literal("visual_synthesis"),
        })
        .strict(),
    ),
  })
  .strict();

export const ApiErrorV1Schema = z
  .object({
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        retryable: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type RunMode = z.infer<typeof RunModeSchema>;
export type CompletionFileV1 = z.infer<typeof CompletionFileV1Schema>;
export type VisualEntityKind = z.infer<typeof VisualEntityKindSchema>;

export function advancePresentationClock(clock: ClockStateV1, presentationTime: string): ClockStateV1 {
  return ClockStateV1Schema.parse({ ...clock, presentationTime });
}

export const SCENE_FORMAT = "omnitwin.scene.v1" as const;

const SceneIdSchema = SafeRunIdSchema;
const SceneVersionSchema = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/u);
const IanaTimeZoneSchema = z.string().regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+$/u);
const RelativeScenePathSchema = z
  .string()
  .regex(/^[A-Za-z0-9._/-]+$/u)
  .refine((path) => !/^[A-Za-z]:/u.test(path) && !/^[/\\]/u.test(path) && !/(?:^|[/\\])\.\.(?:[/\\]|$)/u.test(path), "Expected a portable relative path");
const ContentPathSchema = z
  .string()
  .regex(/^content\/[A-Za-z0-9._/-]+$/u)
  .refine((path) => !/(?:^|\/)\.\.(?:\/|$)/u.test(path), "Content path traversal is forbidden");
const SceneRawBboxSchema = z.tuple([
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
  ]);
const SceneBboxSchema = SceneRawBboxSchema
  .refine(([west, south, east, north]) => west < east && south < north, "Expected an ordered bbox");
const ScenePositionSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const CellIdSchema = z.string().regex(/^z16\/[0-9]{1,5}\/[0-9]{1,5}$/u);
const SceneEntityIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/u);
const SceneSourceIdSchema = SafeRunIdSchema;
const SceneProvenanceSchema = z.enum([
  "external_cartography",
  "reanalysis_environment",
  "derived_cartography",
  "visual_synthesis",
]);
const SceneCapabilitiesSchema = z
  .object({
    z16Cells: z.boolean(),
    staticFeatures: z.boolean(),
    movementNetwork: z.boolean(),
    anchors: z.boolean(),
    environmentPresets: z.boolean(),
    reanalysisEnvironment: z.boolean(),
    externalEnvironment: z.literal(false),
  })
  .strict();

const SceneCoverageSchema = z
  .object({
    bbox: SceneRawBboxSchema,
    longitudeWrap: z.enum(["none", "antimeridian"]),
    geographyIds: z.array(z.string().min(1)).min(1),
    geographyCatalogSha256: Sha256Schema,
    zMin: z.number().int().min(0).max(22),
    zMax: z.number().int().min(0).max(22),
  })
  .strict()
  .superRefine((coverage, context) => {
    if (new Set(coverage.geographyIds).size !== coverage.geographyIds.length) {
      context.addIssue({ code: "custom", message: "geographyIds must be unique" });
    }
    if (coverage.zMin > coverage.zMax) {
      context.addIssue({ code: "custom", message: "zMin must not exceed zMax" });
    }
    const [west, south, east, north] = coverage.bbox;
    if (south >= north || (coverage.longitudeWrap === "none" ? west >= east : west <= east)) {
      context.addIssue({ code: "custom", message: "coverage bbox must match longitudeWrap" });
    }
  });

const SourceCoverageSchema = z
  .object({ bbox: SceneRawBboxSchema, longitudeWrap: z.enum(["none", "antimeridian"]), geographyIds: z.array(z.string().min(1)).min(1) })
  .strict()
  .superRefine((coverage, context) => {
    if (new Set(coverage.geographyIds).size !== coverage.geographyIds.length) {
      context.addIssue({ code: "custom", message: "geographyIds must be unique" });
    }
    const [west, south, east, north] = coverage.bbox;
    if (south >= north || (coverage.longitudeWrap === "none" ? west >= east : west <= east)) {
      context.addIssue({ code: "custom", message: "source bbox must match longitudeWrap" });
    }
  });

const EnvironmentMetadataSchema = z
  .object({
    datasetId: z.string().min(1),
    doi: z.union([z.string().regex(/^10\.[0-9]{4,9}\/[\-._;()/:A-Za-z0-9]+$/u), z.null()]),
    variables: z.array(z.string().min(1)).min(1),
    variableUnits: z.record(z.string().min(1), z.string().min(1)).refine((units) => Object.keys(units).length > 0, "variable units cannot be empty"),
    temporalResolution: z.literal("PT1H"),
    grid: z.object({ crs: z.string().min(1), resolutionDegrees: z.number().positive().max(10) }).strict(),
    temporalCoverage: z
      .object({
        start: IsoDateTimeSchema,
        end: IsoDateTimeSchema,
        year: z.number().int().min(1900).max(2200),
      })
      .strict(),
    retrievedAt: IsoDateTimeSchema,
    revision: z.string().min(1),
  })
  .strict()
  .superRefine((metadata, context) => {
    if (new Set(metadata.variables).size !== metadata.variables.length) {
      context.addIssue({ code: "custom", message: "environment variables must be unique" });
    }
    if (new Set(metadata.variables).size !== Object.keys(metadata.variableUnits).length || metadata.variables.some((variable) => !(variable in metadata.variableUnits))) {
      context.addIssue({ code: "custom", message: "environment variable units must cover exactly the declared variables" });
    }
    if (metadata.temporalCoverage.start >= metadata.temporalCoverage.end) {
      context.addIssue({ code: "custom", message: "environment temporal coverage must be ordered" });
    }
  });

const CartographyMetadataSchema = z
  .object({
    provider: z.enum(["overture", "openstreetmap"]),
    overtureTheme: z.string().min(1).nullable(),
    overtureRelease: z.string().regex(/^20[0-9]{2}-[0-9]{2}-[0-9]{2}\.[0-9]+$/u).nullable(),
    osmSnapshotId: z.string().min(1).nullable(),
    licenseId: z.string().min(1),
    upstreamSources: z.array(z.object({ name: z.string().min(1), license: z.string().min(1), attribution: z.string().min(1) }).strict()).min(1),
  })
  .strict();

export const SceneSourceSnapshotV1Schema = z
  .object({
    sourceId: SceneSourceIdSchema,
    sourceType: z.enum(["cartography", "landcover", "transport_network", "points_of_interest", "environment", "visual_synthesis"]),
    adapter: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,127}$/u),
    provenance: SceneProvenanceSchema,
    license: z
      .object({ name: z.string().min(1), url: z.union([z.string().url(), z.null()]), attribution: z.string().min(1) })
      .strict(),
    snapshotAt: IsoDateTimeSchema,
    inputPath: RelativeScenePathSchema,
    inputSha256: Sha256Schema,
    coverage: SourceCoverageSchema,
    cartographyMetadata: CartographyMetadataSchema.nullable(),
    environmentMetadata: EnvironmentMetadataSchema.nullable(),
    scientificClaim: z.literal(false),
  })
  .strict()
  .superRefine((source, context) => {
    if (source.provenance === "reanalysis_environment" && source.sourceType !== "environment") {
      context.addIssue({ code: "custom", message: "environment provenance requires environment sourceType" });
    }
    if (source.provenance === "visual_synthesis" && source.sourceType !== "visual_synthesis") {
      context.addIssue({ code: "custom", message: "visual synthesis provenance requires visual_synthesis sourceType" });
    }
    if ((source.provenance === "reanalysis_environment") !== (source.environmentMetadata !== null)) {
      context.addIssue({ code: "custom", message: "reanalysis metadata is required only for reanalysis sources" });
    }
    if (source.environmentMetadata !== null) {
      const coverageEnd = Date.parse(source.environmentMetadata.temporalCoverage.end);
      const retrievedAt = Date.parse(source.environmentMetadata.retrievedAt);
      const snapshotAt = Date.parse(source.snapshotAt);
      if (!(coverageEnd <= retrievedAt && retrievedAt <= snapshotAt)) {
        context.addIssue({ code: "custom", message: "environment chronology must satisfy coverage end <= retrieval <= snapshot" });
      }
    }
    if (["environment", "visual_synthesis"].includes(source.sourceType) && source.cartographyMetadata !== null) {
      context.addIssue({ code: "custom", message: "environment and synthesis sources cannot carry cartography metadata" });
    }
    if (source.adapter.match(/^overture(?:[_.-]|$)/u) && (source.cartographyMetadata?.provider !== "overture" || source.cartographyMetadata.overtureTheme === null || source.cartographyMetadata.overtureRelease === null || source.cartographyMetadata.osmSnapshotId !== null)) {
      context.addIssue({ code: "custom", message: "Overture adapters require theme and upstream licensing metadata" });
    }
    if (source.adapter.match(/^osm(?:[_.-]|$)/u) && (source.cartographyMetadata?.provider !== "openstreetmap" || source.cartographyMetadata.overtureTheme !== null || source.cartographyMetadata.overtureRelease !== null || source.cartographyMetadata.osmSnapshotId === null || source.cartographyMetadata.licenseId !== "ODbL-1.0")) {
      context.addIssue({ code: "custom", message: "OSM adapters require snapshot and ODbL metadata" });
    }
  });

const CanonicalSceneLayerIds = ["cells", "features", "network_nodes", "network_edges", "anchors", "environment"] as const;
const CanonicalScenePaths = ["cells.parquet", "features.parquet", "network_nodes.parquet", "network_edges.parquet", "anchors.parquet", "environment.parquet"] as const;
const CanonicalLayerPath = Object.fromEntries(CanonicalSceneLayerIds.map((layer, index) => [layer, CanonicalScenePaths[index]]));

export const SceneLayerDescriptorV1Schema = z
  .object({
    layerId: z.enum(CanonicalSceneLayerIds),
    path: z.enum(CanonicalScenePaths),
    format: z.literal("parquet"),
    required: z.boolean(),
    classification: SceneProvenanceSchema,
    sourceIds: z.array(SceneSourceIdSchema).min(1),
    sha256: Sha256Schema,
    bytes: z.number().int().nonnegative(),
    rows: z.number().int().nonnegative(),
    minZoom: z.number().int().min(0).max(22).nullable(),
    maxZoom: z.number().int().min(0).max(22).nullable(),
  })
  .strict()
  .superRefine((layer, context) => {
    if (CanonicalLayerPath[layer.layerId] !== layer.path) {
      context.addIssue({ code: "custom", message: "layerId/path mapping is not canonical" });
    }
    if ((layer.minZoom === null) !== (layer.maxZoom === null) || (layer.minZoom !== null && layer.maxZoom !== null && layer.minZoom > layer.maxZoom)) {
      context.addIssue({ code: "custom", message: "zoom bounds must be null together or ordered" });
    }
    if (new Set(layer.sourceIds).size !== layer.sourceIds.length) {
      context.addIssue({ code: "custom", message: "layer sourceIds must be unique" });
    }
  });

const SceneHashesSchema = z
  .object({
    "cells.parquet": Sha256Schema,
    "features.parquet": Sha256Schema,
    "network_nodes.parquet": Sha256Schema,
    "network_edges.parquet": Sha256Schema,
    "anchors.parquet": Sha256Schema,
    "environment.parquet": Sha256Schema,
  })
  .strict();

const SceneBasemapV1Schema = z
  .object({
    format: z.literal("pmtiles"),
    path: z.string().regex(/^content\/basemap\/[A-Za-z0-9._-]+\.pmtiles$/u),
    sha256: Sha256Schema,
    bytes: z.number().int().positive(),
    attribution: z.string().min(1),
    sourceIds: z.array(SceneSourceIdSchema).min(1),
  })
  .strict()
  .superRefine((basemap, context) => {
    if (new Set(basemap.sourceIds).size !== basemap.sourceIds.length) context.addIssue({ code: "custom", message: "basemap sources must be unique" });
  });

export const SceneManifestV1Schema = z
  .object({
    format: z.literal(SCENE_FORMAT),
    sceneId: SceneIdSchema,
    sceneVersion: SceneVersionSchema,
    status: z.literal("complete"),
    immutable: z.literal(true),
    geographyVintage: z.string().min(1),
    timeZone: IanaTimeZoneSchema,
    completedAt: IsoDateTimeSchema,
    coverage: SceneCoverageSchema,
    sourceSnapshots: z.array(SceneSourceSnapshotV1Schema).min(1),
    layers: z.array(SceneLayerDescriptorV1Schema).length(6),
    basemap: SceneBasemapV1Schema.nullable(),
    cellIndex: z.object({ path: z.literal("content/cells/index.json"), sha256: Sha256Schema, bytes: z.number().int().positive(), cellCount: z.number().int().positive() }).strict(),
    movementGraph: z.lazy(() => MovementGraphV1Schema),
    environmentCycles: z.array(z.lazy(() => EnvironmentCycleV1Schema)).min(1),
    capabilities: SceneCapabilitiesSchema,
    hashes: SceneHashesSchema,
    contentHashes: z
      .record(z.string(), Sha256Schema)
      .refine((hashes) => Object.keys(hashes).every((path) => ContentPathSchema.safeParse(path).success), "content hashes require safe content/* paths"),
    scientificClaim: z.literal(false),
  })
  .strict()
  .superRefine((manifest, context) => {
    const sourceIds = manifest.sourceSnapshots.map((source) => source.sourceId);
    if (new Set(sourceIds).size !== sourceIds.length) {
      context.addIssue({ code: "custom", message: "sourceIds must be unique" });
    }
    const layerIds = manifest.layers.map((layer) => layer.layerId);
    const paths = manifest.layers.map((layer) => layer.path);
    if (new Set(layerIds).size !== 6 || new Set(paths).size !== 6) {
      context.addIssue({ code: "custom", message: "manifest must contain each canonical layer exactly once" });
    }
    const knownSources = new Set(sourceIds);
    for (const layer of manifest.layers) {
      if (layer.sourceIds.some((sourceId) => !knownSources.has(sourceId))) {
        context.addIssue({ code: "custom", message: "layer references an unknown source" });
      }
      if (manifest.hashes[layer.path] !== layer.sha256) {
        context.addIssue({ code: "custom", message: "layer SHA must match manifest hashes" });
      }
    }
    if (
      manifest.movementGraph.sceneId !== manifest.sceneId ||
      manifest.movementGraph.nodes.sha256 !== manifest.hashes["network_nodes.parquet"] ||
      manifest.movementGraph.edges.sha256 !== manifest.hashes["network_edges.parquet"]
    ) {
      context.addIssue({ code: "custom", message: "movement graph must bind to the manifest scene and network hashes" });
    }
    if (manifest.contentHashes[manifest.cellIndex.path] !== manifest.cellIndex.sha256) context.addIssue({ code: "custom", message: "cell index must be content-hash bound" });
    if (manifest.basemap !== null && (manifest.contentHashes[manifest.basemap.path] !== manifest.basemap.sha256 || manifest.basemap.sourceIds.some((sourceId) => !knownSources.has(sourceId)))) context.addIssue({ code: "custom", message: "basemap must be content-hash and source-inventory bound" });
    const nodeLayer = manifest.layers.find((layer) => layer.layerId === "network_nodes");
    const edgeLayer = manifest.layers.find((layer) => layer.layerId === "network_edges");
    if (nodeLayer?.rows !== manifest.movementGraph.nodeCount || edgeLayer?.rows !== manifest.movementGraph.edgeCount || manifest.movementGraph.sourceIds.some((sourceId) => !knownSources.has(sourceId))) {
      context.addIssue({ code: "custom", message: "movement graph counts and sources must bind to canonical layers" });
    }
    const cycleIds = manifest.environmentCycles.map((cycle) => cycle.cycleId);
    if (new Set(cycleIds).size !== cycleIds.length) context.addIssue({ code: "custom", message: "environment cycle IDs must be unique" });
    if (manifest.environmentCycles.some((cycle) => cycle.sceneId !== manifest.sceneId || cycle.timeZone !== manifest.timeZone || !knownSources.has(cycle.sourceId))) {
      context.addIssue({ code: "custom", message: "environment cycles must bind to the scene, time zone, and source inventory" });
    }
  });

const SceneCompletionFileV1Schema = z
  .object({
    path: z.union([z.enum(["scene.json", ...CanonicalScenePaths]), ContentPathSchema]),
    sha256: Sha256Schema,
    bytes: z.number().int().nonnegative(),
    rows: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .superRefine((file, context) => {
    const tabular = (CanonicalScenePaths as readonly string[]).includes(file.path);
    if (tabular === (file.rows === null)) {
      context.addIssue({ code: "custom", message: "canonical Parquet rows must be integers; scene/content rows must be null" });
    }
  });

export const SceneCompletionReportV1Schema = z
  .object({
    format: z.literal(SCENE_FORMAT),
    status: z.literal("complete"),
    immutable: z.literal(true),
    sceneId: SceneIdSchema,
    geographyVintage: z.string().min(1),
    completedAt: IsoDateTimeSchema,
    files: z.array(SceneCompletionFileV1Schema).min(7),
  })
  .strict()
  .superRefine((report, context) => {
    const expected = new Set(["scene.json", ...CanonicalScenePaths]);
    const actual = report.files.map((file) => file.path);
    const actualSet = new Set(actual);
    if (actualSet.size !== actual.length || [...expected].some((path) => !actualSet.has(path))) {
      context.addIssue({ code: "custom", message: "completion report must contain each canonical file exactly once" });
    }
  });

const GeometryFieldSourceSchema = z
  .object({ sourceId: SceneSourceIdSchema, provenance: z.enum(["external_cartography", "derived_cartography"]) })
  .strict();
const AllocationFieldSourceSchema = z
  .object({ sourceId: SceneSourceIdSchema, provenance: z.enum(["derived_cartography", "visual_synthesis"]), derivationVersion: SceneVersionSchema.nullable() })
  .strict()
  .superRefine((source, context) => {
    if (source.provenance === "visual_synthesis" && source.derivationVersion === null) context.addIssue({ code: "custom", message: "visual synthesis requires derivationVersion" });
  });
const LandUseFieldSourceSchema = z
  .object({ sourceId: SceneSourceIdSchema, provenance: z.enum(["external_cartography", "derived_cartography", "visual_synthesis"]), derivationVersion: SceneVersionSchema.nullable() })
  .strict()
  .superRefine((source, context) => {
    if (source.provenance === "visual_synthesis" && source.derivationVersion === null) context.addIssue({ code: "custom", message: "visual synthesis requires derivationVersion" });
  });

export const SceneCellDescriptorV1Schema = z
  .object({
    sceneId: SceneIdSchema,
    cellId: CellIdSchema,
    z: z.literal(16),
    x: z.number().int().min(0).max(65535),
    y: z.number().int().min(0).max(65535),
    geographyId: z.string().min(1),
    centroid: ScenePositionSchema,
    bbox: SceneBboxSchema,
    landUseClass: z.enum(["residential", "mixed_use", "commercial", "industrial", "education", "leisure", "transport", "green", "water", "other"]),
    allocationShares: z
      .object({
        population: z.number().min(0).max(1),
        jobs: z.number().min(0).max(1),
        study: z.number().min(0).max(1),
        leisure: z.number().min(0).max(1),
      })
      .strict(),
    content: z
      .object({
        path: ContentPathSchema,
        format: z.enum(["pmtiles", "flatgeobuf", "binary"]),
        sha256: Sha256Schema,
      })
      .strict()
      .nullable(),
    fieldSources: z.object({ geometry: GeometryFieldSourceSchema, landUse: LandUseFieldSourceSchema, allocation: AllocationFieldSourceSchema }).strict(),
    sourceIds: z.array(SceneSourceIdSchema).min(1),
    provenance: z.enum(["external_cartography", "derived_cartography", "visual_synthesis"]),
    scientificClaim: z.literal(false),
  })
  .strict()
  .superRefine((cell, context) => {
    if (cell.cellId !== `z16/${cell.x}/${cell.y}`) {
      context.addIssue({ code: "custom", message: "cellId must match z/x/y" });
    }
    const [west, south, east, north] = cell.bbox;
    if (cell.centroid[0] < west || cell.centroid[0] > east || cell.centroid[1] < south || cell.centroid[1] > north) {
      context.addIssue({ code: "custom", message: "cell centroid must be inside bbox" });
    }
    const sources = new Set(cell.sourceIds);
    if (sources.size !== cell.sourceIds.length || !sources.has(cell.fieldSources.geometry.sourceId) || !sources.has(cell.fieldSources.landUse.sourceId) || !sources.has(cell.fieldSources.allocation.sourceId)) {
      context.addIssue({ code: "custom", message: "field source references must be unique and inventoried" });
    }
  });

const NullableFeatureFieldSourceSchema = z
  .object({
    sourceId: SceneSourceIdSchema.nullable(),
    provenance: z.enum(["external_cartography", "derived_cartography", "visual_synthesis", "not_available"]),
    derivationVersion: SceneVersionSchema.nullable(),
  })
  .strict()
  .superRefine((source, context) => {
    if ((source.provenance === "not_available") !== (source.sourceId === null)) {
      context.addIssue({ code: "custom", message: "not_available provenance and null sourceId must occur together" });
    }
    if (source.provenance === "visual_synthesis" && source.derivationVersion === null) {
      context.addIssue({ code: "custom", message: "visual synthesis requires derivationVersion" });
    }
  });

export const SceneStaticFeatureV1Schema = z
  .object({
    sceneId: SceneIdSchema,
    featureId: SceneEntityIdSchema,
    featureKind: z.enum(["building", "road", "landcover", "water", "park", "poi", "transit_stop"]),
    geometryType: z.enum(["point", "line_string", "polygon"]),
    geometryWkbHex: z.string().regex(/^(?:[a-f0-9]{2})+$/u),
    cellIds: z.array(CellIdSchema).min(1),
    geographyId: z.string().min(1).nullable(),
    sourceId: SceneSourceIdSchema,
    displayName: z.string().min(1).nullable(),
    category: z.string().min(1).nullable(),
    heightMeters: z.number().min(0).max(1000).nullable(),
    levels: z.number().int().min(0).max(250).nullable(),
    capacityProxy: z.number().int().nonnegative().nullable(),
    fieldSources: z
      .object({
        geometry: GeometryFieldSourceSchema,
        attributes: NullableFeatureFieldSourceSchema,
        capacity: NullableFeatureFieldSourceSchema,
      })
      .strict(),
    provenance: z.enum(["external_cartography", "derived_cartography", "visual_synthesis"]),
    scientificClaim: z.literal(false),
  })
  .strict()
  .superRefine((feature, context) => {
    const expectedGeometry = feature.featureKind === "road"
      ? "line_string"
      : ["poi", "transit_stop"].includes(feature.featureKind)
        ? "point"
        : "polygon";
    if (feature.geometryType !== expectedGeometry) {
      context.addIssue({ code: "custom", message: "feature kind and geometry type are incompatible" });
    }
    if (new Set(feature.cellIds).size !== feature.cellIds.length) {
      context.addIssue({ code: "custom", message: "feature cellIds must be unique" });
    }
    const attributesMissing = feature.displayName === null && feature.category === null && feature.heightMeters === null && feature.levels === null;
    if ((feature.fieldSources.attributes.provenance === "not_available") !== attributesMissing) {
      context.addIssue({ code: "custom", message: "attribute provenance must match attribute availability" });
    }
    if ((feature.fieldSources.capacity.provenance === "not_available") !== (feature.capacityProxy === null)) {
      context.addIssue({ code: "custom", message: "capacity provenance must match capacity availability" });
    }
  });

export const MovementNodeV1Schema = z
  .object({
    sceneId: SceneIdSchema,
    nodeId: SceneEntityIdSchema,
    cellId: CellIdSchema,
    position: ScenePositionSchema,
    sourceId: SceneSourceIdSchema,
    provenance: z.enum(["external_cartography", "derived_cartography"]),
    scientificClaim: z.literal(false),
  })
  .strict();

const MovementModeSchema = z.enum(["pedestrian", "bicycle", "car", "transit"]);
const EdgeKindSchema = z.enum(["sidewalk", "crosswalk", "lane"]);
const VisualSpeedSchema = z
  .object({
    pedestrian: z.number().positive().max(10).nullable(),
    bicycle: z.number().positive().max(30).nullable(),
    car: z.number().positive().max(100).nullable(),
    transit: z.number().positive().max(100).nullable(),
  })
  .strict();

export const MovementEdgeV1Schema = z
  .object({
    sceneId: SceneIdSchema,
    edgeId: SceneEntityIdSchema,
    fromNodeId: SceneEntityIdSchema,
    toNodeId: SceneEntityIdSchema,
    cellIds: z.array(CellIdSchema).min(1),
    geometryType: z.literal("line_string"),
    geometryWkbHex: z.string().regex(/^(?:[a-f0-9]{2})+$/u),
    edgeKind: EdgeKindSchema,
    crossesRoad: z.boolean(),
    allowedModes: z.array(MovementModeSchema).min(1),
    roadClass: z.enum(["motorway", "trunk", "primary", "secondary", "tertiary", "residential", "service", "path", "rail", "other"]),
    direction: z.enum(["bidirectional", "forward", "reverse"]),
    lengthMeters: z.number().positive(),
    visualSpeedMetersPerSecond: VisualSpeedSchema,
    fieldSources: z
      .object({
        geometry: GeometryFieldSourceSchema,
        visualSpeed: z.object({ sourceId: SceneSourceIdSchema, provenance: z.literal("visual_synthesis"), derivationVersion: SceneVersionSchema }).strict(),
      })
      .strict(),
    sourceId: SceneSourceIdSchema,
    provenance: z.enum(["external_cartography", "derived_cartography"]),
    scientificClaim: z.literal(false),
  })
  .strict()
  .superRefine((edge, context) => {
    if (edge.fromNodeId === edge.toNodeId) {
      context.addIssue({ code: "custom", message: "movement edge cannot be a self-loop" });
    }
    if (new Set(edge.cellIds).size !== edge.cellIds.length || new Set(edge.allowedModes).size !== edge.allowedModes.length) {
      context.addIssue({ code: "custom", message: "edge cells and modes must be unique" });
    }
    if (edge.edgeKind === "lane" ? edge.allowedModes.includes("pedestrian") : edge.allowedModes.length !== 1 || edge.allowedModes[0] !== "pedestrian") {
      context.addIssue({ code: "custom", message: "edgeKind and allowedModes are incompatible" });
    }
    if (edge.crossesRoad !== (edge.edgeKind === "crosswalk")) context.addIssue({ code: "custom", message: "crossesRoad is true exactly for crosswalk edges" });
    for (const mode of ["pedestrian", "bicycle", "car", "transit"] as const) {
      if (edge.allowedModes.includes(mode) !== (edge.visualSpeedMetersPerSecond[mode] !== null)) {
        context.addIssue({ code: "custom", message: "visual speeds must exist exactly for allowed modes" });
      }
    }
  });

export const MovementRouteV1Schema = z.object({
  routeId: z.string().regex(/^route_[a-f0-9]{16,64}$/u),
  mode: MovementModeSchema,
  traversal: z.enum(["loop", "ping_pong", "once"]),
  edgeIds: z.array(SceneEntityIdSchema).min(1),
  fieldSources: z.object({ sourceIds: z.array(SceneSourceIdSchema).min(1), provenance: z.literal("visual_synthesis"), derivationVersion: SceneVersionSchema }).strict(),
}).strict();

export const MovementGraphV1Schema = z
  .object({
    sceneId: SceneIdSchema,
    graphVersion: SceneVersionSchema,
    nodes: z.object({ path: z.literal("network_nodes.parquet"), sha256: Sha256Schema }).strict(),
    edges: z.object({ path: z.literal("network_edges.parquet"), sha256: Sha256Schema }).strict(),
    nodeCount: z.number().int().nonnegative(),
    edgeCount: z.number().int().nonnegative(),
    allowedModes: z.array(MovementModeSchema).min(1),
    edgeKinds: z.array(EdgeKindSchema).min(1),
    routeIdPolicy: z.literal("authored_stable_scene_route_v1"),
    routeCount: z.number().int().positive(),
    routePartitioning: z.literal("cell_payload_route_complete_v1"),
    fieldSources: z
      .object({
        geometry: z.object({ sourceIds: z.array(SceneSourceIdSchema).min(1), provenance: z.enum(["external_cartography", "derived_cartography"]) }).strict(),
        visualSpeed: z.object({ sourceIds: z.array(SceneSourceIdSchema).min(1), provenance: z.literal("visual_synthesis"), derivationVersion: SceneVersionSchema }).strict(),
      })
      .strict(),
    sourceIds: z.array(SceneSourceIdSchema).min(1),
    provenance: z.enum(["external_cartography", "derived_cartography"]),
    scientificClaim: z.literal(false),
  })
  .strict()
  .superRefine((graph, context) => {
    for (const values of [graph.allowedModes, graph.edgeKinds, graph.sourceIds, graph.fieldSources.geometry.sourceIds, graph.fieldSources.visualSpeed.sourceIds]) {
      if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "graph inventory values must be unique" });
    }
  });

export const SceneAnchorV1Schema = z
  .object({
    sceneId: SceneIdSchema,
    anchorId: SceneEntityIdSchema,
    geographyId: z.string().min(1),
    cellId: CellIdSchema,
    category: z.enum(["home", "work", "study", "leisure", "transit"]),
    position: ScenePositionSchema,
    positionOrigin: z.enum(["public_cartography", "cell_centroid", "deterministic_cell_synthesis"]),
    capacityProxy: z.number().int().nonnegative().nullable(),
    sourceId: SceneSourceIdSchema,
    provenance: z.enum(["external_cartography", "derived_cartography", "visual_synthesis"]),
    scientificClaim: z.literal(false),
  })
  .strict();

const EnvironmentConditionSchema = z.enum(["clear", "cloudy", "rain", "snow", "fog"]);
const EnvironmentModeSchema = z.enum(["visual_preset", "reanalysis_external"]);
const EnvironmentProvenanceSchema = z.enum(["reanalysis_environment", "visual_synthesis"]);
const EnvironmentValuesSchema = {
  temperatureC: z.number().min(-100).max(70).nullable(),
  windMps: z.number().min(0).max(150).nullable(),
  windDirectionDegrees: z.number().min(0).lt(360).nullable(),
  precipitationMmPerHour: z.number().min(0).max(500).nullable(),
  cloudCover: z.number().min(0).max(1).nullable(),
} as const;
const EnvironmentSourceReferencesSchema = z.array(
  z.object({ sourceTimeIso: IsoDateTimeSchema, weight: z.number().positive().max(1) }).strict(),
).max(2);

const EnvironmentFieldSourcesSchema = z
  .object({
    meteorology: z.object({ sourceId: SceneSourceIdSchema, provenance: z.enum(["reanalysis_environment", "visual_synthesis"]) }).strict(),
    wind: z.object({ sourceId: SceneSourceIdSchema, provenance: z.enum(["reanalysis_environment", "visual_synthesis"]), derivationVersion: SceneVersionSchema.nullable(), formula: z.string().min(1).nullable() }).strict(),
    condition: z.object({ sourceId: SceneSourceIdSchema, provenance: z.literal("visual_synthesis"), derivationVersion: SceneVersionSchema, formula: z.string().min(1) }).strict(),
  })
  .strict()
  .superRefine((sources, context) => {
    if ((sources.wind.derivationVersion === null) !== (sources.wind.formula === null)) context.addIssue({ code: "custom", message: "wind derivation version and formula are nullable together" });
  });

export const EnvironmentCycleV1Schema = z
  .object({
    sceneId: SceneIdSchema,
    cycleId: SceneIdSchema,
    geographyId: z.string().min(1),
    timeZone: IanaTimeZoneSchema,
    mode: EnvironmentModeSchema,
    period: z.enum(["daily", "annual_non_leap"]),
    referenceYear: z.union([z.literal(2025), z.null()]),
    sourceTimeZone: z.union([z.literal("UTC"), z.null()]),
    timestepMinutes: z.number().int().min(1).max(1440),
    leapDayPolicy: z.enum(["not_applicable", "interpolate_feb_28_mar_1"]),
    sourceId: SceneSourceIdSchema,
    content: z.object({ path: z.string().regex(/^content\/environment\/[a-z0-9][a-z0-9_-]{0,127}\.json$/u), sha256: Sha256Schema, bytes: z.number().int().positive(), recordCount: z.number().int().min(1).max(8760) }).strict(),
    fieldSources: EnvironmentFieldSourcesSchema,
    provenance: EnvironmentProvenanceSchema,
    scientificClaim: z.literal(false),
  })
  .strict()
  .superRefine((cycle, context) => {
    const expectedProvenance = cycle.mode === "visual_preset" ? "visual_synthesis" : "reanalysis_environment";
    if (cycle.provenance !== expectedProvenance) context.addIssue({ code: "custom", message: "environment mode/provenance mismatch" });
    const annual = cycle.mode !== "visual_preset";
    if (
      annual !== (cycle.period === "annual_non_leap") ||
      (annual ? cycle.referenceYear !== 2025 || cycle.sourceTimeZone !== "UTC" || cycle.timestepMinutes !== 60 || cycle.leapDayPolicy !== "interpolate_feb_28_mar_1" || cycle.content.recordCount !== 8760 : cycle.referenceYear !== null || cycle.sourceTimeZone !== null || cycle.leapDayPolicy !== "not_applicable")
    ) {
      context.addIssue({ code: "custom", message: "environment cycle calendar metadata does not match its mode" });
    }
  });

export const EnvironmentCyclePayloadV1Schema = z
  .object({
    sceneId: SceneIdSchema,
    cycleId: SceneIdSchema,
    steps: z.array(z.object({ startMinute: z.number().int().min(0).max(525599), durationMinutes: z.number().int().min(1).max(525600), condition: EnvironmentConditionSchema, ...EnvironmentValuesSchema }).strict()).min(1).max(8760),
  })
  .strict()
  .superRefine((payload, context) => {
    let cursor = 0;
    for (const step of payload.steps) {
      if (step.startMinute !== cursor) context.addIssue({ code: "custom", message: "environment payload steps must be contiguous" });
      cursor += step.durationMinutes;
    }
    if (![1440, 525600].includes(cursor)) context.addIssue({ code: "custom", message: "environment payload must cover a daily or non-leap annual period" });
  });

export const EnvironmentStateV1Schema = z
  .object({
    environmentId: SceneEntityIdSchema,
    geographyId: z.string().min(1),
    condition: EnvironmentConditionSchema,
    mode: EnvironmentModeSchema,
    validFrom: IsoDateTimeSchema,
    validTo: IsoDateTimeSchema,
    sourceTime: IsoDateTimeSchema.nullable(),
    sourceReferences: EnvironmentSourceReferencesSchema,
    sourceId: SceneSourceIdSchema,
    ...EnvironmentValuesSchema,
    fieldSources: EnvironmentFieldSourcesSchema,
    provenance: EnvironmentProvenanceSchema,
    scientificClaim: z.literal(false),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.validFrom >= state.validTo) context.addIssue({ code: "custom", message: "environment validity must be ordered" });
    const expectedProvenance = state.mode === "visual_preset" ? "visual_synthesis" : "reanalysis_environment";
    if (state.provenance !== expectedProvenance) context.addIssue({ code: "custom", message: "environment mode/provenance mismatch" });
    const references = state.sourceReferences;
    if (state.mode === "visual_preset") {
      if (state.sourceTime !== null || references.length !== 0) context.addIssue({ code: "custom", message: "visual preset cannot claim source references" });
    } else {
      if (![1, 2].includes(references.length) || Math.abs(references.reduce((sum, item) => sum + item.weight, 0) - 1) > 1e-12 || new Set(references.map((item) => item.sourceTimeIso)).size !== references.length) context.addIssue({ code: "custom", message: "external environment requires one or two unique weighted source references" });
      if ((references.length === 1) !== (state.sourceTime === references[0]?.sourceTimeIso)) context.addIssue({ code: "custom", message: "sourceTime identifies the sole external source reference" });
      if (references.length === 2 && state.sourceTime !== null) context.addIssue({ code: "custom", message: "interpolated external environment cannot claim one sourceTime" });
    }
  });

export const RendererQualityProfileV1Schema = z
  .object({
    profileId: z.enum(["low", "balanced", "high", "custom"]),
    pedestrianLimit: z.number().int().min(0).max(100000),
    vehicleLimit: z.number().int().min(0).max(20000),
    maxPixelRatio: z.number().min(0.5).max(3),
    shadowQuality: z.enum(["off", "low", "high"]),
    atmosphere: z.boolean(),
    lodTransitionMs: z.number().int().min(0).max(5000),
    reducedMotion: z.boolean(),
    workerCount: z.number().int().min(1).max(2),
  })
  .strict()
  .superRefine((profile, context) => {
    if (profile.reducedMotion && profile.lodTransitionMs !== 0) context.addIssue({ code: "custom", message: "reduced motion requires zero LOD transition" });
  });

const VisualPositionV2Schema = z
  .object({
    sceneId: SceneIdSchema,
    longitude: z.number().min(-180).max(180),
    latitude: z.number().min(-90).max(90),
    cellId: z.string().regex(/^z(?:[0-9]|1[0-6])\/[0-9]{1,5}\/[0-9]{1,5}$/u),
    origin: z.enum(["public_scene_anchor", "scene_cell_centroid", "privacy_grid_centroid", "deterministic_cell_synthesis", "network_interpolation"]),
    semantics: z.literal("synthetic_presentation_cell"),
    geometrySemantics: z.enum(["privacy_grid_centroid", "deterministic_cell_point", "authored_network_point"]),
    spatialResolutionM: z.number().min(250).nullable(),
    rawSourceCoordinateUsed: z.literal(false),
  })
  .strict();

const VisualMotionV2Schema = z
  .object({
    mode: z.enum(["stationary", "network_edge", "cell_interpolation"]),
    routeId: z.string().regex(/^route_[a-f0-9]{16,64}$/u).nullable(),
    edgeId: SceneEntityIdSchema.nullable(),
    progress: z.number().min(0).max(1).nullable(),
    direction: z.enum(["forward", "reverse"]).nullable(),
    speedMps: z.number().min(0).max(100),
  })
  .strict()
  .superRefine((motion, context) => {
    const onNetwork = motion.mode === "network_edge";
    if (onNetwork && (motion.routeId === null || motion.edgeId === null || motion.progress === null || motion.direction === null)) {
      context.addIssue({ code: "custom", message: "network motion requires authored route, edge, progress, and direction only" });
    }
    if (!onNetwork && (motion.routeId !== null || motion.edgeId !== null || motion.progress !== null || motion.direction !== null)) {
      context.addIssue({ code: "custom", message: "off-network motion cannot carry route phase fields" });
    }
    if (motion.mode === "stationary" && motion.speedMps !== 0) context.addIssue({ code: "custom", message: "stationary motion has zero speed" });
  });

export const VisualEntityV2Schema = z
  .object({
    id: SceneEntityIdSchema,
    entityKind: z.enum(["person", "vehicle", "bicycle", "transit_vehicle"]),
    representation: z.enum(["focus_person_1to1", "aggregate_proxy", "ambient_only"]),
    representedCount: z.number().int().nonnegative(),
    sourceGeographyId: z.string().min(1),
    activity: z.enum(["home", "work", "study", "travel", "leisure", "ambient"]),
    activityScheduleProfile: z.number().int().min(0).max(11).nullable(),
    position: VisualPositionV2Schema,
    motion: VisualMotionV2Schema,
    heading: z.number().min(0).lt(360),
    presentationTime: IsoDateTimeSchema,
    visualSynthesisVersion: SceneVersionSchema,
    scientificClaim: z.literal(false),
  })
  .strict()
  .superRefine((entity, context) => {
    if (entity.representation === "focus_person_1to1" && (entity.entityKind !== "person" || entity.representedCount !== 1)) context.addIssue({ code: "custom", message: "focus entity must represent one person" });
    if (entity.representation === "focus_person_1to1" && (entity.position.origin !== "privacy_grid_centroid" || entity.position.geometrySemantics !== "privacy_grid_centroid" || entity.position.spatialResolutionM === null)) context.addIssue({ code: "custom", message: "focus entity requires a real >=250m privacy grid position" });
    if (entity.representation === "aggregate_proxy" && (entity.entityKind !== "person" || entity.representedCount < 1)) context.addIssue({ code: "custom", message: "aggregate proxy must represent people" });
    if (entity.representation === "ambient_only" && entity.representedCount !== 0) context.addIssue({ code: "custom", message: "ambient entities cannot represent scientific population" });
    if (entity.representation !== "focus_person_1to1" && entity.position.spatialResolutionM !== null) context.addIssue({ code: "custom", message: "nonfocus presentation geometry cannot claim focus disclosure resolution" });
    if (entity.entityKind === "person" && entity.motion.mode !== "network_edge" && entity.activityScheduleProfile === null) context.addIssue({ code: "custom", message: "stationary people require a deterministic visual activity schedule profile" });
    if (entity.motion.mode === "network_edge" && (entity.activity !== "travel" || entity.activityScheduleProfile !== null)) context.addIssue({ code: "custom", message: "route-locked entities are travel with no hourly schedule profile" });
    if (entity.entityKind !== "person" && entity.activityScheduleProfile !== null) context.addIssue({ code: "custom", message: "ambient transport cannot claim a person activity schedule profile" });
    if (entity.entityKind !== "person" && (entity.representation !== "ambient_only" || !["travel", "ambient"].includes(entity.activity))) context.addIssue({ code: "custom", message: "vehicles are ambient travel entities" });
  });

const SceneContentAssetV1Schema = z
  .object({
    path: ContentPathSchema,
    sha256: Sha256Schema,
    bytes: z.number().int().nonnegative(),
    url: z.string().regex(/^\/scenes\/[a-z0-9][a-z0-9_-]{0,127}\/[a-f0-9]{64}\/content\/[A-Za-z0-9._/-]+$/u),
  })
  .strict();

export const SceneCellIndexV1Schema = z
  .object({
    sceneId: SceneIdSchema,
    derivationVersion: SceneVersionSchema,
    items: z.array(z.object({ cellId: CellIdSchema, path: z.string().regex(/^content\/cells\/z16\/[0-9]{1,5}\/[0-9]{1,5}\.json$/u), sha256: Sha256Schema, bytes: z.number().int().positive(), url: z.string().regex(/^\/scenes\/[a-z0-9][a-z0-9_-]{0,127}\/[a-f0-9]{64}\/content\/cells\/z16\/[0-9]{1,5}\/[0-9]{1,5}\.json$/u) }).strict()).min(1),
    count: z.number().int().positive(),
  })
  .strict()
  .superRefine((index, context) => {
    if (index.count !== index.items.length || new Set(index.items.map((item) => item.cellId)).size !== index.items.length || new Set(index.items.map((item) => item.path)).size !== index.items.length) context.addIssue({ code: "custom", message: "cell index count and identities must be exact" });
    for (const item of index.items) {
      if (item.path !== `content/cells/${item.cellId}.json` || item.url !== `/scenes/${index.sceneId}/${item.sha256}/${item.path}`) context.addIssue({ code: "custom", message: "cell index path/url must be content-addressed" });
    }
  });

export const SceneCellPayloadV1Schema = z
  .object({
    sceneId: SceneIdSchema,
    cellId: CellIdSchema,
    derivationVersion: SceneVersionSchema,
    descriptor: SceneCellDescriptorV1Schema,
    features: z.array(SceneStaticFeatureV1Schema),
    nodes: z.array(MovementNodeV1Schema),
    edges: z.array(MovementEdgeV1Schema),
    routes: z.array(MovementRouteV1Schema),
    anchors: z.array(SceneAnchorV1Schema),
    contentAssets: z.array(SceneContentAssetV1Schema).max(1),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.descriptor.sceneId !== payload.sceneId || payload.descriptor.cellId !== payload.cellId) {
      context.addIssue({ code: "custom", message: "cell descriptor must match payload scene and cell" });
    }
    if (payload.features.some((feature) => feature.sceneId !== payload.sceneId || !feature.cellIds.includes(payload.cellId))) {
      context.addIssue({ code: "custom", message: "features must be filtered to the payload scene and cell" });
    }
    const edgeEndpointIds = new Set(payload.edges.flatMap((edge) => [edge.fromNodeId, edge.toNodeId]));
    if (payload.nodes.some((node) => node.sceneId !== payload.sceneId || (node.cellId !== payload.cellId && !edgeEndpointIds.has(node.nodeId)))) {
      context.addIssue({ code: "custom", message: "nodes must belong to the payload cell or be an included edge endpoint" });
    }
    if (payload.edges.some((edge) => edge.sceneId !== payload.sceneId)) {
      context.addIssue({ code: "custom", message: "edges must belong to the payload scene" });
    }
    if (payload.anchors.some((anchor) => anchor.sceneId !== payload.sceneId || anchor.cellId !== payload.cellId)) {
      context.addIssue({ code: "custom", message: "anchors must be filtered to the payload scene and cell" });
    }
    for (const values of [
      payload.features.map((item) => item.featureId),
      payload.nodes.map((item) => item.nodeId),
      payload.edges.map((item) => item.edgeId),
      payload.routes.map((item) => item.routeId),
      payload.anchors.map((item) => item.anchorId),
    ]) {
      if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "cell payload row IDs must be unique" });
    }
    const nodeIds = new Set(payload.nodes.map((node) => node.nodeId));
    if (payload.edges.some((edge) => !nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId))) {
      context.addIssue({ code: "custom", message: "cell payload must include every edge endpoint node" });
    }
    const edgeIds = new Set(payload.edges.map((edge) => edge.edgeId));
    if (payload.routes.some((route) => route.edgeIds.some((edgeId) => !edgeIds.has(edgeId)))) {
      context.addIssue({ code: "custom", message: "cell payload routes must be complete within included edges" });
    }
    const content = payload.descriptor.content;
    if (content === null ? payload.contentAssets.length !== 0 : payload.contentAssets.length !== 1 || payload.contentAssets[0]?.path !== content.path || payload.contentAssets[0]?.sha256 !== content.sha256) {
      context.addIssue({ code: "custom", message: "content assets must exactly match the cell descriptor" });
    }
    if (payload.contentAssets.some((asset) => asset.url !== `/scenes/${payload.sceneId}/${asset.sha256}/${asset.path}`)) {
      context.addIssue({ code: "custom", message: "content asset URL must be immutable and content-addressed" });
    }
  });

const RunEligibilityItemV1Schema = z
  .object({
    runId: SafeRunIdSchema,
    activation: z.enum(["eligible", "inspection_only"]),
    qaStatus: z.enum(["pass", "fail", "not_evaluated", "stale"]),
    bundleFingerprint: Sha256Schema,
    attestationSha256: Sha256Schema.nullable(),
    evaluatedAt: IsoDateTimeSchema.nullable(),
    detail: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((item, context) => {
    const passed = item.qaStatus === "pass";
    if (passed !== (item.activation === "eligible")) context.addIssue({ code: "custom", message: "only passed runs are eligible" });
    if (passed) {
      if (item.attestationSha256 === null || item.evaluatedAt === null || item.detail !== null) context.addIssue({ code: "custom", message: "passed eligibility requires an attestation and no detail" });
    } else if (item.attestationSha256 !== null || item.evaluatedAt !== null || item.detail === null) {
      context.addIssue({ code: "custom", message: "non-passed eligibility is inspection-only without an attestation" });
    }
  });

export const RunEligibilityCatalogV1Schema = z
  .object({
    items: z.array(RunEligibilityItemV1Schema),
    count: z.number().int().nonnegative(),
    activeRunId: SafeRunIdSchema.nullable(),
  })
  .strict()
  .superRefine((catalog, context) => {
    const ids = catalog.items.map((item) => item.runId);
    if (catalog.count !== catalog.items.length || new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "eligibility count and runIds must match items" });
    if (catalog.activeRunId !== null && !catalog.items.some((item) => item.runId === catalog.activeRunId && item.activation === "eligible")) context.addIssue({ code: "custom", message: "active run must reference an eligible item" });
  });

const LayerAvailabilityStatusSchema = z.enum(["available", "unavailable", "offline_fallback"]);
const CatalogLayerSchema = z
  .object({
    layerId: z.enum(CanonicalSceneLayerIds),
    path: z.enum(CanonicalScenePaths),
    status: LayerAvailabilityStatusSchema,
    classification: SceneProvenanceSchema,
    sourceIds: z.array(SceneSourceIdSchema).min(1),
    sha256: Sha256Schema,
    reason: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((layer, context) => {
    if (CanonicalLayerPath[layer.layerId] !== layer.path) context.addIssue({ code: "custom", message: "catalog layer path is not canonical" });
    if ((layer.status === "available") !== (layer.reason === null)) context.addIssue({ code: "custom", message: "only available layers have no reason" });
    if (new Set(layer.sourceIds).size !== layer.sourceIds.length) context.addIssue({ code: "custom", message: "layer sources must be unique" });
  });

const CatalogSourceSchema = z
  .object({
    sourceId: SceneSourceIdSchema,
    sourceType: z.enum(["cartography", "landcover", "transport_network", "points_of_interest", "environment", "visual_synthesis"]),
    adapter: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,127}$/u),
    provenance: SceneProvenanceSchema,
    snapshotAt: IsoDateTimeSchema,
    inputSha256: Sha256Schema,
    license: z.object({ name: z.string().min(1), url: z.string().url().nullable(), attribution: z.string().min(1) }).strict(),
    cartographyMetadata: CartographyMetadataSchema.nullable(),
    environmentMetadata: EnvironmentMetadataSchema.nullable(),
  })
  .strict();

const SceneCatalogItemV1Schema = z
  .object({
    sceneId: SceneIdSchema,
    sceneVersion: SceneVersionSchema,
    manifestSha256: Sha256Schema,
    manifestUrl: z.string().regex(/^\/scenes\/[a-z0-9][a-z0-9_-]{0,127}\/[a-f0-9]{64}\/scene\.json$/u),
    cellIndexSha256: Sha256Schema,
    cellIndexUrl: z.string().regex(/^\/scenes\/[a-z0-9][a-z0-9_-]{0,127}\/[a-f0-9]{64}\/content\/cells\/index\.json$/u),
    geographyVintage: z.string().min(1),
    timeZone: IanaTimeZoneSchema,
    compatibility: z.enum(["compatible", "incompatible"]),
    compatibilityReasons: z.array(z.enum(["geography_vintage_mismatch", "geography_spatial_mismatch", "coverage_miss", "layer_unavailable"])),
    coverage: SceneCoverageSchema,
    capabilities: SceneCapabilitiesSchema,
    layers: z.array(CatalogLayerSchema),
    sources: z.array(CatalogSourceSchema),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.manifestUrl !== `/scenes/${item.sceneId}/${item.manifestSha256}/scene.json`) context.addIssue({ code: "custom", message: "manifestUrl must be the immutable manifest path" });
    if (item.cellIndexUrl !== `/scenes/${item.sceneId}/${item.cellIndexSha256}/content/cells/index.json`) context.addIssue({ code: "custom", message: "cellIndexUrl must be content-addressed" });
    if (new Set(item.compatibilityReasons).size !== item.compatibilityReasons.length) context.addIssue({ code: "custom", message: "compatibility reasons must be unique" });
    if ((item.compatibility === "compatible") !== (item.compatibilityReasons.length === 0)) context.addIssue({ code: "custom", message: "compatible scene has no incompatibility reasons" });
    if (new Set(item.layers.map((layer) => layer.layerId)).size !== item.layers.length) context.addIssue({ code: "custom", message: "catalog layerIds must be unique" });
    if (new Set(item.sources.map((source) => source.sourceId)).size !== item.sources.length) context.addIssue({ code: "custom", message: "catalog sourceIds must be unique" });
  });

const SceneBindingReasonSchema = z.enum(["scene_not_found", "geography_vintage_mismatch", "geography_spatial_mismatch", "coverage_miss", "multiple_compatible_scenes", "scene_not_selected", "layer_unavailable", "offline_fallback"]);
export const SceneCatalogResponseV1Schema = z
  .object({
    runId: SafeRunIdSchema,
    geographyId: z.string().min(1),
    geographyVintage: z.string().min(1),
    timeZone: IanaTimeZoneSchema.nullable(),
    binding: z
      .object({
        status: z.enum(["compatible", "not_found", "ambiguous", "incompatible"]),
        selectedSceneId: SceneIdSchema.nullable(),
        reasonCodes: z.array(SceneBindingReasonSchema),
      })
      .strict(),
    items: z.array(SceneCatalogItemV1Schema),
    count: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((catalog, context) => {
    const ids = catalog.items.map((item) => item.sceneId);
    if (catalog.count !== catalog.items.length || new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "scene catalog count and ids must match items" });
    if (new Set(catalog.binding.reasonCodes).size !== catalog.binding.reasonCodes.length) context.addIssue({ code: "custom", message: "binding reasons must be unique" });
    const compatible = catalog.items.filter((item) => item.compatibility === "compatible");
    if (catalog.binding.status === "compatible") {
      const selected = compatible.find((item) => item.sceneId === catalog.binding.selectedSceneId);
      if (compatible.length !== 1 || selected === undefined || catalog.timeZone !== selected.timeZone || catalog.binding.reasonCodes.length !== 0) context.addIssue({ code: "custom", message: "compatible binding must select exactly one scene and its IANA time zone" });
    } else {
      if (catalog.binding.selectedSceneId !== null || catalog.timeZone !== null || catalog.binding.reasonCodes.length === 0) context.addIssue({ code: "custom", message: "non-compatible binding must fail closed with reasons" });
      if (catalog.binding.status === "ambiguous" && compatible.length < 2) context.addIssue({ code: "custom", message: "ambiguous binding requires multiple compatible scenes" });
    }
  });

const ViewportModelStateV2Schema = z
  .object({
    classification: z.literal("model_state"),
    status: z.enum(["available", "not_available"]),
    runMode: RunModeSchema,
    scientificClaim: z.boolean(),
    stockAsOf: IsoDateSchema.nullable(),
    populationStock: z.number().int().nonnegative().nullable(),
    provenance: z.array(ScientificProvenanceSchema),
    coverage: z.number().min(0).max(1),
    uncertainty: UncertaintySchema,
  })
  .strict()
  .superRefine((state, context) => {
    const available = state.status === "available";
    if (available !== (state.stockAsOf !== null && state.populationStock !== null && state.provenance.length > 0)) context.addIssue({ code: "custom", message: "model-state availability must match nullable values and provenance summary" });
    if (new Set(state.provenance).size !== state.provenance.length) context.addIssue({ code: "custom", message: "model-state provenance classes must be unique" });
    if (!available && (state.coverage !== 0 || state.uncertainty.lower !== null || state.uncertainty.upper !== null)) context.addIssue({ code: "custom", message: "unavailable model state preserves null and zero coverage" });
  });

export const ENVIRONMENT_TEMPORAL_INTERPOLATION_DERIVATION_VERSION = "1.0.0" as const;
export const ENVIRONMENT_TEMPORAL_INTERPOLATION_FORMULA = "scalars=weighted_mean;precipitation_null=0;condition=max(weight,severity[snow>rain>fog>cloudy>clear],-step_index);wind_from=atan2(sum(weight*speed*sin(from)),sum(weight*speed*cos(from)));wind_speed=hypot(sum(weight*speed*sin(from)),sum(weight*speed*cos(from)))" as const;

const ViewportEnvironmentV2Schema = z
  .object({
    classification: z.enum(["visual_synthesis", "reanalysis_environment"]),
    scientificClaim: z.literal(false),
    environmentId: SceneEntityIdSchema,
    geographyId: z.string().min(1),
    condition: EnvironmentConditionSchema,
    mode: EnvironmentModeSchema,
    validFrom: IsoDateTimeSchema,
    validTo: IsoDateTimeSchema,
    sourceTime: IsoDateTimeSchema.nullable(),
    sourceReferences: EnvironmentSourceReferencesSchema,
    sourceId: SceneSourceIdSchema,
    ...EnvironmentValuesSchema,
    fieldSources: EnvironmentFieldSourcesSchema,
    temporalMapping: z
      .object({
        classification: z.literal("visual_synthesis"),
        policy: z.enum(["identity", "daily_cycle", "annual_2025_non_leap_replay"]),
        presentationTime: IsoDateTimeSchema,
        referenceYear: z.union([z.literal(2025), z.null()]),
        leapDayPolicy: z.enum(["not_applicable", "interpolate_feb_28_mar_1"]),
        derivationVersion: z.union([z.literal(ENVIRONMENT_TEMPORAL_INTERPOLATION_DERIVATION_VERSION), z.null()]),
        formula: z.union([z.literal(ENVIRONMENT_TEMPORAL_INTERPOLATION_FORMULA), z.null()]),
      })
      .strict(),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.validFrom >= state.validTo) context.addIssue({ code: "custom", message: "environment validity must be ordered" });
    const expected = state.mode === "visual_preset" ? "visual_synthesis" : "reanalysis_environment";
    if (state.classification !== expected || (state.mode === "visual_preset" && state.sourceTime !== null)) context.addIssue({ code: "custom", message: "environment classification/sourceTime mismatch" });
    const replay = state.temporalMapping.policy === "annual_2025_non_leap_replay";
    if (replay !== (state.temporalMapping.referenceYear === 2025 && state.temporalMapping.leapDayPolicy === "interpolate_feb_28_mar_1")) context.addIssue({ code: "custom", message: "environment replay mapping metadata mismatch" });
    if (replay !== (state.temporalMapping.derivationVersion === ENVIRONMENT_TEMPORAL_INTERPOLATION_DERIVATION_VERSION && state.temporalMapping.formula === ENVIRONMENT_TEMPORAL_INTERPOLATION_FORMULA)) context.addIssue({ code: "custom", message: "environment replay derivation metadata mismatch" });
    const references = state.sourceReferences;
    if (replay) {
      if (![1, 2].includes(references.length) || Math.abs(references.reduce((sum, item) => sum + item.weight, 0) - 1) > 1e-12 || new Set(references.map((item) => item.sourceTimeIso)).size !== references.length) context.addIssue({ code: "custom", message: "annual replay requires one or two unique source references with weights summing to one" });
      if ((references.length === 1) !== (state.sourceTime === references[0]?.sourceTimeIso)) context.addIssue({ code: "custom", message: "sourceTime is present only for a single annual source reference" });
      if (references.length === 2 && state.sourceTime !== null) context.addIssue({ code: "custom", message: "interpolated annual state cannot claim one sourceTime" });
    } else {
      if (state.temporalMapping.referenceYear !== null || state.temporalMapping.leapDayPolicy !== "not_applicable" || state.temporalMapping.derivationVersion !== null || state.temporalMapping.formula !== null) context.addIssue({ code: "custom", message: "non-replay environment cannot claim a reference calendar or interpolation derivation" });
      if (state.mode === "visual_preset" && (state.sourceTime !== null || references.length !== 0)) context.addIssue({ code: "custom", message: "visual preset cannot claim source references" });
      if (state.mode !== "visual_preset" && (references.length !== 1 || references[0]?.weight !== 1 || state.sourceTime !== references[0]?.sourceTimeIso)) context.addIssue({ code: "custom", message: "direct external environment requires one source reference" });
    }
  });

const SourceLayerStatusV2Schema = z
  .object({
    layerId: z.enum(["model_state", ...CanonicalSceneLayerIds]),
    status: LayerAvailabilityStatusSchema,
    classification: z.enum(["model_state", "external_cartography", "reanalysis_environment", "derived_cartography", "visual_synthesis"]),
    sourceIds: z.array(z.string().min(1)),
    reason: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((layer, context) => {
    if (new Set(layer.sourceIds).size !== layer.sourceIds.length) context.addIssue({ code: "custom", message: "source layer IDs must be unique" });
    if ((layer.status === "available") !== (layer.reason === null)) context.addIssue({ code: "custom", message: "only available source layers have no reason" });
  });

export const WorldViewportResponseV2Schema = z
  .object({
    contractVersion: z.literal("2"),
    runId: SafeRunIdSchema,
    runActivation: z.enum(["eligible", "inspection_only"]),
    sceneId: SceneIdSchema,
    geographyId: z.string().min(1),
    geographyVintage: z.string().min(1),
    clocks: ClockStateV1Schema,
    modelState: ViewportModelStateV2Schema,
    visualSynthesis: z
      .object({
        classification: z.literal("visual_synthesis"),
        scientificClaim: z.literal(false),
        version: SceneVersionSchema,
        seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        coordinateSemantics: z.literal("webmercator_privacy_grid_min_250m"),
        rawAddressCoordinatesAvailable: z.literal(false),
        activityScheduling: z.object({
          classification: z.literal("visual_synthesis"),
          scientificClaim: z.literal(false),
          policy: z.literal("scene_local_hourly_profile_v1"),
          timeZone: z.string().min(1),
          derivationVersion: z.literal("1.0.0"),
          formula: z.literal("network_edge=>activity=travel,profile=null;otherwise profile=stable_seed(run_id,scene_id,entity_id,'activity-schedule')%12;activity=hourly_profile[profile][scene_local_hour]"),
        }).strict(),
        rendererQuality: RendererQualityProfileV1Schema,
        viewportAllocatedPopulation: z.number().int().nonnegative(),
        representedPopulation: z.number().int().nonnegative(),
        unrepresentedPopulation: z.number().int().nonnegative(),
        representationCoverage: z.number().min(0).max(1),
        renderedPopulationEntities: z.number().int().nonnegative(),
        ambientEntities: z.number().int().nonnegative(),
        entities: z.array(VisualEntityV2Schema),
      })
      .strict(),
    environment: ViewportEnvironmentV2Schema,
    sourceLayerStatus: z.array(SourceLayerStatusV2Schema),
  })
  .strict()
  .superRefine((viewport, context) => {
    const entities = viewport.visualSynthesis.entities;
    const populationEntities = entities.filter((entity) => entity.representation !== "ambient_only");
    const ambientEntities = entities.filter((entity) => entity.representation === "ambient_only");
    if (populationEntities.length !== viewport.visualSynthesis.renderedPopulationEntities || ambientEntities.length !== viewport.visualSynthesis.ambientEntities) context.addIssue({ code: "custom", message: "viewport entity counts must match entities" });
    if (populationEntities.reduce((sum, entity) => sum + entity.representedCount, 0) !== viewport.visualSynthesis.representedPopulation) context.addIssue({ code: "custom", message: "visual population representations must conserve viewport allocation" });
    const synthesis = viewport.visualSynthesis;
    const expectedCoverage = synthesis.viewportAllocatedPopulation === 0 ? 1 : synthesis.representedPopulation / synthesis.viewportAllocatedPopulation;
    if (synthesis.representedPopulation + synthesis.unrepresentedPopulation !== synthesis.viewportAllocatedPopulation || Math.abs(synthesis.representationCoverage - expectedCoverage) > 1e-12) context.addIssue({ code: "custom", message: "visual representation coverage must expose all unrepresented viewport allocation" });
    if (entities.some((entity) => entity.presentationTime !== viewport.clocks.presentationTime || entity.visualSynthesisVersion !== viewport.visualSynthesis.version)) context.addIssue({ code: "custom", message: "entities must use viewport presentation time and synthesis version" });
    if (entities.some((entity) => entity.position.sceneId !== viewport.sceneId)) context.addIssue({ code: "custom", message: "entity positions must bind to the viewport scene" });
    if (viewport.visualSynthesis.seed !== viewport.clocks.visualSynthesisSeed) context.addIssue({ code: "custom", message: "synthesis seed must match clock state" });
    if (viewport.environment.temporalMapping.presentationTime !== viewport.clocks.presentationTime) context.addIssue({ code: "custom", message: "environment mapping must use viewport presentation time" });
    const layerIds = viewport.sourceLayerStatus.map((layer) => layer.layerId);
    if (new Set(layerIds).size !== layerIds.length) context.addIssue({ code: "custom", message: "sourceLayerStatus layerIds must be unique" });
  });

const PresentationOpaqueIdSchema = z.string().regex(/^agt_[a-f0-9]{24,64}$/u);
const PresentationAssignmentIdSchema = z.string().regex(/^spa_[a-f0-9]{24,64}$/u);
const PresentationVehicleIdSchema = z.string().regex(/^veh_[a-f0-9]{24,64}$/u);
const PresentationRouteIdSchema = z.string().regex(/^route_[a-f0-9]{16,64}$/u);
const PresentationCellIdSchema = z.string().regex(/^z16\/[0-9]{1,5}\/[0-9]{1,5}$/u);
const PresentationObjectIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/u);
const PresentationClassificationSchema = z.literal("local_restricted_focus_sample");
const PresentationPrivacySchema = z
  .object({
    identifier: z.literal("run_local_opaque"),
    scope: z.literal("local_only"),
    rawPersonIdAvailable: z.literal(false),
    rawCoordinatesAvailable: z.literal(false),
    personalExportAllowed: z.literal(false),
  })
  .strict();
const PresentationResponsePrivacySchema = PresentationPrivacySchema.extend({ cachePolicy: z.literal("no-store") }).strict();

const RendererMotionPhaseProfileV3Schema = z
  .object({
    buildingMode: z.enum(["aggregate_2_5d", "single_extrusion", "full_budgeted"]),
    actorMode: z.enum(["aggregate", "individual", "budgeted"]),
    contactAo: z.boolean(),
    projectedShadow: z.boolean(),
    facadePattern: z.boolean(),
    roofCap: z.boolean(),
    treeBillboards: z.boolean(),
  })
  .strict();

const RendererSourceTileLodV3Schema = z
  .object({
    buildingsMaxOverscale: z.number().min(1).max(3),
    buildingsTileLodBias: z.number().min(1).max(2),
    basemapMaxOverscale: z.number().min(1).max(3),
    basemapTileLodBias: z.number().min(1).max(2),
  })
  .strict();

export const RendererPerformancePolicyV3Schema = z
  .object({
    contractVersion: z.literal("3"),
    policyId: z.literal("universal_lowpoly_motion_floor_v3"),
    tier: z.enum(["low", "mid", "high"]),
    targetFps: z.number().int().min(30).max(120),
    targetFrameBudgetMs: z.number().min(8.3).max(33.4),
    minimumMovingFps: z.literal(30),
    movingFrameBudgetMs: z.literal(33.333),
    pitchMaxDegrees: z.literal(60),
    workerCount: z.literal(1),
    reducedMotion: z.boolean(),
    scheduler: z
      .object({
        mode: z.literal("invalidation_driven_capped"),
        maxFps: z.number().int().min(30).max(120),
        deckAnimate: z.literal(false),
        continuousRepaint: z.literal(false),
        pausedMode: z.literal("event_driven"),
      })
      .strict(),
    dprLadder: z.array(z.number().min(0.5).max(1)).min(3).max(5),
    lod: z
      .object({
        individualActorsMinZoom: z.literal(15.5),
        livingCellZoom: z.literal(16),
        guardRingCells: z.literal(1),
        moving: RendererSourceTileLodV3Schema,
        settled: RendererSourceTileLodV3Schema,
      })
      .strict(),
    watchdog: z
      .object({
        overBudgetFrameMs: z.literal(33.333),
        emergencyAfterMs: z.literal(500),
        compatibilityAfterMs: z.literal(1500),
        recoveryAfterMs: z.literal(10000),
        minimumStepIntervalMs: z.literal(5000),
        gpuMinimumSamples: z.literal(30),
        gpuSampleDeadlineMs: z.literal(1000),
      })
      .strict(),
    phaseProfiles: z
      .object({
        general_plan: RendererMotionPhaseProfileV3Schema,
        camera_motion: RendererMotionPhaseProfileV3Schema,
        living_motion: RendererMotionPhaseProfileV3Schema,
        settled_paused: RendererMotionPhaseProfileV3Schema,
        emergency_30: RendererMotionPhaseProfileV3Schema,
        compatibility_30: RendererMotionPhaseProfileV3Schema,
      })
      .strict(),
    degradationOrder: z.tuple([
      z.literal("motion_profile"),
      z.literal("dpr"),
      z.literal("individual_actors"),
      z.literal("contact_ao"),
      z.literal("aggregate_buildings"),
      z.literal("compatibility_30"),
    ]),
  })
  .strict()
  .superRefine((policy, context) => {
    const expected = {
      low: { target: [30, 33.333], dpr: [0.75, 0.67, 0.5] },
      mid: { target: [60, 16.667], dpr: [1, 0.85, 0.75, 0.67, 0.5] },
      high: { target: [120, 8.333], dpr: [0.85, 0.75, 0.67, 0.5] },
    }[policy.tier];
    if (
      policy.targetFps !== expected.target[0]
      || policy.targetFrameBudgetMs !== expected.target[1]
      || policy.scheduler.maxFps !== expected.target[0]
      || policy.dprLadder.length !== expected.dpr.length
      || policy.dprLadder.some((value, index) => value !== expected.dpr[index])
    ) {
      context.addIssue({ code: "custom", message: "tier must select its exact target, scheduler cap, and DPR ladder" });
    }
    const moving = policy.lod.moving;
    const settled = policy.lod.settled;
    if (
      moving.buildingsMaxOverscale > settled.buildingsMaxOverscale
      || moving.buildingsTileLodBias > settled.buildingsTileLodBias
      || moving.basemapMaxOverscale > settled.basemapMaxOverscale
      || moving.basemapTileLodBias > settled.basemapTileLodBias
    ) {
      context.addIssue({ code: "custom", message: "moving source tile LOD cannot exceed settled LOD" });
    }
    for (const phaseName of ["emergency_30", "compatibility_30"] as const) {
      const phase = policy.phaseProfiles[phaseName];
      if (phase.contactAo || phase.projectedShadow || phase.facadePattern || phase.roofCap || phase.treeBillboards) {
        context.addIssue({ code: "custom", message: `${phaseName} must disable decorative passes` });
      }
    }
  });

const BuildingRenderLodBandV1Schema = z
  .object({
    minZoom: z.number().int().min(0).max(22),
    maxZoom: z.number().int().min(0).max(22),
    representation: z.enum(["merged_footprints", "simplified_footprints", "full_geometry"]),
    sourceLayer: z.literal("building"),
    parentPartsMode: z.enum(["parents_only", "parts_preferred"]),
    simplificationToleranceMeters: z.number().nonnegative(),
  })
  .strict();

export const BuildingRenderPackManifestV1Schema = z
  .object({
    format: z.literal("omnitwin.building-render-pack.v1"),
    contractVersion: z.literal("1"),
    packId: z.string().regex(/^brp_[a-f0-9]{64}$/u),
    provider: z.enum(["overture", "openmaptiles"]),
    datasetVersion: z.string().min(1).max(128),
    subjectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/u),
    generatedAt: IsoDateTimeSchema,
    immutable: z.literal(true),
    transport: z.literal("pmtiles_http_range"),
    contentType: z.literal("application/vnd.pmtiles"),
    url: z.string().url().regex(/^https:\/\/[^?#]+\/[a-f0-9]{64}\.pmtiles$/u),
    sha256: Sha256Schema,
    bytes: z.number().int().positive(),
    bbox: z.tuple([
      z.number().min(-180).max(180),
      z.number().min(-90).max(90),
      z.number().min(-180).max(180),
      z.number().min(-90).max(90),
    ]),
    minZoom: z.literal(13),
    maxZoom: z.number().int().min(17).max(22),
    normalizedSchema: z.literal("omnitwin.render_buildings.v1"),
    sourceLayers: z.array(z.enum(["building", "building_part"])).min(1).max(2),
    lodBands: z.tuple([
      BuildingRenderLodBandV1Schema,
      BuildingRenderLodBandV1Schema,
      BuildingRenderLodBandV1Schema,
    ]),
    featureCounts: z
      .object({
        source: z.number().int().nonnegative(),
        merged: z.number().int().nonnegative(),
        simplified: z.number().int().nonnegative(),
        full: z.number().int().nonnegative(),
      })
      .strict(),
    attribution: z
      .object({ text: z.string().min(1), url: z.string().url(), license: z.string().min(1) })
      .strict(),
    rights: z
      .object({
        browserCache: z.boolean(),
        edgeCache: z.boolean(),
        proxy: z.boolean(),
        prefetch: z.enum(["visible_only", "visible_plus_one_ring"]),
      })
      .strict(),
    fallbackCompatibility: z
      .object({
        provider: z.enum(["overture", "openmaptiles"]),
        normalizedSchema: z.literal("omnitwin.render_buildings.v1"),
        wholeSourceOnly: z.literal(true),
        tileMixingAllowed: z.literal(false),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.packId !== `brp_${manifest.sha256}` || !manifest.url.endsWith(`/${manifest.sha256}.pmtiles`)) {
      context.addIssue({ code: "custom", message: "pack identity and URL must bind to sha256" });
    }
    if (!(manifest.bbox[0] < manifest.bbox[2] && manifest.bbox[1] < manifest.bbox[3])) {
      context.addIssue({ code: "custom", message: "building render pack bbox must be ordered" });
    }
    const expectedBands = [
      [13, 14, "merged_footprints", "parents_only"],
      [15, 16, "simplified_footprints", "parents_only"],
      [17, manifest.maxZoom, "full_geometry", "parts_preferred"],
    ] as const;
    if (manifest.lodBands.some((band, index) => (
      band.minZoom !== expectedBands[index]?.[0]
      || band.maxZoom !== expectedBands[index]?.[1]
      || band.representation !== expectedBands[index]?.[2]
      || band.parentPartsMode !== expectedBands[index]?.[3]
    ))) {
      context.addIssue({ code: "custom", message: "building render pack LOD bands must cover the canonical z13+ profile" });
    }
    if (
      new Set(manifest.sourceLayers).size !== manifest.sourceLayers.length
      || manifest.featureCounts.full > manifest.featureCounts.source
      || manifest.featureCounts.merged > manifest.featureCounts.simplified
      || manifest.fallbackCompatibility.provider === manifest.provider
    ) {
      context.addIssue({ code: "custom", message: "building render pack counts, layers, or failover provider are inconsistent" });
    }
  });

export const RendererPerformancePolicyV2Schema = z
  .object({
    contractVersion: z.literal("2"),
    policyId: z.literal("universal_lowpoly_presentation_v2"),
    tier: z.enum(["low", "mid", "high"]),
    targetFps: z.number().int().min(30).max(120),
    frameBudgetMs: z.number().min(8.3).max(33.4),
    maxCanvasScale: z.literal(1),
    peopleLimit: z.number().int().min(0).max(1200),
    vehicleLimit: z.number().int().min(0).max(1800),
    treeBillboardLimit: z.number().int().min(0).max(2500),
    workerCount: z.literal(1),
    schedulerMode: z.literal("invalidation_driven"),
    continuousRepaint: z.literal(false),
    continuousAnimationReasons: z.array(z.enum(["timeline_playback", "active_weather_particles"])).max(2).refine((items) => new Set(items).size === items.length, "continuous animation reasons must be unique"),
    reducedMotion: z.boolean(),
    degradationOrder: z.tuple([
      z.literal("tree_billboards"),
      z.literal("projected_shadows"),
      z.literal("roof_caps"),
      z.literal("facade_patterns"),
    ]),
  })
  .strict()
  .superRefine((policy, context) => {
    if (Math.abs(policy.frameBudgetMs - 1000 / policy.targetFps) > 0.11) context.addIssue({ code: "custom", message: "frameBudgetMs must match targetFps" });
    const expected = {
      low: [30, 33.333, 160, 320, 400],
      mid: [60, 16.667, 500, 800, 1200],
      high: [120, 8.333, 1200, 1800, 2500],
    }[policy.tier];
    if ([policy.targetFps, policy.frameBudgetMs, policy.peopleLimit, policy.vehicleLimit, policy.treeBillboardLimit].some((value, index) => value !== expected[index])) context.addIssue({ code: "custom", message: "tier must select its accepted target and caps exactly" });
    if (policy.reducedMotion && policy.continuousAnimationReasons.length > 0) context.addIssue({ code: "custom", message: "reducedMotion disables continuous animation reasons" });
  });

export const PersonPresentationProjectionV1Schema = z
  .object({
    contractVersion: z.literal("1"),
    runId: SafeRunIdSchema,
    opaqueId: PresentationOpaqueIdSchema,
    geographyId: z.string().min(1),
    geographyVintage: z.string().min(1),
    ageBand: z.string().min(1),
    sex: z.enum(["female", "male"]),
    employmentStatus: z.string().min(1),
    householdSize: z.number().int().min(1),
    stockAsOf: IsoDateSchema,
    provenance: ScientificProvenanceSchema,
    projectionScope: z.literal("focus_sample"),
    classification: PresentationClassificationSchema,
    privacy: PresentationPrivacySchema,
  })
  .strict();

export const SpatialAssignmentV1Schema = z
  .object({
    contractVersion: z.literal("1"),
    derivationVersion: z.literal("1.0.0"),
    runId: SafeRunIdSchema,
    assignmentId: PresentationAssignmentIdSchema,
    opaqueId: PresentationOpaqueIdSchema,
    sceneId: SafeRunIdSchema,
    presentationTime: IsoDateTimeSchema,
    presenceKind: z.enum(["building", "pedestrian_route", "vehicle"]),
    cellId: PresentationCellIdSchema,
    buildingId: PresentationObjectIdSchema.nullable(),
    routeId: PresentationRouteIdSchema.nullable(),
    edgeId: PresentationObjectIdSchema.nullable(),
    vehicleId: PresentationVehicleIdSchema.nullable(),
    assignmentOrigin: z.literal("deterministic_scene_projection"),
    classification: z.literal("visual_synthesis"),
    scientificClaim: z.literal(false),
    rawCoordinatesAvailable: z.literal(false),
  })
  .strict()
  .superRefine((assignment, context) => {
    const valid = assignment.presenceKind === "building"
      ? assignment.buildingId !== null && assignment.routeId === null && assignment.edgeId === null && assignment.vehicleId === null
      : assignment.presenceKind === "pedestrian_route"
        ? assignment.buildingId === null && assignment.routeId !== null && assignment.edgeId !== null && assignment.vehicleId === null
        : assignment.buildingId === null && assignment.routeId === null && assignment.edgeId === null && assignment.vehicleId !== null;
    if (!valid) context.addIssue({ code: "custom", message: "presence references must be exclusive" });
  });

export const BuildingOccupancyV1Schema = z
  .object({
    contractVersion: z.literal("1"), runId: SafeRunIdSchema, sceneId: SafeRunIdSchema,
    buildingId: PresentationObjectIdSchema, cellId: PresentationCellIdSchema, presentationTime: IsoDateTimeSchema,
    occupantOpaqueIds: z.array(PresentationOpaqueIdSchema), occupantCount: z.number().int().nonnegative(),
    capacityProxy: z.number().int().nonnegative().nullable(),
    membershipScope: z.enum(["focus_sample_projection", "containing_page", "containing_cell"]),
    projectionScope: z.literal("focus_sample"), classification: z.literal("visual_synthesis"), scientificClaim: z.literal(false),
  })
  .strict()
  .superRefine((item, context) => {
    if (new Set(item.occupantOpaqueIds).size !== item.occupantOpaqueIds.length || item.occupantCount !== item.occupantOpaqueIds.length) context.addIssue({ code: "custom", message: "occupancy membership invariant failed" });
  });

export const VehiclePresentationV1Schema = z
  .object({
    contractVersion: z.literal("1"), runId: SafeRunIdSchema, vehicleId: PresentationVehicleIdSchema,
    sceneId: SafeRunIdSchema, cellId: PresentationCellIdSchema, presentationTime: IsoDateTimeSchema,
    vehicleClass: z.literal("car"), routeId: PresentationRouteIdSchema, edgeId: PresentationObjectIdSchema,
    progress: z.number().min(0).max(1), direction: z.enum(["forward", "reverse"]), speedMps: z.number().min(0).max(100),
    passengerOpaqueIds: z.array(PresentationOpaqueIdSchema).min(1).max(4), passengerCount: z.number().int().min(1).max(4),
    passengerIdentity: z.literal("run_local_opaque_focus_people"),
    membershipScope: z.enum(["focus_sample_projection", "containing_page", "containing_cell"]),
    classification: z.literal("visual_synthesis"), representedPopulation: z.literal(0), projectionScope: z.literal("focus_sample"),
    scientificClaim: z.literal(false), rawCoordinatesAvailable: z.literal(false),
  })
  .strict()
  .superRefine((item, context) => {
    if (new Set(item.passengerOpaqueIds).size !== item.passengerOpaqueIds.length || item.passengerCount !== item.passengerOpaqueIds.length) context.addIssue({ code: "custom", message: "vehicle passenger invariant failed" });
  });

const AgentMotionV1Schema = z
  .object({
    state: z.enum(["stationary", "moving", "inherited_vehicle"]),
    progress: z.number().min(0).max(1).nullable(), speedMps: z.number().min(0).max(100).nullable(),
    direction: z.enum(["forward", "reverse"]).nullable(),
  })
  .strict()
  .superRefine((motion, context) => {
    const valid = motion.state === "stationary"
      ? motion.progress === null && motion.speedMps === 0 && motion.direction === null
      : motion.state === "moving"
        ? motion.progress !== null && motion.speedMps !== null && motion.direction !== null
        : motion.progress === null && motion.speedMps === null && motion.direction === null;
    if (!valid) context.addIssue({ code: "custom", message: "motion state fields disagree" });
  });

export const AgentMobilityPresentationV1Schema = z
  .object({
    contractVersion: z.literal("1"), derivationVersion: z.literal("1.0.0"), runId: SafeRunIdSchema,
    opaqueId: PresentationOpaqueIdSchema, assignment: SpatialAssignmentV1Schema,
    activity: z.enum(["home", "work", "study", "travel", "leisure"]),
    mobilityMode: z.enum(["stationary", "pedestrian", "vehicle_passenger"]), motion: AgentMotionV1Schema,
    vehicleId: PresentationVehicleIdSchema.nullable(), representation: z.literal("focus_person_1to1"),
    representedCount: z.literal(1), projectionScope: z.literal("focus_sample"), scientificClaim: z.literal(false),
  })
  .strict()
  .superRefine((agent, context) => {
    if (agent.opaqueId !== agent.assignment.opaqueId || agent.runId !== agent.assignment.runId || agent.vehicleId !== agent.assignment.vehicleId) context.addIssue({ code: "custom", message: "agent identity/run/vehicle must match assignment" });
    const valid = agent.mobilityMode === "stationary"
      ? agent.activity !== "travel" && agent.assignment.presenceKind === "building" && agent.vehicleId === null && agent.motion.state === "stationary"
      : agent.mobilityMode === "pedestrian"
        ? agent.activity === "travel" && agent.assignment.presenceKind === "pedestrian_route" && agent.vehicleId === null && agent.motion.state === "moving"
        : agent.activity === "travel" && agent.assignment.presenceKind === "vehicle" && agent.vehicleId !== null && agent.motion.state === "inherited_vehicle";
    if (!valid) context.addIssue({ code: "custom", message: "mobility mode fields disagree" });
  });

const PresentationRosterItemV1Schema = z
  .object({
    opaqueId: PresentationOpaqueIdSchema, geographyId: z.string().min(1), ageBand: z.string().min(1), sex: z.enum(["female", "male"]),
    employmentStatus: z.string().min(1), modelStockAsOf: IsoDateSchema, personProvenance: ScientificProvenanceSchema,
    activity: z.enum(["home", "work", "study", "travel", "leisure"]),
    mobilityMode: z.enum(["stationary", "pedestrian", "vehicle_passenger"]), mobilityClassification: z.literal("visual_synthesis"), mobilityScientificClaim: z.literal(false), assignmentId: PresentationAssignmentIdSchema,
    presenceKind: z.enum(["building", "pedestrian_route", "vehicle"]), cellId: PresentationCellIdSchema,
    buildingId: PresentationObjectIdSchema.nullable(), routeId: PresentationRouteIdSchema.nullable(), edgeId: PresentationObjectIdSchema.nullable(), vehicleId: PresentationVehicleIdSchema.nullable(),
  })
  .strict()
  .superRefine((item, context) => {
    const valid = item.presenceKind === "building" ? item.buildingId !== null && item.routeId === null && item.edgeId === null && item.vehicleId === null
      : item.presenceKind === "pedestrian_route" ? item.buildingId === null && item.routeId !== null && item.edgeId !== null && item.vehicleId === null
        : item.buildingId === null && item.routeId === null && item.edgeId === null && item.vehicleId !== null;
    if (!valid) context.addIssue({ code: "custom", message: "roster presence references must be exclusive" });
  });
const PageVehicleBaseV1Schema = z.object({ vehicleId: PresentationVehicleIdSchema, cellId: PresentationCellIdSchema, routeId: PresentationRouteIdSchema, edgeId: PresentationObjectIdSchema, progress: z.number().min(0).max(1), direction: z.enum(["forward", "reverse"]), speedMps: z.number().min(0).max(100), passengerOpaqueIds: z.array(PresentationOpaqueIdSchema).min(1).max(4), passengerCount: z.number().int().min(1).max(4), membershipScope: z.enum(["containing_page", "containing_cell"]), classification: z.literal("visual_synthesis") }).strict();
const PageOccupancyBaseV1Schema = z.object({ buildingId: PresentationObjectIdSchema, cellId: PresentationCellIdSchema.optional(), occupantOpaqueIds: z.array(PresentationOpaqueIdSchema), occupantCount: z.number().int().nonnegative(), capacityProxy: z.number().int().nonnegative().nullable(), membershipScope: z.enum(["containing_page", "containing_cell"]), classification: z.literal("visual_synthesis") }).strict();
const ContainingPageVehicleV1Schema = PageVehicleBaseV1Schema.safeExtend({ membershipScope: z.literal("containing_page") }).superRefine((item, context) => {
  if (new Set(item.passengerOpaqueIds).size !== item.passengerOpaqueIds.length || item.passengerCount !== item.passengerOpaqueIds.length) context.addIssue({ code: "custom", message: "page vehicle membership invariant failed" });
});
const ContainingPageOccupancyV1Schema = PageOccupancyBaseV1Schema.safeExtend({ cellId: PresentationCellIdSchema, membershipScope: z.literal("containing_page") }).superRefine((item, context) => {
  if (new Set(item.occupantOpaqueIds).size !== item.occupantOpaqueIds.length || item.occupantCount !== item.occupantOpaqueIds.length) context.addIssue({ code: "custom", message: "page occupancy membership invariant failed" });
});
const ContainingCellVehicleV1Schema = PageVehicleBaseV1Schema.omit({ cellId: true }).safeExtend({ membershipScope: z.literal("containing_cell") }).superRefine((item, context) => {
  if (new Set(item.passengerOpaqueIds).size !== item.passengerOpaqueIds.length || item.passengerCount !== item.passengerOpaqueIds.length) context.addIssue({ code: "custom", message: "cell vehicle membership invariant failed" });
});
const ContainingCellOccupancyV1Schema = PageOccupancyBaseV1Schema.omit({ cellId: true }).safeExtend({ membershipScope: z.literal("containing_cell") }).superRefine((item, context) => {
  if (new Set(item.occupantOpaqueIds).size !== item.occupantOpaqueIds.length || item.occupantCount !== item.occupantOpaqueIds.length) context.addIssue({ code: "custom", message: "cell occupancy membership invariant failed" });
});

export const MobilityPresentationBundleV1Schema = z
  .object({
    contractVersion: z.literal("1"), projectionVersion: z.literal("1.0.0"), projectionId: z.string().regex(/^prj_[a-f0-9]{64}$/u),
    runId: SafeRunIdSchema, sceneId: SafeRunIdSchema, sceneManifestSha256: Sha256Schema, bundleFingerprint: Sha256Schema,
    geographyId: z.string().min(1), geographyVintage: z.string().min(1), presentationTime: IsoDateTimeSchema, modelStockAsOf: IsoDateSchema,
    classification: PresentationClassificationSchema, projectionScope: z.literal("focus_sample"), scientificClaim: z.literal(false), sourceStatus: z.literal("complete"),
    privacy: PresentationResponsePrivacySchema,
    page: z.object({ offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100), total: z.number().int().nonnegative(), count: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable() }).strict(),
    rosterItems: z.array(PresentationRosterItemV1Schema), vehicles: z.array(ContainingPageVehicleV1Schema),
    buildingOccupancies: z.array(ContainingPageOccupancyV1Schema),
    counts: z.object({ focusPeopleTotal: z.number().int().nonnegative(), pageAgents: z.number().int().nonnegative(), stationaryAgents: z.number().int().nonnegative(), pedestrianAgents: z.number().int().nonnegative(), vehiclePassengerAgents: z.number().int().nonnegative(), vehicles: z.number().int().nonnegative(), buildingOccupancies: z.number().int().nonnegative() }).strict(),
    performancePolicy: RendererPerformancePolicyV2Schema,
  })
  .strict()
  .superRefine((bundle, context) => {
    const expectedNext = bundle.page.offset + bundle.page.count < bundle.page.total ? bundle.page.offset + bundle.page.count : null;
    if (bundle.page.count !== bundle.rosterItems.length || bundle.page.count !== Math.min(bundle.page.limit, bundle.page.total - bundle.page.offset) || bundle.page.offset + bundle.page.count > bundle.page.total || bundle.page.nextOffset !== expectedNext || bundle.page.total !== bundle.counts.focusPeopleTotal || bundle.page.count !== bundle.counts.pageAgents) context.addIssue({ code: "custom", message: "bundle pagination/count invariant failed" });
    const ids = bundle.rosterItems.map((item) => item.opaqueId);
    const assignmentIds = bundle.rosterItems.map((item) => item.assignmentId);
    if (new Set(ids).size !== ids.length || new Set(assignmentIds).size !== assignmentIds.length) context.addIssue({ code: "custom", message: "roster opaqueIds/assignmentIds must be unique" });
    const modes = {
      stationary: bundle.rosterItems.filter((item) => item.mobilityMode === "stationary").length,
      pedestrian: bundle.rosterItems.filter((item) => item.mobilityMode === "pedestrian").length,
      vehicle: bundle.rosterItems.filter((item) => item.mobilityMode === "vehicle_passenger").length,
    };
    if (bundle.counts.stationaryAgents !== modes.stationary || bundle.counts.pedestrianAgents !== modes.pedestrian || bundle.counts.vehiclePassengerAgents !== modes.vehicle || modes.stationary + modes.pedestrian + modes.vehicle !== bundle.counts.pageAgents || bundle.counts.vehicles !== bundle.vehicles.length || bundle.counts.buildingOccupancies !== bundle.buildingOccupancies.length) context.addIssue({ code: "custom", message: "bundle partition/object counts disagree" });
    if (bundle.rosterItems.some((item) => item.mobilityMode === "stationary" ? item.presenceKind !== "building" || item.activity === "travel" : item.mobilityMode === "pedestrian" ? item.presenceKind !== "pedestrian_route" || item.activity !== "travel" : item.presenceKind !== "vehicle" || item.activity !== "travel")) context.addIssue({ code: "custom", message: "bundle mobility/activity/presence mismatch" });
    const expectedVehicle = new Set(bundle.rosterItems.filter((item) => item.presenceKind === "vehicle").map((item) => item.opaqueId));
    const expectedBuilding = new Set(bundle.rosterItems.filter((item) => item.presenceKind === "building").map((item) => item.opaqueId));
    const vehicleMemberList = bundle.vehicles.flatMap((item) => item.passengerOpaqueIds);
    const buildingMemberList = bundle.buildingOccupancies.flatMap((item) => item.occupantOpaqueIds);
    const vehicleMembers = new Set(vehicleMemberList);
    const buildingMembers = new Set(buildingMemberList);
    if (vehicleMemberList.length !== vehicleMembers.size || buildingMemberList.length !== buildingMembers.size || expectedVehicle.size !== vehicleMembers.size || [...expectedVehicle].some((id) => !vehicleMembers.has(id)) || expectedBuilding.size !== buildingMembers.size || [...expectedBuilding].some((id) => !buildingMembers.has(id))) context.addIssue({ code: "custom", message: "page memberships must uniquely match roster" });
    const vehicleById = new Map(bundle.vehicles.map((item) => [item.vehicleId, item]));
    const buildingById = new Map(bundle.buildingOccupancies.map((item) => [item.buildingId, item]));
    if (vehicleById.size !== bundle.vehicles.length || buildingById.size !== bundle.buildingOccupancies.length || bundle.rosterItems.some((item) => item.presenceKind === "vehicle" ? item.vehicleId === null || !vehicleById.get(item.vehicleId)?.passengerOpaqueIds.includes(item.opaqueId) : item.presenceKind === "building" ? item.buildingId === null || !buildingById.get(item.buildingId)?.occupantOpaqueIds.includes(item.opaqueId) : false)) context.addIssue({ code: "custom", message: "page object references must resolve exactly" });
  });

export const LivingCellManifestV1Schema = z
  .object({
    format: z.literal("omnitwin.living-cells.v1"), contractVersion: z.literal("1"), projectionVersion: z.literal("1.0.0"), projectionId: z.string().regex(/^prj_[a-f0-9]{64}$/u), status: z.literal("complete"), immutable: z.literal(true),
    runId: SafeRunIdSchema, sceneId: SafeRunIdSchema, sceneManifestSha256: Sha256Schema, bundleFingerprint: Sha256Schema,
    geographyId: z.string().min(1), geographyVintage: z.string().min(1), modelStockAsOf: IsoDateSchema, presentationTime: IsoDateTimeSchema, sourceCompletedAt: IsoDateTimeSchema,
    classification: PresentationClassificationSchema, projectionScope: z.literal("focus_sample"), scientificClaim: z.literal(false),
    privacy: PresentationPrivacySchema.extend({ cachePolicy: z.literal("private_revalidate") }).strict(), cellZoom: z.literal(16),
    items: z.array(z.object({ cellId: PresentationCellIdSchema, path: z.string().regex(/^content\/living\/cells\/z16\/[0-9]{1,5}\/[0-9]{1,5}\.json$/u), sha256: Sha256Schema, bytes: z.number().int().min(2), url: z.string().regex(/^\/v2\/presentation\/living\/[a-z0-9][a-z0-9_-]{0,127}\/prj_[a-f0-9]{64}\/[a-f0-9]{64}\/cells\/z16\/[0-9]{1,5}\/[0-9]{1,5}\.json$/u), agentCount: z.number().int().nonnegative(), vehicleCount: z.number().int().nonnegative(), buildingOccupancyCount: z.number().int().nonnegative() }).strict()),
    count: z.number().int().nonnegative(), totals: z.object({ agents: z.number().int().nonnegative(), vehicles: z.number().int().nonnegative(), buildingOccupancies: z.number().int().nonnegative() }).strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.count !== manifest.items.length || manifest.totals.agents !== manifest.items.reduce((sum, item) => sum + item.agentCount, 0) || manifest.totals.vehicles !== manifest.items.reduce((sum, item) => sum + item.vehicleCount, 0) || manifest.totals.buildingOccupancies !== manifest.items.reduce((sum, item) => sum + item.buildingOccupancyCount, 0)) context.addIssue({ code: "custom", message: "living manifest count invariant failed" });
    const identities = [manifest.items.map((item) => item.cellId), manifest.items.map((item) => item.path), manifest.items.map((item) => item.url)];
    if (identities.some((items) => new Set(items).size !== items.length)) context.addIssue({ code: "custom", message: "living manifest identities must be unique" });
    if (manifest.items.some((item) => item.path !== `content/living/cells/${item.cellId}.json` || item.url !== `/v2/presentation/living/${manifest.runId}/${manifest.projectionId}/${item.sha256}/cells/${item.cellId}.json`)) context.addIssue({ code: "custom", message: "living manifest path/url identity mismatch" });
  });

const PresentationCellAgentV1Schema = z
  .object({
    opaqueId: PresentationOpaqueIdSchema, geographyId: z.string().min(1), ageBand: z.string().min(1), sex: z.enum(["female", "male"]),
    employmentStatus: z.string().min(1), modelStockAsOf: IsoDateSchema, personProvenance: ScientificProvenanceSchema,
    activity: z.enum(["home", "work", "study", "travel", "leisure"]), mobilityMode: z.enum(["stationary", "pedestrian", "vehicle_passenger"]),
    mobilityClassification: z.literal("visual_synthesis"), mobilityScientificClaim: z.literal(false), motion: AgentMotionV1Schema,
    representation: z.literal("focus_person_1to1"), representedCount: z.literal(1), assignmentId: PresentationAssignmentIdSchema,
    presenceKind: z.enum(["building", "pedestrian_route", "vehicle"]), cellId: PresentationCellIdSchema,
    buildingId: PresentationObjectIdSchema.nullable(), routeId: PresentationRouteIdSchema.nullable(), edgeId: PresentationObjectIdSchema.nullable(), vehicleId: PresentationVehicleIdSchema.nullable(),
  })
  .strict()
  .superRefine((item, context) => {
    const valid = item.mobilityMode === "stationary"
      ? item.activity !== "travel" && item.presenceKind === "building" && item.buildingId !== null && item.routeId === null && item.edgeId === null && item.vehicleId === null && item.motion.state === "stationary"
      : item.mobilityMode === "pedestrian"
        ? item.activity === "travel" && item.presenceKind === "pedestrian_route" && item.buildingId === null && item.routeId !== null && item.edgeId !== null && item.vehicleId === null && item.motion.state === "moving"
        : item.activity === "travel" && item.presenceKind === "vehicle" && item.buildingId === null && item.routeId === null && item.edgeId === null && item.vehicleId !== null && item.motion.state === "inherited_vehicle";
    if (!valid) context.addIssue({ code: "custom", message: "cell agent mobility/presence/motion fields disagree" });
  });

export const LivingCellSliceV1Schema = z
  .object({
    contractVersion: z.literal("1"), projectionVersion: z.literal("1.0.0"), projectionId: z.string().regex(/^prj_[a-f0-9]{64}$/u),
    runId: SafeRunIdSchema, sceneId: SafeRunIdSchema, sceneManifestSha256: Sha256Schema, bundleFingerprint: Sha256Schema, cellId: PresentationCellIdSchema,
    geographyVintage: z.string().min(1), modelStockAsOf: IsoDateSchema, presentationTime: IsoDateTimeSchema, classification: PresentationClassificationSchema,
    projectionScope: z.literal("focus_sample"), scientificClaim: z.literal(false), privacy: PresentationResponsePrivacySchema,
    agents: z.array(PresentationCellAgentV1Schema),
    vehicles: z.array(ContainingCellVehicleV1Schema),
    buildingOccupancies: z.array(ContainingCellOccupancyV1Schema),
    counts: z.object({ agents: z.number().int().nonnegative(), stationaryAgents: z.number().int().nonnegative(), pedestrianAgents: z.number().int().nonnegative(), vehiclePassengerAgents: z.number().int().nonnegative(), vehicles: z.number().int().nonnegative(), buildingOccupancies: z.number().int().nonnegative() }).strict(),
  })
  .strict()
  .superRefine((slice, context) => {
    if (slice.counts.agents !== slice.agents.length || slice.counts.vehicles !== slice.vehicles.length || slice.counts.buildingOccupancies !== slice.buildingOccupancies.length || slice.agents.some((item) => item.cellId !== slice.cellId)) context.addIssue({ code: "custom", message: "living cell count/locality invariant failed" });
    const agentIds = slice.agents.map((item) => item.opaqueId);
    const assignmentIds = slice.agents.map((item) => item.assignmentId);
    if (new Set(agentIds).size !== agentIds.length || new Set(assignmentIds).size !== assignmentIds.length) context.addIssue({ code: "custom", message: "living cell agent/assignment identities must be unique" });
    const modes = {
      stationary: slice.agents.filter((item) => item.mobilityMode === "stationary").length,
      pedestrian: slice.agents.filter((item) => item.mobilityMode === "pedestrian").length,
      vehicle: slice.agents.filter((item) => item.mobilityMode === "vehicle_passenger").length,
    };
    if (slice.counts.stationaryAgents !== modes.stationary || slice.counts.pedestrianAgents !== modes.pedestrian || slice.counts.vehiclePassengerAgents !== modes.vehicle || modes.stationary + modes.pedestrian + modes.vehicle !== slice.counts.agents) context.addIssue({ code: "custom", message: "living cell mobility partitions disagree" });
    if (slice.vehicles.some((item) => item.passengerCount !== item.passengerOpaqueIds.length || new Set(item.passengerOpaqueIds).size !== item.passengerOpaqueIds.length) || slice.buildingOccupancies.some((item) => item.occupantCount !== item.occupantOpaqueIds.length || new Set(item.occupantOpaqueIds).size !== item.occupantOpaqueIds.length)) context.addIssue({ code: "custom", message: "living cell object membership counts disagree" });
    const expectedVehicle = new Set(slice.agents.filter((item) => item.presenceKind === "vehicle").map((item) => item.opaqueId));
    const expectedBuilding = new Set(slice.agents.filter((item) => item.presenceKind === "building").map((item) => item.opaqueId));
    const vehicleMemberList = slice.vehicles.flatMap((item) => item.passengerOpaqueIds);
    const buildingMemberList = slice.buildingOccupancies.flatMap((item) => item.occupantOpaqueIds);
    const vehicleMembers = new Set(vehicleMemberList);
    const buildingMembers = new Set(buildingMemberList);
    if (vehicleMemberList.length !== vehicleMembers.size || buildingMemberList.length !== buildingMembers.size || expectedVehicle.size !== vehicleMembers.size || [...expectedVehicle].some((id) => !vehicleMembers.has(id)) || expectedBuilding.size !== buildingMembers.size || [...expectedBuilding].some((id) => !buildingMembers.has(id))) context.addIssue({ code: "custom", message: "living cell memberships must uniquely match agents" });
    const vehicleById = new Map(slice.vehicles.map((item) => [item.vehicleId, item]));
    const buildingById = new Map(slice.buildingOccupancies.map((item) => [item.buildingId, item]));
    if (vehicleById.size !== slice.vehicles.length || buildingById.size !== slice.buildingOccupancies.length || slice.agents.some((item) => item.presenceKind === "vehicle" ? item.vehicleId === null || !vehicleById.get(item.vehicleId)?.passengerOpaqueIds.includes(item.opaqueId) : item.presenceKind === "building" ? item.buildingId === null || !buildingById.get(item.buildingId)?.occupantOpaqueIds.includes(item.opaqueId) : false)) context.addIssue({ code: "custom", message: "living cell object references must resolve exactly" });
  });

export type SceneSourceSnapshotV1 = z.infer<typeof SceneSourceSnapshotV1Schema>;
export type SceneLayerDescriptorV1 = z.infer<typeof SceneLayerDescriptorV1Schema>;
export type SceneManifestV1 = z.infer<typeof SceneManifestV1Schema>;
export type SceneCompletionReportV1 = z.infer<typeof SceneCompletionReportV1Schema>;
export type SceneCellDescriptorV1 = z.infer<typeof SceneCellDescriptorV1Schema>;
export type SceneStaticFeatureV1 = z.infer<typeof SceneStaticFeatureV1Schema>;
export type SceneCellIndexV1 = z.infer<typeof SceneCellIndexV1Schema>;
export type SceneCellPayloadV1 = z.infer<typeof SceneCellPayloadV1Schema>;
export type MovementNodeV1 = z.infer<typeof MovementNodeV1Schema>;
export type MovementEdgeV1 = z.infer<typeof MovementEdgeV1Schema>;
export type MovementRouteV1 = z.infer<typeof MovementRouteV1Schema>;
export type MovementGraphV1 = z.infer<typeof MovementGraphV1Schema>;
export type SceneAnchorV1 = z.infer<typeof SceneAnchorV1Schema>;
export type EnvironmentCycleV1 = z.infer<typeof EnvironmentCycleV1Schema>;
export type EnvironmentCyclePayloadV1 = z.infer<typeof EnvironmentCyclePayloadV1Schema>;
export type EnvironmentStateV1 = z.infer<typeof EnvironmentStateV1Schema>;
export type RendererQualityProfileV1 = z.infer<typeof RendererQualityProfileV1Schema>;
export type VisualEntityV2 = z.infer<typeof VisualEntityV2Schema>;
export type SceneCatalogResponseV1 = z.infer<typeof SceneCatalogResponseV1Schema>;
export type RunEligibilityCatalogV1 = z.infer<typeof RunEligibilityCatalogV1Schema>;
export type WorldViewportResponseV2 = z.infer<typeof WorldViewportResponseV2Schema>;
export type RendererPerformancePolicyV2 = z.infer<typeof RendererPerformancePolicyV2Schema>;
export type RendererPerformancePolicyV3 = z.infer<typeof RendererPerformancePolicyV3Schema>;
export type BuildingRenderPackManifestV1 = z.infer<typeof BuildingRenderPackManifestV1Schema>;
export type PersonPresentationProjectionV1 = z.infer<typeof PersonPresentationProjectionV1Schema>;
export type SpatialAssignmentV1 = z.infer<typeof SpatialAssignmentV1Schema>;
export type BuildingOccupancyV1 = z.infer<typeof BuildingOccupancyV1Schema>;
export type VehiclePresentationV1 = z.infer<typeof VehiclePresentationV1Schema>;
export type AgentMobilityPresentationV1 = z.infer<typeof AgentMobilityPresentationV1Schema>;
export type MobilityPresentationBundleV1 = z.infer<typeof MobilityPresentationBundleV1Schema>;
export type LivingCellManifestV1 = z.infer<typeof LivingCellManifestV1Schema>;
export type LivingCellSliceV1 = z.infer<typeof LivingCellSliceV1Schema>;
