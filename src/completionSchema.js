// DEMO-62 one-shot-worker revision. Two versioned JSON Schemas passed
// verbatim to `claude --json-schema`, plus small hand-rolled validators.
//
// Per the Opus review: use the CLI's own `--output-format json
// --json-schema <schema>` structured-output support — do not invent a
// free-text completion sentinel and regex it out of the assistant reply.
// The CLI already enforces schema conformance before returning
// `structured_output`, but the worker independently re-validates here too
// (defense in depth: `structured_output` can legitimately be absent if the
// turn errored/was blocked before producing one, and the worker must not
// assume the CLI's enforcement was perfect).
//
// No JSON Schema validation library is added as a dependency — both
// schemas are small, fixed, and fully known ahead of time, so a targeted
// hand-rolled validator is simpler and dependency-free, consistent with
// this service's existing "no new deps unless justified" pattern
// (see durableStore.js choosing node:sqlite over an ORM/query builder).

export const COMPLETION_PROTOCOL_VERSION = 1;
export const RECONCILE_PROTOCOL_VERSION = 1;
export const REVIEW_PROTOCOL_VERSION = 1;

// DEMO-62 proof-derived correction (1 of 2, post DEMO-63 live proof): the
// approved contract only ever required a task-specific commit SHA for
// code-change tasks, but the original gate treated every `completed` as one.
// `completed_no_commit` is a second, equally terminal outcome for a genuine
// no-tracked-repo-change completion (e.g. a PR-description-only fix) — see
// claudeInvoker.js's evaluateCompletionResult() for the split gate this
// enables: `completed` still mandates a non-null commitSha; this new value
// mandates commitSha be exactly null instead of merely relaxing the check.
const COMPLETION_OUTCOMES = ['completed', 'completed_no_commit', 'blocked', 'not_eligible', 'failed'];

// Sent to `--json-schema` verbatim for a per-issue execution turn.
//
// DEMO-62 revision, finding 2: verifiedTeamId/verifiedProjectId/
// verifiedPickupState require the agent to report the scope it actually
// found on Linear (not this notification's claims) — queue admission
// already gates team/project/state at ingestion, but the standing
// canonical-re-fetch rule must not depend solely on that; evaluateCompletionResult()
// in claudeInvoker.js fails a `completed` outcome closed unless these match
// the worker's configured allowed scope. Nullable because a `blocked`/
// `failed` turn may never have reached a point where it could report them.
export const completionJsonSchema = {
  type: 'object',
  properties: {
    protocolVersion: { type: 'integer' },
    issueIdentifier: { type: 'string' },
    outcome: { type: 'string', enum: COMPLETION_OUTCOMES },
    canonicalStatus: { type: 'string' },
    resultPosted: { type: 'boolean' },
    commitSha: { type: ['string', 'null'] },
    verifiedTeamId: { type: ['string', 'null'] },
    verifiedProjectId: { type: ['string', 'null'] },
    verifiedPickupState: { type: ['string', 'null'] },
    summary: { type: 'string' },
  },
  required: [
    'protocolVersion',
    'issueIdentifier',
    'outcome',
    'canonicalStatus',
    'resultPosted',
    'commitSha',
    'verifiedTeamId',
    'verifiedProjectId',
    'verifiedPickupState',
    'summary',
  ],
  additionalProperties: false,
};

// Sent to `--json-schema` verbatim for the startup/periodic reconciliation
// turn. Deliberately mirrors webhookClassifier.js's normalizedEvent shape
// (issueIdentifier/issueId/url only) so no Linear title/description/
// comment/free text can ever be represented, let alone captured.
export const reconciliationJsonSchema = {
  type: 'object',
  properties: {
    protocolVersion: { type: 'integer' },
    teamId: { type: 'string' },
    projectId: { type: 'string' },
    targetState: { type: 'string' },
    eligibleIssues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          issueIdentifier: { type: 'string' },
          issueId: { type: 'string' },
          url: { type: ['string', 'null'] },
        },
        required: ['issueIdentifier', 'issueId', 'url'],
        additionalProperties: false,
      },
    },
  },
  required: ['protocolVersion', 'teamId', 'projectId', 'targetState', 'eligibleIssues'],
  additionalProperties: false,
};

// DEMO-65 v1C. Sent to `--json-schema` verbatim for the Opus review turn.
// Deliberately mirrors completionJsonSchema's shape (minus commitSha, which
// only ever applies to the execute leg's code-change gate) so the two
// contracts stay easy to compare — a review never produces a repository
// commit itself, only a pass/revision_required/needs_human decision plus
// the Linear comment/state-transition action the prompt requires the turn
// to take itself.
const REVIEW_OUTCOMES = ['pass', 'revision_required', 'needs_human', 'blocked', 'failed'];

