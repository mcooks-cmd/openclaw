import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  readPreparedPoolPresenceDemandInDatabase,
  writePreparedPoolPresenceDemandInDatabase,
} from "./prepared-pool-presence-store.js";
import { readPreparedPoolPresenceDemand } from "./prepared-pool-presence-worker.js";
import type { PreparedPoolPresenceDemand } from "./prepared-pool-presence.types.js";

const PRESENCE_KEY = "cloudWorkers.preparedPool.humanPresenceDemand";

const demand = (): PreparedPoolPresenceDemand => ({
  revision: 1,
  profileId: "example-azure",
  requestedRef: "main",
  preparationKey: "b".repeat(64),
  lastPresentAtMs: 1_000,
  retireAtMs: null,
  project: {
    key: "a".repeat(64),
    baseCommit: "c".repeat(40),
    source: {
      kind: "repository",
      url: "https://github.com/acme/private-repo.git",
      repositoryId: "R_acme_private_repo",
      owner: {
        agent: { agentId: "main", provenance: null },
        identity: { source: "system-detected", accountId: 123 },
      },
    },
  },
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("prepared-pool human-presence demand storage", () => {
  let database: OpenClawStateDatabase;
  let root: string;

  beforeEach(async () => {
    root = tempDirs.make("prepared-presence-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  });

  afterEach(async () => {
    clearRuntimeConfigSnapshot();
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
  });

  it("persists one validated demand record and deletes only its owned key", async () => {
    expect(writePreparedPoolPresenceDemandInDatabase(database.db, demand())).toEqual(demand());
    expect(readPreparedPoolPresenceDemandInDatabase(database.db)).toEqual(demand());
    expect(await readPreparedPoolPresenceDemand()).toEqual(demand());

    await closeOpenClawStateDatabaseAsync();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    expect(readPreparedPoolPresenceDemandInDatabase(database.db)).toEqual(demand());

    database.db
      .prepare(
        "INSERT INTO config_machine_state(state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
      )
      .run("unrelated", "{}", 1);
    expect(writePreparedPoolPresenceDemandInDatabase(database.db, null)).toBeUndefined();
    expect(readPreparedPoolPresenceDemandInDatabase(database.db)).toBeUndefined();
    expect(await readPreparedPoolPresenceDemand()).toBeUndefined();
    expect(
      database.db
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
        .get("unrelated"),
    ).toEqual({ value_json: "{}" });
  });

  it("refuses malformed retained timing instead of resetting it", () => {
    database.db
      .prepare(
        "INSERT INTO config_machine_state(state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
      )
      .run(PRESENCE_KEY, JSON.stringify({ ...demand(), retireAtMs: 999 }), 1);
    expect(() => readPreparedPoolPresenceDemandInDatabase(database.db)).toThrow(
      "Prepared-pool presence demand is invalid",
    );
  });

  it("reads an existing demand after the configured GitHub host changes", () => {
    writePreparedPoolPresenceDemandInDatabase(database.db, demand());
    setRuntimeConfigSnapshot({
      gateway: {
        github: { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/api/v3" },
      },
    });

    expect(readPreparedPoolPresenceDemandInDatabase(database.db)).toEqual(demand());
    expect(() => writePreparedPoolPresenceDemandInDatabase(database.db, demand())).toThrow(
      "Prepared-pool presence demand is invalid",
    );
  });
});
