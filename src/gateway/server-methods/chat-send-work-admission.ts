import { err, ok } from "@openclaw/normalization-core/result";
import { hasPendingFollowupQueueWork } from "../../auto-reply/reply/queue/state.js";
import {
  interruptReplyRunTarget,
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  replyRunRegistry,
} from "../../auto-reply/reply/reply-run-registry.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { retireProviderReviewAcknowledgment } from "../../sessions/provider-review.js";
import {
  isCompetingSessionWorkAdmissionActive,
  interruptSessionWorkAdmissions,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";
import type { registerChatAbortController } from "../chat-abort.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "../operator-role-policy.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { loadSessionEntry } from "../session-utils.js";
import { captureGatewayClientUploadCommitGuard } from "../upload-policy.js";
import { formatForLog } from "../ws-log.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

/** New input is checked only after the chat owner has reconciled prior receipts. */
export function admitChatSendUploads({
  params,
  client,
  context,
  respond,
  onRejected,
}: Pick<GatewayRequestHandlerOptions, "params" | "client" | "context" | "respond"> & {
  onRejected?: () => void;
}) {
  try {
    const assertClientUploadAllowed = captureGatewayClientUploadCommitGuard({
      method: "chat.send",
      requestParams: params,
      client,
      context,
    });
    assertClientUploadAllowed?.();
    return { ok: true as const, assertClientUploadAllowed };
  } catch (error) {
    onRejected?.();
    if (!(error instanceof SessionMutationAuthorizationChangedError)) {
      throw error;
    }
    respond(false, undefined, error.error);
    return { ok: false as const };
  }
}

/** Caller and physical target custody end together when admitted work settles. */
export function releaseChatSendCallerAuthority(params: {
  operator: { release?: () => void };
  request: Pick<NormalizedChatSendRequest, "providerReviewAcknowledgment">;
  session: Pick<PreparedChatSendSession, "releaseSessionTarget">;
}): void {
  try {
    params.operator.release?.();
  } finally {
    try {
      if (params.request.providerReviewAcknowledgment) {
        retireProviderReviewAcknowledgment(params.request.providerReviewAcknowledgment);
      }
    } finally {
      params.session.releaseSessionTarget();
    }
  }
}

/** Observe started work before the retained read releases; consuming still rethrows its error. */
export function observeChatSendWork<T>(work: Promise<T>): () => Promise<T> {
  const outcome = work.then(ok<T, unknown>, err<T, unknown>);
  return async () => {
    const result = await outcome;
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  };
}

/** Interrupt the captured run, or competing admissions, without ever targeting this admission. */
export function interruptChatSendWork(params: {
  target: ReturnType<typeof replyRunRegistry.resolveCurrentInterruptTarget>;
  signal: AbortSignal;
  admission: Pick<SessionWorkAdmissionLease, "run">;
  storePath: string;
  identities: Array<string | undefined>;
}) {
  params.signal.throwIfAborted();
  if (params.target) {
    return interruptReplyRunTarget(params.target, REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS).then(
      ({ settled }) => ({ interrupted: true, settled }),
    );
  }
  return params.admission.run(async () => {
    if (!isCompetingSessionWorkAdmissionActive(params.storePath, params.identities)) {
      return { interrupted: false, settled: true };
    }
    return {
      interrupted: true,
      settled: await interruptSessionWorkAdmissions({
        scope: params.storePath,
        identities: params.identities,
        timeoutMs: REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
      }),
    };
  });
}

/** Queued and collected turns share the original session and caller admission until settlement. */
export function createChatSendWorkAdmission(params: {
  admission: Pick<SessionWorkAdmissionLease, "release">;
  releaseCallerAuthority?: () => void;
  logGateway: Pick<GatewayRequestContext["logGateway"], "warn">;
}) {
  let references = 1;
  let finishPendingInput: (() => void) | undefined;
  const release = () => {
    if (references === 0) {
      return;
    }
    references -= 1;
    if (references !== 0) {
      return;
    }
    try {
      finishPendingInput?.();
    } catch (error) {
      // The durable row remains recoverable; a failed disposition write must
      // not strand session/root drain ownership during shutdown.
      params.logGateway.warn(`Failed to finish pending chat input: ${formatForLog(error)}`);
    } finally {
      try {
        params.admission.release();
      } finally {
        params.releaseCallerAuthority?.();
      }
    }
  };
  const hold = () => {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      release();
    };
  };
  return {
    isActive: () => references > 0,
    release: hold(),
    retain: () => {
      if (references === 0) {
        throw new Error("cannot retain a released chat work admission");
      }
      references += 1;
      return hold();
    },
    setPendingInputCleanup: (finish: () => void) => {
      finishPendingInput = finish;
    },
  };
}

