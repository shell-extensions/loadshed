// SPDX-License-Identifier: GPL-3.0-or-later
//
// Loadshed — Pause configured background maintenance services from GNOME Quick Settings.
// Copyright (C) 2026 yurij.de
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const APP_TARGETS_SETTINGS_KEY = 'app-targets';
const APP_RUNTIME_STATE_KEY = 'app-runtime-state';

function emptyRuntimeState() {
    return { paused: {} };
}

function appIdentity(entry) {
    return entry.id || `${entry.kind || 'flatpak'}:${entry.app_id || entry.desktop_id || entry.command}`;
}

function parseCommand(command) {
    if (!command || typeof command !== 'string') {
        return null;
    }

    try {
        const [, argv] = GLib.shell_parse_argv(command);
        return argv.length > 0 ? argv : null;
    } catch (error) {
        logError(error, `Loadshed: failed to parse app command ${command}`);
        return null;
    }
}

function defaultStartCommand(entry) {
    if (!entry?.app_id) {
        return '';
    }

    if ((entry.kind || 'flatpak') === 'snap') {
        return `snap run ${entry.app_id}`;
    }

    return `flatpak run ${entry.app_id}`;
}

function startCommandForEntry(entry) {
    const command = typeof entry?.command === 'string' ? entry.command.trim() : '';
    return command || defaultStartCommand(entry);
}

class DefaultAppRunner {
    _run(argv) {
        // Runs the subprocess asynchronously so a `flatpak ps`/`pkill` call
        // (invoked periodically from the Quick Settings refresh timer) never
        // blocks the gnome-shell mainloop the way the previous synchronous
        // communicate_utf8() call did.
        return new Promise(resolve => {
            try {
                const proc = new Gio.Subprocess({
                    argv,
                    flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
                });
                proc.init(null);
                proc.communicate_utf8_async(null, null, (source, res) => {
                    try {
                        const [, stdout, stderr] = source.communicate_utf8_finish(res);
                        resolve({
                            ok: source.get_successful(),
                            stdout: stdout || '',
                            stderr: stderr || '',
                        });
                    } catch (error) {
                        logError(error, `Loadshed: failed to read app command output (${argv.join(' ')})`);
                        resolve({ ok: false, stdout: '', stderr: '' });
                    }
                });
            } catch (error) {
                logError(error, `Loadshed: failed to run app command (${argv.join(' ')})`);
                resolve({ ok: false, stdout: '', stderr: '' });
            }
        });
    }

    async isFlatpakRunning(appId) {
        const flatpak = GLib.find_program_in_path('flatpak');
        if (!flatpak || !appId) {
            return false;
        }

        const result = await this._run([flatpak, 'ps', '--columns=application']);
        if (!result.ok) {
            return false;
        }

        return result.stdout
            .split('\n')
            .map(line => line.trim())
            .includes(appId);
    }

    async stopFlatpak(appId) {
        const flatpak = GLib.find_program_in_path('flatpak');
        if (!flatpak || !appId) {
            return false;
        }

        const result = await this._run([flatpak, 'kill', appId]);
        return result.ok;
    }

    startCommand(command) {
        const argv = parseCommand(command);
        if (!argv) {
            return false;
        }

        try {
            GLib.spawn_async(
                null,
                argv,
                null,
                GLib.SpawnFlags.SEARCH_PATH,
                null
            );
            return true;
        } catch (error) {
            logError(error, `Loadshed: failed to start app command ${command}`);
            return false;
        }
    }

    async _pgrep(pattern) {
        const pgrep = GLib.find_program_in_path('pgrep');
        if (!pgrep || !pattern) {
            return false;
        }

        const result = await this._run([pgrep, '-f', pattern]);
        return result.ok && result.stdout.trim().length > 0;
    }

    async isSnapRunning(appId) {
        if (await this._pgrep(`/snap/${appId}/`)) {
            return true;
        }
        if (await this._pgrep(`snap/${appId}/`)) {
            return true;
        }
        return this._pgrep(`snap run ${appId}`);
    }

    async stopSnap(appId) {
        const pkill = GLib.find_program_in_path('pkill');
        if (!pkill || !appId) {
            return false;
        }

        const patterns = [`/snap/${appId}/`, `snap/${appId}/`, `snap run ${appId}`];
        let stopped = false;
        for (const pattern of patterns) {
            const result = await this._run([pkill, '-TERM', '-f', pattern]);
            stopped = stopped || result.ok;
        }
        return stopped;
    }
}

export class AppTargets {
    constructor(settings, runner = null) {
        this._settings = settings;
        this._runner = runner || new DefaultAppRunner();
        this._entries = [];
        this._load();
        this._restoreInactiveState();
    }

