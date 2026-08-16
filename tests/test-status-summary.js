import { summarizeStatus } from '../statusSummary.js';

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
    }
}

let summary = summarizeStatus({
    paused: true,
    pause_intent: true,
    pause_state_known: true,
    paused_count: 19,
    running_count: 3,
}, [
    { managed: true, paused: false, service_active: false },
    { managed: true, paused: true, service_active: false },
    { managed: false, paused: false, service_active: true },
]);

assertEqual(summary.strictPaused, true, 'strict pause follows helper status');
assertEqual(summary.pauseStateKnown, true, 'helper state is marked known');
assertEqual(summary.pausedCount, 20, 'only actually paused targets are added');
assertEqual(summary.runningCount, 4, 'only active, unpaused targets are running');

summary = summarizeStatus({
    paused: false,
    pause_intent: true,
    pause_state_known: true,
    protected_count: 2,
}, [
    { protected: true, paused: false },
]);

assertEqual(summary.strictPaused, false, 'an unhealthy or inactive gate is not strict pause');
assertEqual(summary.pauseIntent, true, 'pause intent remains visible separately');
assertEqual(summary.protectedCount, 3, 'protected targets are counted separately');

print('Status summary tests passed');
