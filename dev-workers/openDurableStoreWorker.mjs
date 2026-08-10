// Worker process for durableStore.test.js's concurrent-startup regression
// test (DEMO-62 revision — busy_timeout-ordered-too-late defect). Unlike
// concurrentRecordDeliveryWorker.mjs (which races recordDelivery() against
// an already-initialized db file), this worker races the DurableStore
// CONSTRUCTOR itself — opening the connection, switching journal mode,
// and creating the schema — against a path that may not exist yet, which
// is the exact window where a connection with no busy_timeout configured
// could previously surface a raw SQLITE_BUSY / "database is locked" error
// instead of waiting.
//
// Deliberately lives outside test/ — node's `--test` auto-discovery treats
// any file inside a directory literally named `test` as a test file, which
// would otherwise execute this worker standalone (no argv) as a bogus,
// always-failing "test".

import { DurableStore } from '../src/durableStore.js';

const [, , dbPath] = process.argv;

const store = new DurableStore(dbPath);
store.close();
process.stdout.write('ok');
