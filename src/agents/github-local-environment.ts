import { tempWorkspace } from "@openclaw/fs-safe/temp";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasWorkerGitHubAppConfiguration,
  issueWorkerGitHubInstallationToken,
} from "../gateway/worker-environments/worker-github-installation-token.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/temp-download.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import { normalizeGitHubLogin } from "../utils/github-login.js";
import {
  readAdmittedRunOperatorAuthority,
  type AdmittedRunContext,
} from "./admitted-run-context.js";
import { resolveGitHubApiBaseUrl, resolveGitHubHost } from "./github-host.js";
import {
  managedGitHubIdentityEnvironment,
  resolveConfiguredGitHubToolIdentity,
  writeManagedGitHubProfileFiles,
} from "./github-tool-identity.js";

/** A local native run owns its profile; the shared harness process never receives it. */
export async function prepareLocalGitHubEnvironment(params: {
  admittedRunContext: AdmittedRunContext;
  agentId?: string;
  config?: OpenClawConfig;
  assertCurrent: () => void;
  signal: AbortSignal;
}) {
  if (!hasWorkerGitHubAppConfiguration()) return undefined;
  if (
    params.agentId &&
    params.config &&
    resolveConfiguredGitHubToolIdentity({
      config: params.config,
      agentId: params.agentId,
      scope: "agent",
    })
  ) {
    return undefined;
  }
  params.assertCurrent();
  const operator = readAdmittedRunOperatorAuthority(params.admittedRunContext);
  if (!operator) return undefined;
  operator.assertCurrent();
  const profile = await prepareUserProfileIdentity(operator.profileId);
  const signal = operator.signal
    ? AbortSignal.any([params.signal, operator.signal])
    : params.signal;
  let grant: Awaited<ReturnType<typeof issueWorkerGitHubInstallationToken>>;
  let workspace: Awaited<ReturnType<typeof tempWorkspace>> | undefined;
  let released = false;
  let cleanup: Promise<void> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    released = true;
    clearTimeout(expiry);
    signal.removeEventListener("abort", onAbort);
    return (cleanup ??= (async () => {
      try {
        await grant?.revoke();
      } finally {
        try {
          await workspace?.cleanup();
        } finally {
          profile.release();
        }
      }
    })());
  };
  // Finalization awaits this same promise and reports any cleanup failure.
  const onAbort = () => {
    void dispose().catch(() => undefined);
  };
  let bindingIds: readonly string[] = [];
  const assertCurrent = () => {
    params.assertCurrent();
    signal.throwIfAborted();
    operator.assertCurrent();
    profile.readCurrentFacts(bindingIds);
    if (released || (grant && Date.now() >= grant.expiresAtMs)) {
      throw new Error("Local GitHub credential lifetime has ended");
    }
  };
  try {
    bindingIds = profile.emailBindingIds;
    assertCurrent();
    const host = resolveGitHubHost();
    // Factory's authenticated proxy binds an immutable host/account principal to
    // this profile. Display names, commit email, and the App actor are not a user.
    const prefix = `github:${host}:`;
    const accounts = profile
      .readCurrentFacts(bindingIds)
      .profile.emails.filter((value) => value.startsWith(prefix))
      .map((value) => value.slice(prefix.length));
    if (accounts.length !== 1 || !/^[1-9][0-9]*$/u.test(accounts[0]!)) {
      throw new Error("Local GitHub credentials require the signed-in GitHub account binding");
    }
    const accountId = Number(accounts[0]);
    if (!Number.isSafeInteger(accountId)) throw new Error("Invalid GitHub account binding");
    grant = await issueWorkerGitHubInstallationToken({ signal });
    assertCurrent();
    if (!grant) {
      await dispose();
      return undefined;
    }
    const response = await fetch(`${resolveGitHubApiBaseUrl()}/user/${accountId}`, {
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      headers: { authorization: `Bearer ${grant.token}`, accept: "application/vnd.github+json" },
    });
    if (!response.ok) {
      void response.body?.cancel();
      throw new Error("The signed-in GitHub account could not be resolved");
    }
    const identity: unknown = await response.json();
    const record =
      identity && typeof identity === "object" ? (identity as Record<string, unknown>) : {};
    const login = typeof record.login === "string" ? normalizeGitHubLogin(record.login) : undefined;
    if (record.id !== accountId || !login) throw new Error("GitHub account identity did not match");
    assertCurrent();
    workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "github-local-run-",
    });
    await writeManagedGitHubProfileFiles(workspace.dir, {
      host,
      login: "x-access-token",
      token: grant.token,
    });
    assertCurrent();
    signal.addEventListener("abort", onAbort, { once: true });
    expiry = setTimeout(onAbort, Math.max(0, grant.expiresAtMs - Date.now()));
    expiry.unref?.();
    return {
      assertCurrent,
      dispose,
      instructions: `Local git and gh use a run-scoped GitHub App installation credential for ${host}. The authenticated requesting user's verified login is ${login}; use that explicit login for assignee filters, never App @me or gh api user. Credentials expire and are removed at run completion, including for detached commands.`,
      env: {
        ...managedGitHubIdentityEnvironment({
          profileDir: workspace.dir,
          gitConfig: [
            ["credential.helper", ""],
            ["credential.helper", "!gh auth git-credential"],
          ],
        }),
        GH_HOST: host,
        OPENCLAW_GATEWAY_PASSWORD: "",
        GITHUB_APP_PRIVATE_KEY: "",
        GH_TOKEN: "",
        GH_ENTERPRISE_TOKEN: "",
        GITHUB_TOKEN: "",
        GITHUB_ENTERPRISE_TOKEN: "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
        OPENCLAW_GITHUB_USER_LOGIN: login,
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
