import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { writePreparedPoolPresenceDemandInDatabase } from "./prepared-pool-presence-store.js";
import type { PreparedPoolPresenceDemand } from "./prepared-pool-presence.types.js";

type PresenceCommand = {
  type: "preparedPoolPresence.write";
  input: PreparedPoolPresenceDemand | null;
};

export function executePreparedPoolPresenceCommand(params: {
  command: PresenceCommand;
  database: OpenClawStateDatabase;
  env: NodeJS.ProcessEnv;
}) {
  const value = params.command.input;
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const result = writePreparedPoolPresenceDemandInDatabase(db, value);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return result;
    },
    { database: params.database, path: params.database.path, env: params.env },
    { operationLabel: "prepared-pool.presence-demand.write" },
  );
}
