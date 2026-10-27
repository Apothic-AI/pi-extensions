// Closed, source-free diagnostics. Never attach a provider error or its cause.
const FAILURE_CODES = [
  "authentication_failed",
  "authentication_timeout",
  "credentials_unavailable",
  "provider_unavailable",
  "checkpoint_malformed",
  "checkpoint_incompatible",
  "checkpoint_projection_failed",
  "loadout_mismatch",
  "state_divergence",
  "remote_http_error",
  "remote_timeout",
  "remote_transport_error",
  "remote_provider_error",
  "remote_context_window_exceeded",
  "segmentation_unsupported",
  "remote_attempt_budget_exhausted",
  "payload_rejected",
  "remote_response_invalid",
  "local_compaction_failed",
] as const;
export type CompactionFailureCode = (typeof FAILURE_CODES)[number];

// Cancellation is not a provider failure. These strings contain no operation
// identifiers and are shown only while the same non-aborted owner is current.
const CANCELLATION_DIAGNOSTICS = {
  canonical_consent_required: "[canonical_consent_required] Canonical-history authorization is required.",
  canonical_consent_denied: "[canonical_consent_denied] Canonical history was not authorized.",
  preparation_model_changed: "[preparation_model_changed] The active model changed after compaction preparation.",
  preparation_branch_changed: "[preparation_branch_changed] The active branch changed after compaction preparation.",
} as const;
export type CompactionCancellationCode = keyof typeof CANCELLATION_DIAGNOSTICS;

export function formatCompactionCancellation(code: CompactionCancellationCode): string {
  return CANCELLATION_DIAGNOSTICS[code];
}

export interface CompactionFailure {
  readonly code: CompactionFailureCode;
  readonly httpStatus?: number;
}

// Only errors created here carry diagnostics. Do not inspect arbitrary error
// properties (even message/name/status getters can contain sensitive data).
const failures = new WeakMap<object, CompactionFailure>();

export function compactionFailure(code: CompactionFailureCode, httpStatus?: number): CompactionFailure {
  return Object.freeze({
    code: FAILURE_CODES.includes(code) ? code : "local_compaction_failed",
    ...(code === "remote_http_error" &&
    typeof httpStatus === "number" &&
    Number.isInteger(httpStatus) &&
    httpStatus >= 100 &&
    httpStatus <= 599
      ? { httpStatus }
      : {}),
  });
}

export function formatCompactionFailure(failure: CompactionFailure): string {
  return `[${failure.code}${failure.httpStatus === undefined ? "" : `; HTTP ${failure.httpStatus}`}]`;
}

export function compactionError(code: CompactionFailureCode, httpStatus?: number): Error {
  const failure = compactionFailure(code, httpStatus);
  const error = new Error(`OpenAI Codex compaction request failed ${formatCompactionFailure(failure)}`);
  failures.set(error, failure);
  return error;
}

export function failureFrom(error: unknown, fallback: CompactionFailureCode): CompactionFailure {
  return (typeof error === "object" && error !== null && failures.get(error)) || compactionFailure(fallback);
}

const cancellations = new WeakSet<object>();

export function isCompactionAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && cancellations.has(error);
}

export function compactionAbortError(): DOMException {
  const error = new DOMException("Compaction aborted", "AbortError");
  cancellations.add(error);
  return error;
}
