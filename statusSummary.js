// SPDX-License-Identifier: GPL-3.0-or-later
//
// Pure status aggregation shared by the extension and its tests.

function nonNegativeCount(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

export function summarizeStatus(status = {}, targetEntries = []) {
    const helperPausedCount = nonNegativeCount(status.paused_count);
    const helperRunningCount = nonNegativeCount(status.running_count);
    const helperProtectedCount = nonNegativeCount(status.protected_count);
    const targetPausedCount = targetEntries.filter(entry => entry?.paused === true).length;
    const targetRunningCount = targetEntries.filter(entry =>
        entry?.service_active === true && entry?.paused !== true
    ).length;
    const targetProtectedCount = targetEntries.filter(entry => entry?.protected === true).length;

    return {
        strictPaused: status.paused === true,
        pauseIntent: status.pause_intent === true,
        pauseStateKnown: status.pause_state_known === true,
        pausedCount: helperPausedCount + targetPausedCount,
        runningCount: helperRunningCount + targetRunningCount,
        protectedCount: helperProtectedCount + targetProtectedCount,
    };
}
