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

import GLib from 'gi://GLib';

const TARGETS_SETTINGS_KEY = 'file-targets';
const RUNTIME_STATE_KEY = 'file-runtime-state';
const DEFAULT_SECTION = 'FolderSize';

function settingIdentity(path, section, key) {
    return JSON.stringify([path, section || '', key]);
}

function emptyRuntimeState() {
    return { paused: {} };
}

function expandPath(path) {
    if (path && path.startsWith('~/'))
        return GLib.build_filenamev([GLib.get_home_dir(), path.slice(2)]);
    return path;
}

// Datei-Pendant zu GSettingsTargets: pausiert Anwendungen, die ihren
// Zustand nicht über GSettings, sondern in einer einfachen INI-Datei
// (key=value unter [section]) halten - z.B. foldersize.py's
// ~/.config/foldersize.conf. GLib.KeyFile liest/schreibt dieses Format
// kompatibel zu Pythons configparser und speichert atomar.
export class FileTargets {
    constructor(settings) {
        this._settings = settings;
        this._entries = [];
        this._load();
    }

    reload(pauseActive = false) {
        this._load();
        if (pauseActive)
            this.applyPause();
    }

    _load() {
        this._entries = [];

        try {
            const parsed = JSON.parse(this._settings.get_string(TARGETS_SETTINGS_KEY));
            if (Array.isArray(parsed)) {
                this._entries = parsed.filter(entry =>
                    entry && typeof entry === 'object' && entry.path && entry.key);
            }
        } catch (error) {
            logError(error, 'Loadshed: failed to parse file-targets');
        }
    }

    _activeEntries() {
        return this._entries.filter(entry => entry.enabled !== false);
    }

    _readRuntimeState() {
        try {
            const state = JSON.parse(this._settings.get_string(RUNTIME_STATE_KEY));
            if (state && typeof state === 'object') {
                return {
                    paused: state.paused && typeof state.paused === 'object' && !Array.isArray(state.paused)
                        ? state.paused
                        : {},
                };
            }
        } catch (error) {
            logError(error, 'Loadshed: failed to parse file runtime state');
        }
        return emptyRuntimeState();
    }

    _writeRuntimeState(state) {
        this._settings.set_string(RUNTIME_STATE_KEY, JSON.stringify(state));
    }

    _readValue(entry) {
        const path = expandPath(entry.path);
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            return null;

        const keyFile = new GLib.KeyFile();
        try {
            keyFile.load_from_file(path, GLib.KeyFileFlags.NONE);
            return keyFile.get_string(entry.section || DEFAULT_SECTION, entry.key);
        } catch (error) {
            logError(error, `Loadshed: failed to read ${path}`);
            return null;
        }
    }

    _writeValue(entry, value) {
        const path = expandPath(entry.path);
        const keyFile = new GLib.KeyFile();

        if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
            try {
                keyFile.load_from_file(path, GLib.KeyFileFlags.KEEP_COMMENTS);
            } catch (error) {
                logError(error, `Loadshed: failed to parse ${path} before write`);
            }
        }

        keyFile.set_string(entry.section || DEFAULT_SECTION, entry.key, value);

        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
            keyFile.save_to_file(path);
            return true;
        } catch (error) {
            logError(error, `Loadshed: failed to write ${path}`);
            return false;
        }
    }

    applyPause() {
        const state = this._readRuntimeState();
        let changed = false;

        this._activeEntries().forEach(entry => {
            const identity = settingIdentity(entry.path, entry.section, entry.key);
            if (!(identity in state.paused)) {
                const current = this._readValue(entry);
                state.paused[identity] = {
                    path: entry.path,
                    section: entry.section || '',
                    key: entry.key,
                    // Fällt die Datei noch nicht an, gilt der dokumentierte
                    // Default der Zielanwendung als Wiederherstellungswert.
                    value: current !== null ? current : String(entry.resume_value ?? 'true'),
                };
                changed = true;
            }
        });

        if (changed)
            this._writeRuntimeState(state);

        this._activeEntries().forEach(entry => {
            this._writeValue(entry, String(entry.pause_value));
        });
    }

    applyResume() {
        const state = this._readRuntimeState();
        let changed = false;

        Object.entries(state.paused).forEach(([identity, snapshot]) => {
            const entry = { path: snapshot.path, section: snapshot.section, key: snapshot.key };
            if (this._writeValue(entry, snapshot.value)) {
                delete state.paused[identity];
                changed = true;
            }
        });

        if (changed)
            this._writeRuntimeState(state);
    }

    enforce() {
        this.applyPause();
    }

    status() {
        const state = this._readRuntimeState();
        return this._activeEntries().map(entry => {
            const identity = settingIdentity(entry.path, entry.section, entry.key);
            const managed = identity in state.paused;
            const current = this._readValue(entry);
            const running = current !== null && current !== String(entry.pause_value);

            return {
                id: entry.id,
                label: entry.label || entry.id,
                service_active: running,
                paused: managed && !running,
                managed,
                service_frozen: false,
            };
        });
    }
}
