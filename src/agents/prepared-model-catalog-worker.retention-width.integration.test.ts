import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { captureClawInstallSchemaVersionFacts } from "../claws/provenance-runtime-read.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  createPreparedModelCatalogWorkerInput,
  type PreparedModelCatalogWorkerTask,
  type PreparedModelWorkerResult,
} from "./prepared-model-catalog-worker.js";
import {
  createCatalogFixture,
  PLUGIN_ID,
  PROVIDER_ID,
} from "./prepared-model-catalog-worker.test-support.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir } = usePreparedCatalogWorkerFixtures();

const NATIVE_ESM_BUFFER_BYTES = 4 * 1024 * 1024;

type CatalogRow = {
  evaluations: number;
  bornAt: number;
  registers: number;
  marker: string;
  url: string;
  arrayBuffers: number;
};

type Sample = CatalogRow & { catalogModelIds: string[] };

function writePlugin(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: PLUGIN_ID, type: "module" }),
  );
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: PLUGIN_ID,
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          marker: { type: "string" },
          revision: { type: "number" },
        },
      },
    }),
  );
  const entry = path.join(dir, "index.js");
  fs.writeFileSync(
    entry,
    `import fs from "node:fs";
const retained = new Uint8Array(${NATIVE_ESM_BUFFER_BYTES});
retained[0] = 7;
let marker = "unset";
let registers = 0;
const evaluations = globalThis[Symbol.for("openclaw.retentionWidthEvaluations")] ??= { count: 0 };
evaluations.count += 1;
const bornAt = evaluations.count;
export function register(api) {
  if (retained[0] !== 7) throw new Error("retained native ESM buffer was collected");
  registers += 1;
  marker = String(api?.pluginConfig?.marker ?? "unset");
  api.registerProvider({
    id: ${JSON.stringify(PROVIDER_ID)},
    label: "Retention width",
    auth: [],
    catalog: { async run() {
      fs.appendFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, JSON.stringify({
        phase: "catalog",
        evaluations: evaluations.count,
        bornAt,
        registers,
        marker,
        url: import.meta.url,
        arrayBuffers: process.memoryUsage().arrayBuffers,
      }) + "\\n");
      return { provider: { api: "openai-completions", baseUrl: "https://heap.invalid/v1", models: [{ id: marker, name: "Retention" }] } };
    } },
  });
}
`,
  );
  return entry;
}

function catalogRows(markerPath: string): CatalogRow[] {
  if (!fs.existsSync(markerPath)) {
    return [];
  }
  const text = fs.readFileSync(markerPath, "utf8").trim();
  if (!text) {
    return [];
  }
  return text
    .split("\n")
    .map((line) => JSON.parse(line) as CatalogRow & { phase?: string })
    .filter((row) => row.phase === "catalog");
}

function publish(label: string, names: string[], samples: Sample[]): void {
  const firstUrl = samples[0]?.url;
  console.log(
    JSON.stringify({
      case: label,
      steps: samples.map((sample, index) => ({
        step: names[index],
        marker: sample.marker,
        registers: sample.registers,
        evaluations: sample.evaluations,
        bornAt: sample.bornAt,
        arrayBuffers: sample.arrayBuffers,
        sameModuleAsFirst: sample.url === firstUrl,
        catalogModelIds: sample.catalogModelIds,
      })),
    }),
  );
}

