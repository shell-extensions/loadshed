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

const TARGETS_SETTINGS_KEY = 'gsettings-targets';
const RUNTIME_STATE_KEY = 'gsettings-runtime-state';
const EXTENSION_SEARCH_DIRS = [
    GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'gnome-shell', 'extensions']),
    '/usr/share/gnome-shell/extensions',
];

export function lookupTargetSchema(defaultSource, schemaId, extensionUuid) {
    const direct = defaultSource.lookup(schemaId, true);
    if (direct || !extensionUuid) {
        return direct;
    }

    for (const base of EXTENSION_SEARCH_DIRS) {
        const schemaDir = GLib.build_filenamev([base, extensionUuid, 'schemas']);
        if (!GLib.file_test(schemaDir, GLib.FileTest.IS_DIR)) {
            continue;
        }

        try {
            const layered = Gio.SettingsSchemaSource.new_from_directory(schemaDir, defaultSource, false);
            const schema = layered.lookup(schemaId, true);
            if (schema) {
                return schema;
            }
        } catch (error) {
            logError(error, `Loadshed: failed to load schema dir ${schemaDir}`);
        }
    }

    return null;
}

function settingIdentity(schema, key, extensionUuid = '') {
    return JSON.stringify([extensionUuid, schema, key]);
}

function emptyRuntimeState() {
    return { paused: {}, hidden: {} };
}

export class GSettingsTargets {
    constructor(settings) {
        this._settings = settings;
        this._entries = [];
        this._resolved = [];
        this._load();
        this._restoreInactiveSnapshots();
    }

    reload(pauseActive = false) {
        this._load();
        this._restoreInactiveSnapshots();
        this.hideOwnToggles();
        if (pauseActive) {
            this.applyPause();
        }
    }

    _load() {
        this._entries = [];
        this._resolved = [];

        try {
            const parsed = JSON.parse(this._settings.get_string(TARGETS_SETTINGS_KEY));
            if (Array.isArray(parsed)) {
                this._entries = parsed.filter(entry => entry && typeof entry === 'object');
            }
        } catch (error) {
            logError(error, 'Loadshed: failed to parse gsettings-targets');
        }

        const schemaSource = Gio.SettingsSchemaSource.get_default();
        this._entries.forEach(entry => {
            if (!entry.schema || !entry.key) {
                return;
            }

            const gsettings = this._resolveBoolSetting(
                schemaSource,
                entry.schema,
                entry.key,
                entry.extension_uuid
            );
            if (!gsettings) {
                return;
            }

            let ownToggle = null;
            if (entry.own_toggle_key) {
                ownToggle = this._resolveBoolSetting(
                    schemaSource,
                    entry.schema,
                    entry.own_toggle_key,
                    entry.extension_uuid
                );
            }

            this._resolved.push({ entry, gsettings, ownToggle });
        });
    }

    _resolveBoolSetting(schemaSource, schemaId, key, extensionUuid) {
        try {
            const schema = lookupTargetSchema(schemaSource, schemaId, extensionUuid);
            if (!schema || !schema.has_key(key)) {
                return null;
            }
            if (schema.get_key(key).get_value_type().dup_string() !== 'b') {
                return null;
            }
            if (!schema.get_path()) {
                // Relocatable schemas have no fixed path and can't be bound
                // via `settingsSchema` alone; skip silently instead of
                // throwing on every reload.
                return null;
            }
            return new Gio.Settings({ settingsSchema: schema });
        } catch (error) {
            logError(error, `Loadshed: failed to resolve ${schemaId}::${key}`);
            return null;
        }
    }

    _activeEntries() {
        return this._entries.filter(entry =>
            entry.enabled !== false && entry.schema && entry.key);
    }

    _activeResolved() {
        return this._resolved.filter(item => item.entry.enabled !== false);
    }

    _readRuntimeState() {
        try {
            const state = JSON.parse(this._settings.get_string(RUNTIME_STATE_KEY));
            if (state && typeof state === 'object') {
                return {
                    paused: state.paused && typeof state.paused === 'object' && !Array.isArray(state.paused)
                        ? state.paused
                        : {},
                    hidden: state.hidden && typeof state.hidden === 'object' && !Array.isArray(state.hidden)
                        ? state.hidden
                        : {},
                };
            }
        } catch (error) {
            logError(error, 'Loadshed: failed to parse gsettings runtime state');
        }
        return emptyRuntimeState();
    }

    _writeRuntimeState(state) {
        this._settings.set_string(RUNTIME_STATE_KEY, JSON.stringify(state));
    }

