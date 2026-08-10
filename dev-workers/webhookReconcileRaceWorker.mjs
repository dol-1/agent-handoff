// Worker process for durableStore.test.js's webhook-vs-reconciliation race
// regression test (DEMO-62 revision finding 3). Opens its own DurableStore
// connection to an already-existing db file and, depending on `mode`,
// races either a webhook-style recordDelivery() or a reconciliation-style
// upsertReconciledIssue() against the SAME issue identifier, from a
// genuinely separate OS process.
//
// Deliberately lives outside test/ — node's `--test` auto-discovery treats
// any file inside a directory literally named `test` as a test file, which
// would otherwise execute this worker standalone (no argv) as a bogus,
// always-failing "test".

import { DurableStore } from '../src/durableStore.js';

const [, , dbPath, mode, issueIdentifier] = process.argv;

const store = new DurableStore(dbPath);
let result;
try {
  if (mode === 'webhook') {
    result = store.recordDelivery({
      deliveryId: `webhook-${issueIdentifier}`,
      now: Date.now(),
      relevant: true,
      reason: 'accepted',
      issueIdentifier,
      normalizedEvent: {
        event: 'issue_entered_todo',
        issueIdentifier,
        issueId: 'race-issue',
        projectId: 'project-1',
        teamId: 'team-1',
        targetState: 'Todo',
      },
    });
  } else if (mode === 'reconcile') {
    result = store.upsertReconciledIssue({
      issueIdentifier,
      issueId: 'race-issue',
      projectId: 'project-1',
      teamId: 'team-1',
      targetState: 'Todo',
      url: null,
      now: Date.now(),
    });
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
} finally {
  store.close();
}
process.stdout.write(JSON.stringify(result));