/** Rechecked inside the session writer barrier before exclusive input is admitted. */
export function assertChatSendExclusiveAdmission(
  request: NormalizedChatSendRequest,
  session: PreparedChatSendSession,
): void {
  if (!request.goalOperation && !request.providerReviewAcknowledgment) {
    return;
  }
  const { storePath, sessionKey, backingSessionId, activeRunScopeKey } = session;
  if (
    isCompetingSessionWorkAdmissionActive(storePath, [sessionKey, backingSessionId]) ||
    hasPendingFollowupQueueWork([sessionKey, backingSessionId, activeRunScopeKey]) ||
    replyRunRegistry.isActive(activeRunScopeKey)
  ) {
    throw new Error(
      request.providerReviewAcknowledgment
        ? "The session still has active work. Review its status before continuing."
        : "goal-session-busy",
    );
  }
}

/** Goal and initial-session policy are revalidated in the same input writer barrier. */
export function createChatSendGoalCommitGuard(
  params: Pick<
    GatewayRequestHandlerOptions,
    "client" | "context" | "sessionMutationAuthorization" | "sessionMutationCommitGuard"
  > & {
    admission: {
      initialSessionEntry?: SessionEntry;
      assertInitialSkillSelection?: () => void;
      activeRunAbort: Pick<ReturnType<typeof registerChatAbortController>, "controller">;
      lifecycleGeneration: ReturnType<typeof getAgentEventLifecycleGeneration>;
    };
    session: Pick<
      PreparedChatSendSession,
      | "agentId"
      | "sessionLoadKey"
      | "sessionLoadOptions"
      | "sessionKey"
      | "storePath"
      | "sessionRoutingChanged"
    >;
  },
): () => void {
  const {
    admission,
    session,
    client,
    context,
    sessionMutationAuthorization,
    sessionMutationCommitGuard,
  } = params;
  return () => {
    sessionMutationCommitGuard?.();
    sessionMutationAuthorization?.assertCurrent();
    const currentConfig = context.getRuntimeConfig();
    const initialEntry = admission.initialSessionEntry;
    if (initialEntry) {
      admission.assertInitialSkillSelection?.();
      // Missing targets have no sharing owner yet; revalidate their creator before SQL commit.
      const currentTarget = loadSessionEntry(session.sessionLoadKey, session.sessionLoadOptions);
      if (
        currentTarget.storePath !== session.storePath ||
        currentTarget.canonicalKey !== session.sessionKey
      ) {
        throw new Error("Session routing changed before Goal admission; refresh and retry.");
      }
      const creationError = authorizeGatewaySessionCreation({
        cfg: currentConfig,
        client,
        agentId: session.agentId,
      });
      if (creationError) {
        throw new SessionMutationAuthorizationChangedError(creationError);
      }
      const creation = resolveOperatorSessionCreation(client);
      if (
        creation.actor?.id !== initialEntry.createdActor?.id ||
        resolveCreatorSandbox(currentConfig, creation) !== initialEntry.sandbox
      ) {
        throw new Error("Session creation policy changed before Goal admission; retry.");
      }
    }
    if (
      admission.activeRunAbort.controller.signal.aborted ||
      admission.lifecycleGeneration !== getAgentEventLifecycleGeneration() ||
      session.sessionRoutingChanged(currentConfig)
    ) {
      throw new Error("Goal admission changed before commit; refresh and retry.");
    }
  };
}