    _snapshot(setting, schema, key, extensionUuid) {
        return {
            schema,
            key,
            extension_uuid: extensionUuid || '',
            value: setting.get_boolean(key),
        };
    }

    _restoreSnapshot(snapshot) {
        if (!snapshot || typeof snapshot.value !== 'boolean') {
            return true;
        }

        const schemaSource = Gio.SettingsSchemaSource.get_default();
        const setting = this._resolveBoolSetting(
            schemaSource,
            snapshot.schema,
            snapshot.key,
            snapshot.extension_uuid
        );
        if (!setting) {
            return false;
        }

        return setting.set_boolean(snapshot.key, snapshot.value);
    }

    _restoreMatchingSnapshots(kind, shouldRestore) {
        const state = this._readRuntimeState();
        let changed = false;

        Object.entries(state[kind]).forEach(([identity, snapshot]) => {
            if (!shouldRestore(identity)) {
                return;
            }
            try {
                if (this._restoreSnapshot(snapshot)) {
                    delete state[kind][identity];
                    changed = true;
                }
            } catch (error) {
                logError(error, `Loadshed: failed to restore ${snapshot?.schema}::${snapshot?.key}`);
            }
        });

        if (changed) {
            this._writeRuntimeState(state);
        }
    }

    _restoreInactiveSnapshots() {
        const activeTargets = new Set();
        const activeOwnToggles = new Set();

        this._activeEntries().forEach(entry => {
            activeTargets.add(settingIdentity(entry.schema, entry.key, entry.extension_uuid));
            if (entry.own_toggle_key) {
                activeOwnToggles.add(settingIdentity(
                    entry.schema,
                    entry.own_toggle_key,
                    entry.extension_uuid
                ));
            }
        });

        this._restoreMatchingSnapshots('paused', identity => !activeTargets.has(identity));
        this._restoreMatchingSnapshots('hidden', identity => !activeOwnToggles.has(identity));
    }

    applyPause() {
        const state = this._readRuntimeState();
        const pending = [];
        let changed = false;

        this._activeResolved().forEach(item => {
            const identity = settingIdentity(
                item.entry.schema,
                item.entry.key,
                item.entry.extension_uuid
            );
            if (!state.paused[identity]) {
                state.paused[identity] = this._snapshot(
                    item.gsettings,
                    item.entry.schema,
                    item.entry.key,
                    item.entry.extension_uuid
                );
                changed = true;
            }
            pending.push(item);
        });

        if (changed) {
            this._writeRuntimeState(state);
        }

        pending.forEach(item => {
            item.gsettings.set_boolean(item.entry.key, Boolean(item.entry.pause_value));
        });
    }

    applyResume() {
        this._restoreMatchingSnapshots('paused', () => true);
    }

    enforce() {
        this.applyPause();
    }

    hideOwnToggles() {
        const state = this._readRuntimeState();
        const pending = [];
        let changed = false;

        this._activeResolved().forEach(item => {
            if (!item.ownToggle) {
                return;
            }

            const identity = settingIdentity(
                item.entry.schema,
                item.entry.own_toggle_key,
                item.entry.extension_uuid
            );
            if (!state.hidden[identity]) {
                state.hidden[identity] = this._snapshot(
                    item.ownToggle,
                    item.entry.schema,
                    item.entry.own_toggle_key,
                    item.entry.extension_uuid
                );
                changed = true;
            }
            pending.push(item);
        });

        if (changed) {
            this._writeRuntimeState(state);
        }

        pending.forEach(item => {
            item.ownToggle.set_boolean(item.entry.own_toggle_key, false);
        });
    }

    restoreOwnToggles() {
        this._restoreMatchingSnapshots('hidden', () => true);
    }

    status() {
        const state = this._readRuntimeState();
        return this._activeResolved().map(item => {
            const identity = settingIdentity(
                item.entry.schema,
                item.entry.key,
                item.entry.extension_uuid
            );
            const managed = Boolean(state.paused[identity]);
            let running = false;
            try {
                running = item.gsettings.get_boolean(item.entry.key) !== Boolean(item.entry.pause_value);
            } catch (error) {
                logError(error, `Loadshed: failed to read ${item.entry.schema}::${item.entry.key}`);
            }

            return {
                id: item.entry.id,
                label: item.entry.label || item.entry.id,
                service_active: running,
                paused: managed && !running,
                managed,
                service_frozen: false,
            };
        });
    }
}