async function measure(
  label: string,
  names: string[],
  requests: Array<{
    entry: string;
    workspaceDir: string;
    agentDir: string;
    agentId: string;
    marker: string;
    revision: number;
  }>,
): Promise<Sample[]> {
  const fixture = createCatalogFixture(makeTempDir, 0);
  const samples: Sample[] = [];
  const pool = new WorkerTaskPool<PreparedModelCatalogWorkerTask, PreparedModelWorkerResult>({
    workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.preparedModelCatalog),
    maxWorkers: 1,
    idleTimeoutMs: 0,
    restartOnError: false,
    workerOptions: {
      resourceLimits: { maxOldGenerationSizeMb: 512 },
      workerData: {
        sourceCaptureDirectory: makeTempDir(`openclaw-retention-width-${label}-`),
      },
      env: fixture.env,
    },
  });
  try {
    for (const request of requests) {
      fs.mkdirSync(request.workspaceDir, { recursive: true });
      fs.mkdirSync(request.agentDir, { recursive: true });
      const config = {
        ...fixture.config,
        plugins: {
          ...fixture.config.plugins,
          load: { paths: [request.entry] },
          entries: {
            [PLUGIN_ID]: {
              enabled: true,
              config: { marker: request.marker, revision: request.revision },
            },
          },
        },
        models: {
          providers: {
            [PROVIDER_ID]: {
              baseUrl: "https://retention.invalid/v1",
              api: "openai-completions" as const,
              models: [],
            },
          },
        },
      };
      const metadata = loadPluginMetadataSnapshot({
        config,
        env: fixture.env,
        workspaceDir: request.workspaceDir,
        allowCurrent: false,
      });
      const value = createPreparedModelCatalogWorkerInput({
        agentFacts: {
          input: {
            agentId: request.agentId,
            agentDir: request.agentDir,
            inheritedAuthDir: request.agentDir,
            workspaceDir: request.workspaceDir,
            config,
            env: fixture.env,
          },
          env: fixture.env,
          authStore: { version: 1, profiles: {} },
          credentials: {},
          templateAuthStorage: AuthStorage.inMemory({}),
          providerIds: [PROVIDER_ID],
          configuredModelRefs: [],
          configuredRuntimeModels: [],
          runtimeCapabilityModels: [],
          configuredGeneratedCatalogPluginIds: [],
        },
        pluginMetadataSnapshot: metadata,
      });
      const before = catalogRows(fixture.marker).length;
      const result = await pool.run(
        {
          value,
          request: {
            kind: "catalog",
            syntheticAuth: [],
            clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env: fixture.env }),
          },
        },
        { timeoutMs: 60_000 },
      );
      const catalogModelIds =
        result.status === "ok" && result.kind === "catalog"
          ? result.snapshot.entries.map((entry) => entry.id)
          : [];
      const row = catalogRows(fixture.marker).at(-1);
      if (result.status !== "ok" || !row || catalogRows(fixture.marker).length === before) {
        throw new Error(
          `${label} ${request.agentId} rev ${request.revision} did not record a catalog: ${JSON.stringify(result)}`,
        );
      }
      samples.push({ ...row, catalogModelIds });
    }
  } finally {
    await pool.close();
  }
  publish(label, names, samples);
  return samples;
}

it("grows when each refresh evaluates a new native ESM module", async () => {
  const root = makeTempDir("openclaw-retention-refresh-");
  const workspaceDir = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const requests = Array.from({ length: 6 }, (_, revision) => ({
    entry: writePlugin(path.join(root, `plugin-${revision}`)),
    workspaceDir,
    agentDir,
    agentId: "main",
    marker: `rev-${revision}`,
    revision,
  }));
  const samples = await measure(
    "per-refresh",
    requests.map((_, revision) => `refresh-${revision}`),
    requests,
  );
  expect(samples.map((sample) => sample.marker)).toEqual([
    "rev-0",
    "rev-1",
    "rev-2",
    "rev-3",
    "rev-4",
    "rev-5",
  ]);
  expect(samples.at(-1)?.evaluations).toBe(6);
  expect(samples.at(-1)?.bornAt).toBe(6);
  expect(new Set(samples.map((sample) => sample.url)).size).toBe(6);
  const growth = samples.at(-1)!.arrayBuffers - samples[0]!.arrayBuffers;
  expect(growth).toBeGreaterThan(NATIVE_ESM_BUFFER_BYTES * 4);
}, 180_000);