// DEMO-65 proof-derived correction: `reviewActionToken` closes the crash gap
// between Opus mutating Linear (posting its comment, transitioning state)
// and this worker durably committing markReviewDelivered() locally. The
// worker computes this token deterministically from the issue's trusted
// cycle_id + revision_count *before* spawning the turn (see worker.js's
// computeReviewActionToken()) and gives it to the prompt; the turn must
// echo it back verbatim, whether it's making a fresh decision or recovering
// one it (or a crashed prior attempt) already took externally — see
// buildReviewPrompt() for the recovery instructions and
// evaluateReviewResult() for why a mismatched token fails closed rather
// than silently finalizing a stale/wrong action.
export const reviewJsonSchema = {
  type: 'object',
  properties: {
    protocolVersion: { type: 'integer' },
    issueIdentifier: { type: 'string' },
    outcome: { type: 'string', enum: REVIEW_OUTCOMES },
    canonicalStatus: { type: 'string' },
    resultPosted: { type: 'boolean' },
    verifiedTeamId: { type: ['string', 'null'] },
    verifiedProjectId: { type: ['string', 'null'] },
    verifiedPickupState: { type: ['string', 'null'] },
    reviewActionToken: { type: 'string' },
    summary: { type: 'string' },
  },
  required: [
    'protocolVersion',
    'issueIdentifier',
    'outcome',
    'canonicalStatus',
    'resultPosted',
    'verifiedTeamId',
    'verifiedProjectId',
    'verifiedPickupState',
    'reviewActionToken',
    'summary',
  ],
  additionalProperties: false,
};

function fail(errors, message) {
  errors.push(message);
  return errors;
}

// Returns { valid: boolean, errors: string[] }. Never throws.
export function validateCompletionOutput(value) {
  const errors = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { valid: false, errors: fail(errors, 'structured_output is not an object') };
  }
  if (value.protocolVersion !== COMPLETION_PROTOCOL_VERSION) {
    fail(errors, `protocolVersion must be ${COMPLETION_PROTOCOL_VERSION}, got ${JSON.stringify(value.protocolVersion)}`);
  }
  if (typeof value.issueIdentifier !== 'string' || value.issueIdentifier === '') {
    fail(errors, 'issueIdentifier must be a non-empty string');
  }
  if (!COMPLETION_OUTCOMES.includes(value.outcome)) {
    fail(errors, `outcome must be one of ${COMPLETION_OUTCOMES.join('|')}, got ${JSON.stringify(value.outcome)}`);
  }
  if (typeof value.canonicalStatus !== 'string' || value.canonicalStatus === '') {
    fail(errors, 'canonicalStatus must be a non-empty string');
  }
  if (typeof value.resultPosted !== 'boolean') {
    fail(errors, 'resultPosted must be a boolean');
  }
  if (!(value.commitSha === null || typeof value.commitSha === 'string')) {
    fail(errors, 'commitSha must be a string or null');
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'verifiedTeamId') || !(value.verifiedTeamId === null || typeof value.verifiedTeamId === 'string')) {
    fail(errors, 'verifiedTeamId is required and must be a string or null');
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'verifiedProjectId') || !(value.verifiedProjectId === null || typeof value.verifiedProjectId === 'string')) {
    fail(errors, 'verifiedProjectId is required and must be a string or null');
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'verifiedPickupState') || !(value.verifiedPickupState === null || typeof value.verifiedPickupState === 'string')) {
    fail(errors, 'verifiedPickupState is required and must be a string or null');
  }
  if (typeof value.summary !== 'string') {
    fail(errors, 'summary must be a string');
  }
  const allowedKeys = new Set([
    'protocolVersion',
    'issueIdentifier',
    'outcome',
    'canonicalStatus',
    'resultPosted',
    'commitSha',
    'verifiedTeamId',
    'verifiedProjectId',
    'verifiedPickupState',
    'summary',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) fail(errors, `unexpected property "${key}"`);
  }
  return { valid: errors.length === 0, errors };
}