    async reload(pauseActive = false) {
        this._load();
        this._restoreInactiveState();
        if (pauseActive) {
            await this.applyPause();
        }
    }

    _load() {
        this._entries = [];

        try {
            const parsed = JSON.parse(this._settings.get_string(APP_TARGETS_SETTINGS_KEY));
            if (Array.isArray(parsed)) {
                this._entries = parsed.filter(entry => entry && typeof entry === 'object');
            }
        } catch (error) {
            logError(error, 'Loadshed: failed to parse app-targets');
        }
    }

    _activeEntries() {
        return this._entries.filter(entry =>
            entry.enabled !== false &&
            appIdentity(entry) &&
            ['flatpak', 'snap'].includes(entry.kind || 'flatpak') &&
            entry.app_id);
    }

    async _isRunning(entry) {
        if ((entry.kind || 'flatpak') === 'snap') {
            return this._runner.isSnapRunning(entry.app_id);
        }
        return this._runner.isFlatpakRunning(entry.app_id);
    }

    async _stop(entry) {
        if ((entry.kind || 'flatpak') === 'snap') {
            return this._runner.stopSnap(entry.app_id);
        }
        return this._runner.stopFlatpak(entry.app_id);
    }

    _readRuntimeState() {
        try {
            const state = JSON.parse(this._settings.get_string(APP_RUNTIME_STATE_KEY));
            if (state && typeof state === 'object') {
                return {
                    paused: state.paused && typeof state.paused === 'object' && !Array.isArray(state.paused)
                        ? state.paused
                        : {},
                };
            }
        } catch (error) {
            logError(error, 'Loadshed: failed to parse app runtime state');
        }
        return emptyRuntimeState();
    }

    _writeRuntimeState(state) {
        this._settings.set_string(APP_RUNTIME_STATE_KEY, JSON.stringify(state));
    }

    _restoreInactiveState() {
        const activeIds = new Set(this._activeEntries().map(entry => appIdentity(entry)));
        const state = this._readRuntimeState();
        let changed = false;

        Object.keys(state.paused).forEach(identity => {
            if (activeIds.has(identity)) {
                return;
            }

            const snapshot = state.paused[identity];
            if (snapshot?.was_running && snapshot.command) {
                this._runner.startCommand(snapshot.command);
            }
            delete state.paused[identity];
            changed = true;
        });

        if (changed) {
            this._writeRuntimeState(state);
        }
    }

    async applyPause() {
        const state = this._readRuntimeState();
        let changed = false;

        // Sequential await here (not Promise.all): pausing must record each
        // app's prior running state before stopping it, and there are
        // normally only a handful of configured apps, so correctness over
        // raw parallelism is the right trade-off.
        for (const entry of this._activeEntries()) {
            const identity = appIdentity(entry);
            const running = await this._isRunning(entry);
            if (!state.paused[identity]) {
                state.paused[identity] = {
                    id: entry.id || '',
                    kind: entry.kind || 'flatpak',
                    app_id: entry.app_id,
                    command: startCommandForEntry(entry),
                    was_running: running,
                };
                changed = true;
            }

            if (running) {
                await this._stop(entry);
            }
        }

        if (changed) {
            this._writeRuntimeState(state);
        }
    }

    applyResume() {
        const state = this._readRuntimeState();

        Object.entries(state.paused).forEach(([, snapshot]) => {
            if (snapshot?.was_running && snapshot.command) {
                this._runner.startCommand(snapshot.command);
            }
        });

        this._writeRuntimeState(emptyRuntimeState());
    }

    async enforce() {
        const state = this._readRuntimeState();

        for (const entry of this._activeEntries()) {
            const identity = appIdentity(entry);
            if (!state.paused[identity]) {
                continue;
            }
            if (await this._isRunning(entry)) {
                await this._stop(entry);
            }
        }
    }

    async status() {
        const state = this._readRuntimeState();
        const activeEntries = this._activeEntries();

        // Same pattern as applyPause()/enforce() above: go through the
        // entries one at a time and wait for each running-check before
        // moving to the next. Simpler to follow than firing them all at
        // once, and with only a handful of configured apps the speed
        // difference doesn't matter.
        const runningByIdentity = new Map();
        for (const entry of activeEntries) {
            const identity = appIdentity(entry);
            const running = await this._isRunning(entry);
            runningByIdentity.set(identity, running);
        }

        return activeEntries.map(entry => {
            const identity = appIdentity(entry);
            const managed = Boolean(state.paused[identity]);
            const running = Boolean(runningByIdentity.get(identity));

            return {
                id: entry.id,
                label: entry.label || entry.id || entry.app_id,
                service: entry.desktop_id || entry.app_id,
                service_active: running,
                paused: managed && !running,
                managed,
                service_frozen: false,
            };
        });
    }
}
