// v1B pure webhook classification (DEMO-62 sections A/B). Separate from
// webhook.js's `evaluateWebhook` (left untouched — it still backs the live
// v1A combined process in server.js). This module reuses the same signature
// primitive but returns a richer, three-way result so the HTTP layer
// (ingressReceiver.js) can apply the corrected Linear response semantics:
//
//   verified: false  -> never touches the durable store; explicit non-200
//   verified: true, relevant: false -> durably recorded as 'ignored'; HTTP 200
//   verified: true, relevant: true  -> durably recorded as 'accepted' + queued; HTTP 200
//
// No IO here — dedup/persistence is the durable store's job, called by the
// HTTP layer after classification, so the two can commit atomically.

import { verifySignature } from './webhook.js';

// DEMO-65 v1C: a verified transition into Todo creates job_type=execute.
// A verified transition into In Review creates job_type=review unless
// AGENT_HANDOFF_REVIEW_MODE=external, in which case In Review is deliberately
// outside this worker's automation scope and is left to an external reviewer.
export const REVIEW_TARGET_STATE_NAME = 'In Review';
export const DONE_STATE_NAME = 'Done';

function jobTypeForState(stateName, config) {
  if (stateName === config.allowedTargetStateName) return 'execute';
  if (stateName === REVIEW_TARGET_STATE_NAME && config.reviewMode !== 'external') return 'review';
  return null;
}

function enteredTargetState(payload) {
  if (payload?.action === 'create') return true;
  if (payload?.action === 'update') {
    return Object.prototype.hasOwnProperty.call(payload?.updatedFrom ?? {}, 'stateId');
  }
  return false;
}

function isFreshTimestamp(webhookTimestampMs, now, windowMs) {
  if (typeof webhookTimestampMs !== 'number' || !Number.isFinite(webhookTimestampMs)) {
    return false;
  }
  return Math.abs(now - webhookTimestampMs) <= windowMs;
}

// reason -> HTTP status for the `verified: false` branch (never queued).
export const UNVERIFIED_HTTP_STATUS = {
  invalid_signature: 401,
  stale_timestamp: 401,
  malformed_payload: 400,
  missing_delivery_id: 400,
};

export function classifyWebhook({ rawBody, headers, config, now = Date.now() }) {
  const signatureHeader = headers['linear-signature'];
  if (!verifySignature(rawBody, signatureHeader, config.webhookSecret)) {
    return { verified: false, reason: 'invalid_signature' };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { verified: false, reason: 'malformed_payload' };
  }

  if (!isFreshTimestamp(payload?.webhookTimestamp, now, config.timestampWindowMs)) {
    return { verified: false, reason: 'stale_timestamp' };
  }

  const deliveryId = headers['linear-delivery'];
  if (!deliveryId || typeof deliveryId !== 'string') {
    return { verified: false, reason: 'missing_delivery_id' };
  }

  const data = payload?.data;
  const teamId = data?.team?.id;
  const projectId = data?.project?.id;
  const stateName = data?.state?.name;
  const issueIdentifier = data?.identifier;
  const issueId = data?.id;
  const issueUrl = data?.url ?? payload?.url;

  if (payload?.type !== 'Issue' || !data || !issueIdentifier || !issueId) {
    return { verified: true, deliveryId, relevant: false, reason: 'malformed_payload' };
  }

  if (teamId !== config.allowedTeamId) {
    return { verified: true, deliveryId, relevant: false, reason: 'wrong_team', issueIdentifier };
  }

  if (projectId !== config.allowedProjectId) {
    return { verified: true, deliveryId, relevant: false, reason: 'wrong_project', issueIdentifier };
  }

  const jobType = jobTypeForState(stateName, config);
  if (!jobType) {
    return {
      verified: true,
      deliveryId,
      relevant: false,
      reason: 'wrong_target_state',
      issueIdentifier,
    };
  }

  if (!enteredTargetState(payload)) {
    return {
      verified: true,
      deliveryId,
      relevant: false,
      reason: 'not_a_state_transition',
      issueIdentifier,
    };
  }

  // Deliberately minimal: only trusted routing identifiers cross the
  // boundary into the durable queue / Claude's context. No title/
  // description/comment/body text.
  const normalizedEvent = {
    event: jobType === 'review' ? 'issue_entered_review' : 'issue_entered_todo',
    issueIdentifier,
    issueId,
    projectId,
    teamId,
    targetState: stateName,
    jobType,
    url: typeof issueUrl === 'string' ? issueUrl : undefined,
  };

  return {
    verified: true,
    deliveryId,
    relevant: true,
    reason: 'accepted',
    issueIdentifier,
    normalizedEvent,
  };
}
