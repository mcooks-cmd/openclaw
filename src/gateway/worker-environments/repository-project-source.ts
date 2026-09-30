import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGitHubHost } from "../../agents/github-host-runtime.js";
import { parseProjectGitUrl } from "../../projects/project-git-url.js";
import {
  RepositoryWorkerProjectSchema,
  type RepositoryWorkerProjectSnapshot,
} from "./repository-project-source.schema.js";

/** Repository facts persist; current visibility and access remain admission checks. */
export function readRepositoryWorkerProjectSnapshot(
  value: unknown,
  githubHost = resolveGitHubHost(),
): RepositoryWorkerProjectSnapshot | undefined {
  if (!isRecord(value) || value.source === undefined) {
    return undefined;
  }
  const parsed = RepositoryWorkerProjectSchema.safeParse(value);
  if (
    Object.keys(value).some(
      (key) => !["key", "baseCommit", "source", "preparation"].includes(key),
    ) ||
    !parsed.success ||
    parseProjectGitUrl(parsed.data.source.url, githubHost)?.url !== parsed.data.source.url
  ) {
    throw new Error("Worker environment has an invalid repository preparation snapshot");
  }
  return parsed.data;
}
