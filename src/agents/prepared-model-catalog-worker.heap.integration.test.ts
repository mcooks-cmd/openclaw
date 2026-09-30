import { createHash } from "node:crypto";
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

it("bounds catalog worker retention across repeated fleet preparations", async () => {
  const fixture = createCatalogFixture(makeTempDir, 0);
  fs.writeFileSync(
    path.join(fixture.root, "plugin", "index.cjs"),
    `
const v8 = require("node:v8");
const state = globalThis[Symbol.for("openclaw.catalogHeapFixture")] ??= {
  callbacks: [], calls: 0, control: new WeakRef({})
};
const iterations = Number(process.env.OPENCLAW_CATALOG_HEAP_ITERATIONS ?? 12);
module.exports = { id: ${JSON.stringify(PROVIDER_ID)}, register(api) {
  const run = function catalogRetentionHook() {
    state.calls++;
    if (state.calls % 100 === 0 || state.calls >= iterations) {
      // Collection follows earlier worker requests, so WeakRef targets are no longer job-kept.
      v8.queryObjects(WeakRef);
      require("node:fs").writeFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, JSON.stringify({
        callbacks: state.callbacks.filter(ref => ref.deref()).length,
        controlCollected: state.control.deref() === undefined
      }));
    }
    return { provider: { api: "openai-completions", baseUrl: "https://heap.invalid/v1", models: [{ id: "heap-model", name: "Heap model" }] } };
  };
  state.callbacks.push(new WeakRef(run));
  api.registerProvider({ id: ${JSON.stringify(PROVIDER_ID)}, label: "Heap fixture", auth: [], catalog: { run } });
} };`,
  );
  const manifestPath = path.join(fixture.root, "plugin", "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.configSchema = { type: "object", properties: { revision: { type: "number" } } };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const metadata = loadPluginMetadataSnapshot({
    config: fixture.config,
    env: fixture.env,
    workspaceDir: fixture.workspaceDir,
  });
  const inputs = Array.from({ length: 4 }, (_, revision) => {
    const config = {
      ...fixture.config,
      plugins: {
        ...fixture.config.plugins,
        entries: { [PROVIDER_ID]: { enabled: true, config: { revision } } },
      },
      models: {
        providers: {
          [PROVIDER_ID]: {
            baseUrl: `https://revision-${revision}.invalid/v1`,
            api: "openai-completions" as const,
            models: [],
          },
        },
      },
    };
    return createPreparedModelCatalogWorkerInput({
      agentFacts: {
        input: {
          agentId: "main",
          agentDir: fixture.agentDir,
          inheritedAuthDir: fixture.agentDir,
          workspaceDir: fixture.workspaceDir,
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
  });
  const pool = new WorkerTaskPool<PreparedModelCatalogWorkerTask, PreparedModelWorkerResult>({
    workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.preparedModelCatalog),
    maxWorkers: 1,
    idleTimeoutMs: 0,
    restartOnError: false,
    workerOptions: {
      resourceLimits: { maxOldGenerationSizeMb: 512 },
      workerData: {
        sourceCaptureDirectory: makeTempDir("openclaw-catalog-heap-captures-"),
      },
      env: fixture.env,
    },
  });
  try {
    const hashes = new Map<number, string>();
    const count = Number(process.env.OPENCLAW_CATALOG_HEAP_ITERATIONS ?? 12);
    for (let index = 0; index < count; index++) {
      const revision = index % inputs.length;
      const result = await pool.run(
        {
          value: inputs[revision]!,
          request: {
            kind: "catalog",
            syntheticAuth: [],
            clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env: fixture.env }),
          },
        },
        { timeoutMs: 30_000 },
      );
      expect(result.status).toBe("ok");
      if (result.status !== "ok" || result.kind !== "catalog") {
        throw new Error(JSON.stringify(result));
      }
      const hash = createHash("sha256")
        .update(JSON.stringify(result.snapshot.entries))
        .digest("hex");
      if (hashes.has(revision)) {
        expect(hash).toBe(hashes.get(revision));
      }
      hashes.set(revision, hash);
    }
    // Reuse the last generation after its predecessor's retirement has completed.
    await pool.run(
      {
        value: inputs[(count - 1) % inputs.length]!,
        request: {
          kind: "catalog",
          syntheticAuth: [],
          clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env: fixture.env }),
        },
      },
      { timeoutMs: 30_000 },
    );
    const retained = JSON.parse(fs.readFileSync(fixture.marker, "utf8")) as {
      callbacks: number;
      controlCollected: boolean;
    };
    expect(retained.controlCollected).toBe(true);
    expect(retained.callbacks).toBe(1);
  } finally {
    await pool.close();
  }
}, 300_000);

const NATIVE_ESM_BUFFER_BYTES = 4 * 1024 * 1024;

