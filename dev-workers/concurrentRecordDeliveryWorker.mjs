// Worker process for durableStore.test.js's two-process race regression
// test (DEMO-62 revision item 5). Opens its own DurableStore connection to
// an already-existing db file and races other same-named workers to call
// recordDelivery() for the same delivery id. Prints the result as one JSON
// line so the parent test can assert every worker completed deterministic
// (never a thrown/500-equivalent error) regardless of arrival order.
//
// Deliberately lives outside test/ — node's `--test` auto-discovery treats
// any file inside a directory literally named `test` as a test file, which
// would otherwise execute this worker standalone (no argv) as a bogus,
// always-failing "test".

import { DurableStore } from '../src/durableStore.js';

const [, , dbPath, deliveryId] = process.argv;

const store = new DurableStore(dbPath);
try {
  const result = store.recordDelivery({
    deliveryId,
    now: Date.now(),
    relevant: true,
    reason: 'accepted',
    issueIdentifier: 'DEMO-62',
    normalizedEvent: {
      event: 'issue_entered_todo',
      issueIdentifier: 'DEMO-62',
      issueId: 'race-issue',
      projectId: 'project-1',
      teamId: 'team-1',
      targetState: 'Todo',
    },
  });
  process.stdout.write(JSON.stringify(result));
} finally {
  store.close();
}