it("shares one native ESM module between live workspaces", async () => {
  const root = makeTempDir("openclaw-retention-shared-");
  const entry = writePlugin(path.join(root, "plugin"));
  const alpha = {
    entry,
    workspaceDir: path.join(root, "workspace-alpha"),
    agentDir: path.join(root, "agent-alpha"),
    agentId: "alpha",
  };
  const beta = {
    entry,
    workspaceDir: path.join(root, "workspace-beta"),
    agentDir: path.join(root, "agent-beta"),
    agentId: "beta",
  };
  const samples = await measure(
    "one-module",
    ["alpha", "alpha-again", "beta", "alpha-after-beta", "alpha-refresh", "beta-after-refresh"],
    [
      { ...alpha, marker: "alpha", revision: 0 },
      { ...alpha, marker: "alpha", revision: 0 },
      { ...beta, marker: "beta", revision: 0 },
      { ...alpha, marker: "alpha", revision: 0 },
      { ...alpha, marker: "alpha", revision: 1 },
      { ...beta, marker: "beta", revision: 0 },
    ],
  );
  expect(samples.every((sample) => sample.evaluations === 1)).toBe(true);
  expect(new Set(samples.map((sample) => sample.url)).size).toBe(1);
  expect(samples.map((sample) => sample.marker)).toEqual([
    "alpha",
    "alpha",
    "beta",
    "beta",
    "alpha",
    "alpha",
  ]);
  const growth = samples.at(-1)!.arrayBuffers - samples[0]!.arrayBuffers;
  expect(growth).toBeLessThan(NATIVE_ESM_BUFFER_BYTES);
}, 180_000);

it("keeps a native ESM module per workspace copy and grows with new workspaces", async () => {
  const root = makeTempDir("openclaw-retention-per-workspace-");
  const workspace = (name: string, revision = 0) => ({
    entry: writePlugin(path.join(root, `plugin-${name}`)),
    workspaceDir: path.join(root, `workspace-${name}`),
    agentDir: path.join(root, `agent-${name}`),
    agentId: name,
    marker: name,
    revision,
  });
  const alpha = workspace("alpha");
  const beta = workspace("beta");
  const samples = await measure(
    "per-workspace",
    [
      "alpha",
      "alpha-again",
      "beta",
      "alpha-after-beta",
      "alpha-refresh",
      "beta-after-refresh",
      "gamma",
      "delta",
      "alpha-after-churn",
    ],
    [
      alpha,
      { ...alpha, revision: 0 },
      beta,
      { ...alpha, revision: 0 },
      { ...alpha, revision: 1 },
      { ...beta, revision: 0 },
      workspace("gamma"),
      workspace("delta"),
      { ...alpha, revision: 2 },
    ],
  );
  expect(samples.map((sample) => sample.marker)).toEqual([
    "alpha",
    "alpha",
    "beta",
    "alpha",
    "alpha",
    "beta",
    "gamma",
    "delta",
    "alpha",
  ]);
  expect(samples[2]?.evaluations).toBe(2);
  expect(samples[5]?.evaluations).toBe(2);
  expect(samples[7]?.evaluations).toBe(4);
  expect(samples[8]?.evaluations).toBe(4);
  expect(samples[0]?.url).toBe(samples[8]?.url);
  expect(samples[0]?.url).not.toBe(samples[2]?.url);
  const refreshGrowth = samples[5]!.arrayBuffers - samples[2]!.arrayBuffers;
  const churnGrowth = samples[7]!.arrayBuffers - samples[5]!.arrayBuffers;
  const afterChurnGrowth = samples[8]!.arrayBuffers - samples[7]!.arrayBuffers;
  expect(refreshGrowth).toBeLessThan(NATIVE_ESM_BUFFER_BYTES);
  expect(churnGrowth).toBeGreaterThan(NATIVE_ESM_BUFFER_BYTES);
  expect(afterChurnGrowth).toBeLessThan(NATIVE_ESM_BUFFER_BYTES);
}, 180_000);
