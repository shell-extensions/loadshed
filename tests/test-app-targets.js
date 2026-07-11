import Gio from 'gi://Gio';
import { AppTargets } from '../appTargets.js';

const managerSettings = new Gio.Settings({
    schema_id: 'org.gnome.shell.extensions.service-pauser',
});

class FakeRunner {
    constructor(running = []) {
        this.running = new Set(running);
        this.started = [];
        this.stopped = [];
    }

    async isFlatpakRunning(appId) {
        return this.running.has(`flatpak:${appId}`);
    }

    async stopFlatpak(appId) {
        this.stopped.push(`flatpak:${appId}`);
        this.running.delete(`flatpak:${appId}`);
        return true;
    }

    async isSnapRunning(appId) {
        return this.running.has(`snap:${appId}`);
    }

    async stopSnap(appId) {
        this.stopped.push(`snap:${appId}`);
        this.running.delete(`snap:${appId}`);
        return true;
    }

    startCommand(command) {
        this.started.push(command);
        return true;
    }
}

const signalTarget = {
    id: 'signal',
    label: 'Signal',
    kind: 'flatpak',
    app_id: 'org.signal.Signal',
    desktop_id: 'org.signal.Signal.desktop',
    enabled: true,
};

const snapTarget = {
    id: 'snap-chat',
    label: 'Snap chat',
    kind: 'snap',
    app_id: 'chat-app',
    enabled: true,
};

const traySnapTarget = {
    id: 'tray-chat',
    label: 'Tray chat',
    kind: 'snap',
    app_id: 'tray-chat',
    command: 'snap run tray-chat --start-in-tray',
    enabled: true,
};

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
    }
}

function assertArrayEqual(actual, expected, message) {
    const actualJson = JSON.stringify(actual);
    const expectedJson = JSON.stringify(expected);
    if (actualJson !== expectedJson) {
        throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
    }
}

function reset(targets) {
    managerSettings.set_string('app-targets', JSON.stringify(targets));
    managerSettings.set_string('app-runtime-state', '{"paused":{}}');
}

reset([signalTarget, snapTarget]);
let runner = new FakeRunner(['flatpak:org.signal.Signal', 'snap:chat-app']);
let manager = new AppTargets(managerSettings, runner);
await manager.applyPause();
assertArrayEqual(
    runner.stopped,
    ['flatpak:org.signal.Signal', 'snap:chat-app'],
    'pause stops running Flatpak and Snap apps'
);
let status = await manager.status();
assertEqual(status[0].managed, true, 'Flatpak target is managed after pause');
assertEqual(status[1].managed, true, 'Snap target is managed after pause');
manager.applyResume();
assertArrayEqual(
    runner.started,
    ['flatpak run org.signal.Signal', 'snap run chat-app'],
    'resume restarts apps with default commands when no command override is configured'
);

reset([traySnapTarget]);
runner = new FakeRunner(['snap:tray-chat']);
manager = new AppTargets(managerSettings, runner);
await manager.applyPause();
manager.applyResume();
assertArrayEqual(
    runner.started,
    ['snap run tray-chat --start-in-tray'],
    'resume uses a configured command override'
);

reset([signalTarget]);
runner = new FakeRunner([]);
manager = new AppTargets(managerSettings, runner);
await manager.applyPause();
manager.applyResume();
assertArrayEqual(runner.started, [], 'resume does not start an app that was not running before pause');

reset([signalTarget]);
runner = new FakeRunner(['flatpak:org.signal.Signal']);
manager = new AppTargets(managerSettings, runner);
await manager.applyPause();
managerSettings.set_string('app-targets', JSON.stringify([{ ...signalTarget, enabled: false }]));
await manager.reload(true);
assertArrayEqual(
    runner.started,
    ['flatpak run org.signal.Signal'],
    'disabling an app target releases an app stopped by Service Pauser'
);
status = await manager.status();
assertEqual(status.length, 0, 'disabling an app target removes it from status');

print('App target tests passed');