it("bounds catalog worker memory across repeated native ESM plugin generations", async () => {
  const fixture = createCatalogFixture(makeTempDir, 0);
  const cjsEntry = fixture.config.plugins.load.paths[0];
  if (!cjsEntry) {
    throw new Error("catalog fixture did not register a plugin entry");
  }
  const pluginDir = path.dirname(cjsEntry);
  fs.rmSync(cjsEntry, { force: true });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({ name: PLUGIN_ID, type: "module" }),
  );
  const entry = path.join(pluginDir, "index.js");
  fs.writeFileSync(
    entry,
    `import fs from "node:fs";
const retained = new Uint8Array(${NATIVE_ESM_BUFFER_BYTES});
retained[0] = 7;
const state = globalThis[Symbol.for("openclaw.nativeEsmCatalogHeap")] ??= { evaluations: 0 };
state.evaluations += 1;
fs.appendFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, JSON.stringify({
  evaluations: state.evaluations,
  url: import.meta.url,
  arrayBuffers: process.memoryUsage().arrayBuffers,
  external: process.memoryUsage().external,
}) + "\\n");
export function register(api) {
  if (retained[0] !== 7) throw new Error("retained native ESM buffer was collected");
  api.registerProvider({
    id: ${JSON.stringify(PROVIDER_ID)},
    label: "Heap fixture",
    auth: [],
    catalog: { run() {
      return { provider: { api: "openai-completions", baseUrl: "https://heap.invalid/v1", models: [{ id: "heap-model", name: "Heap model" }] } };
    } },
  });
}
`,
  );
  const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    configSchema?: { type?: string; properties?: Record<string, unknown> };
  };
  manifest.configSchema = {
    type: "object",
    ...manifest.configSchema,
    properties: { ...manifest.configSchema?.properties, revision: { type: "number" } },
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const baseConfig = {
    ...fixture.config,
    plugins: {
      ...fixture.config.plugins,
      load: { paths: [entry] },
    },
  };
  const metadata = loadPluginMetadataSnapshot({
    config: baseConfig,
    env: fixture.env,
    workspaceDir: fixture.workspaceDir,
  });
  const revisions = Array.from({ length: 6 }, (_, revision) =>
    createPreparedModelCatalogWorkerInput({
      agentFacts: {
        input: {
          agentId: "main",
          agentDir: fixture.agentDir,
          inheritedAuthDir: fixture.agentDir,
          workspaceDir: fixture.workspaceDir,
          config: {
            ...baseConfig,
            plugins: {
              ...baseConfig.plugins,
              entries: { [PLUGIN_ID]: { enabled: true, config: { revision } } },
            },
            models: {
              providers: {
                [PROVIDER_ID]: {
                  baseUrl: `https://revision-${revision}.invalid/v1`,
                  api: "openai-completions" as const,
                  models: [],
                },
              },
            },
          },
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
    }),
  );
  const pool = new WorkerTaskPool<PreparedModelCatalogWorkerTask, PreparedModelWorkerResult>({
    workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.preparedModelCatalog),
    maxWorkers: 1,
    idleTimeoutMs: 0,
    restartOnError: false,
    workerOptions: {
      resourceLimits: { maxOldGenerationSizeMb: 512 },
      workerData: {
        sourceCaptureDirectory: makeTempDir("openclaw-catalog-heap-captures-"),
      },
      env: fixture.env,
    },
  });
  const samples: Array<{ evaluations: number; arrayBuffers: number; url: string }> = [];
  try {
    for (let index = 0; index < revisions.length; index++) {
      const result = await pool.run(
        {
          value: revisions[index]!,
          request: {
            kind: "catalog",
            syntheticAuth: [],
            clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env: fixture.env }),
          },
        },
        { timeoutMs: 60_000 },
      );
      if (result.status !== "ok") {
        console.log(JSON.stringify(result));
      }
      expect(result.status).toBe("ok");
      const rows = fs
        .readFileSync(fixture.marker, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) => JSON.parse(line) as { evaluations: number; url: string; arrayBuffers: number },
        );
      const latest = rows.at(-1)!;
      samples.push({
        evaluations: latest.evaluations,
        arrayBuffers: latest.arrayBuffers,
        url: latest.url,
      });
      console.log(
        JSON.stringify({
          revision: index,
          evaluations: latest.evaluations,
          arrayBuffers: latest.arrayBuffers,
          url: latest.url,
        }),
      );
    }
  } finally {
    await pool.close();
  }
  const growth = samples[samples.length - 1]!.arrayBuffers - samples[0]!.arrayBuffers;
  // One native ESM evaluation owns the fixture buffer. Another copy per generation
  // means Node kept each captured module URL after the generation was released.
  expect(samples[samples.length - 1]!.evaluations).toBe(1);
  expect(growth).toBeLessThan(NATIVE_ESM_BUFFER_BYTES);
}, 180_000);
