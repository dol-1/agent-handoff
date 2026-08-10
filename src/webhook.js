import { createHmac, timingSafeEqual } from 'node:crypto';

// Pure, side-effect-light evaluation of a Linear webhook delivery. Kept
// separate from HTTP/MCP wiring so every gate in DEMO-60's acceptance
// criteria (AC-3, AC-4, AC-6) is directly unit-testable.
//
// Returns either:
//   { accepted: true, normalizedEvent: {...} }
//   { accepted: false, reason: '<gate-name>' }

export function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  if (!secret) return false;

  const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex');

  let expected;
  let provided;
  try {
    expected = Buffer.from(expectedHex, 'hex');
    provided = Buffer.from(signatureHeader.trim(), 'hex');
  } catch {
    return false;
  }

  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

function isFreshTimestamp(webhookTimestampMs, now, windowMs) {
  if (typeof webhookTimestampMs !== 'number' || !Number.isFinite(webhookTimestampMs)) {
    return false;
  }
  return Math.abs(now - webhookTimestampMs) <= windowMs;
}

// A webhook whose current state happens to be Todo is not necessarily an
// entry into Todo — the issue may have been Todo already and merely had
// its title edited. Only treat it as "entered Todo" when Linear's payload
// says the state itself just changed: a fresh `create` directly into the
// target state, or an `update` whose `updatedFrom` includes `stateId`
// (Linear only includes a field in updatedFrom when that field changed).
function enteredTargetState(payload) {
  if (payload?.action === 'create') return true;
  if (payload?.action === 'update') {
    return Object.prototype.hasOwnProperty.call(payload?.updatedFrom ?? {}, 'stateId');
  }
  return false;
}

export function evaluateWebhook({ rawBody, headers, config, dedupStore, now = Date.now() }) {
  const signatureHeader = headers['linear-signature'];
  if (!verifySignature(rawBody, signatureHeader, config.webhookSecret)) {
    return { accepted: false, reason: 'invalid_signature' };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { accepted: false, reason: 'malformed_payload' };
  }

  if (!isFreshTimestamp(payload?.webhookTimestamp, now, config.timestampWindowMs)) {
    return { accepted: false, reason: 'stale_timestamp' };
  }

  const deliveryId = headers['linear-delivery'];
  if (!deliveryId || typeof deliveryId !== 'string') {
    return { accepted: false, reason: 'missing_delivery_id' };
  }
  if (dedupStore.checkAndRecord(deliveryId, now)) {
    return { accepted: false, reason: 'duplicate_delivery' };
  }

  const data = payload?.data;
  const teamId = data?.team?.id;
  const projectId = data?.project?.id;
  const stateName = data?.state?.name;
  const issueIdentifier = data?.identifier;
  const issueId = data?.id;
  const issueUrl = data?.url ?? payload?.url;

  if (payload?.type !== 'Issue' || !data || !issueIdentifier || !issueId) {
    return { accepted: false, reason: 'malformed_payload' };
  }

  if (teamId !== config.allowedTeamId) {
    return { accepted: false, reason: 'wrong_team' };
  }

  if (projectId !== config.allowedProjectId) {
    return { accepted: false, reason: 'wrong_project' };
  }

  if (stateName !== config.allowedTargetStateName) {
    return { accepted: false, reason: 'wrong_target_state' };
  }

  if (!enteredTargetState(payload)) {
    return { accepted: false, reason: 'not_a_state_transition' };
  }

  // Deliberately minimal: only trusted routing identifiers cross the
  // boundary into Claude's context. No title/description/comment/body text.
  const normalizedEvent = {
    event: 'issue_entered_todo',
    issueIdentifier,
    issueId,
    projectId,
    teamId,
    targetState: stateName,
    url: typeof issueUrl === 'string' ? issueUrl : undefined,
  };

  return { accepted: true, normalizedEvent };
}