export function validateReconciliationOutput(value) {
  const errors = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { valid: false, errors: fail(errors, 'structured_output is not an object') };
  }
  if (value.protocolVersion !== RECONCILE_PROTOCOL_VERSION) {
    fail(errors, `protocolVersion must be ${RECONCILE_PROTOCOL_VERSION}, got ${JSON.stringify(value.protocolVersion)}`);
  }
  for (const key of ['teamId', 'projectId', 'targetState']) {
    if (typeof value[key] !== 'string' || value[key] === '') fail(errors, `${key} must be a non-empty string`);
  }
  if (!Array.isArray(value.eligibleIssues)) {
    fail(errors, 'eligibleIssues must be an array');
  } else {
    value.eligibleIssues.forEach((issue, i) => {
      if (typeof issue !== 'object' || issue === null) {
        fail(errors, `eligibleIssues[${i}] is not an object`);
        return;
      }
      if (typeof issue.issueIdentifier !== 'string' || issue.issueIdentifier === '') {
        fail(errors, `eligibleIssues[${i}].issueIdentifier must be a non-empty string`);
      }
      if (typeof issue.issueId !== 'string' || issue.issueId === '') {
        fail(errors, `eligibleIssues[${i}].issueId must be a non-empty string`);
      }
      // DEMO-62 revision, finding 6: the schema requires `url` on every
      // issue entry (required: [..., 'url']) — the hand-rolled validator
      // must enforce the key's presence too, not just its type, or it's
      // weaker than the contract it claims to defense-in-depth re-check.
      if (!Object.prototype.hasOwnProperty.call(issue, 'url') || !(issue.url === null || typeof issue.url === 'string')) {
        fail(errors, `eligibleIssues[${i}].url is required and must be a string or null`);
      }
      const allowed = new Set(['issueIdentifier', 'issueId', 'url']);
      for (const key of Object.keys(issue)) {
        if (!allowed.has(key)) fail(errors, `eligibleIssues[${i}] has unexpected property "${key}"`);
      }
    });
  }
  const allowedKeys = new Set(['protocolVersion', 'teamId', 'projectId', 'targetState', 'eligibleIssues']);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) fail(errors, `unexpected property "${key}"`);
  }
  return { valid: errors.length === 0, errors };
}

// DEMO-65 v1C. Structurally identical validation shape to
// validateCompletionOutput() minus the commitSha field — see reviewJsonSchema
// above for why. Never throws.
export function validateReviewOutput(value) {
  const errors = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { valid: false, errors: fail(errors, 'structured_output is not an object') };
  }
  if (value.protocolVersion !== REVIEW_PROTOCOL_VERSION) {
    fail(errors, `protocolVersion must be ${REVIEW_PROTOCOL_VERSION}, got ${JSON.stringify(value.protocolVersion)}`);
  }
  if (typeof value.issueIdentifier !== 'string' || value.issueIdentifier === '') {
    fail(errors, 'issueIdentifier must be a non-empty string');
  }
  if (!REVIEW_OUTCOMES.includes(value.outcome)) {
    fail(errors, `outcome must be one of ${REVIEW_OUTCOMES.join('|')}, got ${JSON.stringify(value.outcome)}`);
  }
  if (typeof value.canonicalStatus !== 'string' || value.canonicalStatus === '') {
    fail(errors, 'canonicalStatus must be a non-empty string');
  }
  if (typeof value.resultPosted !== 'boolean') {
    fail(errors, 'resultPosted must be a boolean');
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'verifiedTeamId') || !(value.verifiedTeamId === null || typeof value.verifiedTeamId === 'string')) {
    fail(errors, 'verifiedTeamId is required and must be a string or null');
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'verifiedProjectId') || !(value.verifiedProjectId === null || typeof value.verifiedProjectId === 'string')) {
    fail(errors, 'verifiedProjectId is required and must be a string or null');
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'verifiedPickupState') || !(value.verifiedPickupState === null || typeof value.verifiedPickupState === 'string')) {
    fail(errors, 'verifiedPickupState is required and must be a string or null');
  }
  // Unlike verifiedTeamId/etc (nullable — a blocked/failed turn may never
  // have reached a point where it could verify them), reviewActionToken is
  // never nullable: it is handed to the turn up front in the prompt, before
  // any work happens, so it must always be echoed back exactly, even for
  // blocked/failed.
  if (typeof value.reviewActionToken !== 'string' || value.reviewActionToken === '') {
    fail(errors, 'reviewActionToken is required and must be a non-empty string');
  }
  if (typeof value.summary !== 'string') {
    fail(errors, 'summary must be a string');
  }
  const allowedKeys = new Set([
    'protocolVersion',
    'issueIdentifier',
    'outcome',
    'canonicalStatus',
    'resultPosted',
    'verifiedTeamId',
    'verifiedProjectId',
    'verifiedPickupState',
    'reviewActionToken',
    'summary',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) fail(errors, `unexpected property "${key}"`);
  }
  return { valid: errors.length === 0, errors };
}
