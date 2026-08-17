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

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { PopupAnimation } from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import { Extension, gettext as _, ngettext } from 'resource:///org/gnome/shell/extensions/extension.js';
import { AppTargets } from './appTargets.js';
import { GSettingsTargets } from './gsettingsTargets.js';
import { FileTargets } from './fileTargets.js';
import { summarizeStatus } from './statusSummary.js';

const HELPER_INSTALL_PATH = '/usr/local/bin/loadshed-helper';
const DEFAULT_REFRESH_INTERVAL = 10;
// Fixed slot in the 2-column Quick Settings grid, right column of the row
// below hotspot@yurij.de (which pins itself to 4) and beside epp-modes
// (which pins itself to 6, the left column of that same row). Self-contained
// on purpose: an earlier attempt to have epp-modes reach into loadshed at
// runtime via Extension.lookupByUUID() and reposition it from the outside
// was unreliable, most likely because extension enable() order across
// independently-loaded extensions isn't guaranteed, so the lookup could run
// before loadshed had even added its own toggle to the grid.
const TARGET_POSITION = 7;

function formatCountLabel(label, count) {
    return label.replace('%d', String(count));
}

class LoadshedManager {
    constructor(settings) {
        this._targets = new GSettingsTargets(settings);
        this._files = new FileTargets(settings);
        this._apps = new AppTargets(settings);
    }

    async reloadTargets(pauseActive) {
        this._targets.reload(pauseActive);
        this._files.reload(pauseActive);
        await this._apps.reload(pauseActive);
    }

    async applyPause() {
        this._targets.applyPause();
        this._files.applyPause();
        await this._apps.applyPause();
    }

    applyResume() {
        // AppTargets.applyResume() only fires GLib.spawn_async() (already
        // non-blocking) and never awaits a subprocess result, so it stays
        // synchronous here too.
        this._targets.applyResume();
        this._files.applyResume();
        this._apps.applyResume();
    }

    async enforceTargets() {
        this._targets.enforce();
        this._files.enforce();
        await this._apps.enforce();
    }

    async targetsStatus() {
        const appEntries = await this._apps.status();
        return this._targets.status().concat(this._files.status(), appEntries);
    }

    hideOwnToggles() {
        this._targets.hideOwnToggles();
    }

    restoreOwnToggles() {
        this._targets.restoreOwnToggles();
    }

    _helperCommand(action) {
        const sudoBin = GLib.find_program_in_path('sudo');
        if (!sudoBin) {
            throw new Error('sudo was not found');
        }

        if (!GLib.file_test(HELPER_INSTALL_PATH, GLib.FileTest.IS_EXECUTABLE)) {
            throw new Error('setup required');
        }

        return [sudoBin, '-n', HELPER_INSTALL_PATH, action];
    }

    run(action) {
        let argv;
        try {
            argv = this._helperCommand(action);
        } catch (error) {
            return Promise.reject(error);
        }

        return new Promise((resolve, reject) => {
            try {
                const proc = new Gio.Subprocess({
                    argv,
                    flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
                });
                proc.init(null);
                proc.communicate_utf8_async(null, null, (source, res) => {
                    try {
                        const [, stdout, stderr] = source.communicate_utf8_finish(res);
                        let payload = null;
                        if (stdout?.trim()) {
                            payload = JSON.parse(stdout.trim());
                        }

                        if (source.get_successful() && payload) {
                            resolve(payload);
                            return;
                        }

                        const message = payload?.error || stderr?.trim() || stdout?.trim() || _('Helper command failed');
                        const error = new Error(message);
                        error.payload = payload;
                        reject(error);
                    } catch (error) {
                        reject(error);
                    }
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    resumeDetached() {
        let argv;
        try {
            argv = this._helperCommand('resume');
        } catch {
            return;
        }

        try {
            GLib.spawn_async(
                null,
                argv,
                null,
                GLib.SpawnFlags.SEARCH_PATH,
                null
            );
        } catch (error) {
            logError(error, 'Loadshed: failed to resume on disable');
        }
    }
}

const LoadshedToggle = GObject.registerClass(
class LoadshedToggle extends QuickSettings.QuickMenuToggle {
    _init(extensionObject, manager, indicator) {
        super._init({
            title: _('Loadshed'),
            subtitle: _('Loading'),
            iconName: 'media-playback-pause-symbolic',
            toggleMode: true,
        });

        this._settings = extensionObject._settings;
        this._extensionObject = extensionObject;
        this._manager = manager;
        this._indicator = indicator;
        this._busy = false;
        this._entryItems = [];
        this._refreshSourceId = 0;
        this._settingsSignalIds = [];

        this.menu.setHeader('media-playback-pause-symbolic', _('Loadshed'), _('Background services'));
        this._itemsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._itemsSection);
        this.menu.addAction(_('Refresh'), () => this._refresh());
        this.menu.addAction(_('Recover frozen targets'), () => this._runAction('recover'));
        this.menu.addAction(_('Settings'), () => this._openPreferences());
        this.menu.addAction(_('Setup help'), () => this._notifySetupRequired());

        this._clickedId = this.connect('clicked', () => this._togglePaused());

        this._settingsSignalIds.push(this._settings.connect('changed::refresh-interval', () => {
            this._restartRefreshTimer();
        }));

        this._settingsSignalIds.push(this._settings.connect('changed::show-quick-settings', () => {
            this.visible = this._settings.get_boolean('show-quick-settings');
        }));

        this.visible = this._settings.get_boolean('show-quick-settings');
        this._restartRefreshTimer();
        this._refresh();
    }

    destroy() {
        if (this._refreshSourceId) {
            GLib.Source.remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }

        if (this._clickedId) {
            this.disconnect(this._clickedId);
            this._clickedId = 0;
        }

        this._settingsSignalIds.forEach(id => this._settings.disconnect(id));
        this._settingsSignalIds = [];
        this._clearEntryItems();

        super.destroy();
    }

    _restartRefreshTimer() {
        if (this._refreshSourceId) {
            GLib.Source.remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }

        const interval = Math.max(
            2,
            this._settings.get_int('refresh-interval') || DEFAULT_REFRESH_INTERVAL
        );

        this._refreshSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _togglePaused() {
        if (this._busy) {
            return;
        }

        this._runAction(this.checked ? 'pause' : 'resume');
    }

    _openPreferences() {
        this._extensionObject.openPreferences();
        Main.panel.statusArea.quickSettings.menu.close(PopupAnimation.FADE);
    }

    _refresh() {
        if (this._busy) {
            return;
        }

        const action = this.checked ? 'enforce' : 'status';
        // The helper is authoritative for the persistent pause intent.  Do
        // not change target state before its response tells us whether the
        // pause is still active; _applyStatus() reconciles targets after that
        // response is known.
        const preAction = Promise.resolve();

        this._busy = true;
        this.subtitle = _('Refreshing');
        preAction
            .then(() => this._manager.run(action))
            .then(status => this._applyStatus(status))
            .catch(error => this._handleError(error))
            .finally(() => {
                this._busy = false;
            });
    }

    _runAction(action) {
        if (this._busy) {
            return;
        }

        // Let the root helper perform the transition first.  _applyStatus()
        // then applies or releases the user-session targets according to the
        // confirmed pause intent, preserving the gate during resume.
        const preAction = Promise.resolve();

        this._busy = true;
        this.subtitle = action === 'pause'
            ? _('Pausing')
            : action === 'recover' ? _('Recovering') : _('Resuming');
        preAction
            .then(() => this._manager.run(action))
            .then(status => this._applyStatus(status))
            .catch(error => this._handleError(error))
            .finally(() => {
                this._busy = false;
            });
    }

    _handleError(error) {
        if (error?.payload) {
            this._applyStatus(error.payload);
        } else {
            // No usable helper response (e.g. helper not set up yet). Fall
            // through the normal status path with no helper entries — any
            // GSettings targets are still managed directly by us and keep
            // showing their real status instead of the menu going blank.
            this._applyStatus({});
        }

        const message = error?.message || _('Unknown error');
        if (message === 'setup required') {
            this.subtitle = _('Setup required');
            this._notifySetupRequired();
            return;
        }

        this.subtitle = _('Error');
        Main.notify(_('Loadshed'), message);
    }

    _notifySetupRequired() {
        Main.notify(
            _('Loadshed setup required'),
            _('Run install.sh from the extension directory, then reload GNOME Shell or re-enable the extension.')
        );
    }

    async _applyStatus(status) {
        const helperStatus = status && typeof status === 'object' ? status : {};
        const helperEntries = Array.isArray(helperStatus.entries) ? helperStatus.entries : [];

        // A normal helper response explicitly tells us whether the root
        // pause state is known.  Keep the target snapshots while the root
        // intent is active (this also repairs targets after an extension
        // reload), and clear stale snapshots only after a known resume.
        if (helperStatus.pause_state_known === true) {
            if (helperStatus.pause_intent === true) {
                await this._manager.applyPause();
            } else {
                this._manager.applyResume();
            }
        }

        const targetEntries = await this._manager.targetsStatus();
        const entries = helperEntries.concat(targetEntries);
        const summary = summarizeStatus(helperStatus, targetEntries);

        this.checked = summary.strictPaused;
        this._indicator.visible = summary.strictPaused;

        if (entries.length === 0) {
            this.subtitle = _('No services configured');
        } else if (summary.pausedCount > 0) {
            this.subtitle = formatCountLabel(
                ngettext('1 target paused', '%d targets paused', summary.pausedCount),
                summary.pausedCount
            );
        } else if (summary.runningCount > 0) {
            this.subtitle = formatCountLabel(
                ngettext('1 target running', '%d targets running', summary.runningCount),
                summary.runningCount
            );
        } else if (summary.protectedCount > 0) {
            this.subtitle = formatCountLabel(
                ngettext('1 target protected', '%d targets protected', summary.protectedCount),
                summary.protectedCount
            );
        } else if (helperStatus.recovery_required || Number(helperStatus.external_frozen_count) > 0) {
            this.subtitle = _('Recovery required');
        } else {
            this.subtitle = _('Nothing running');
        }

        if (Array.isArray(helperStatus.errors) && helperStatus.errors.length > 0) {
            this.subtitle = _('Partial error');
            Main.notify(_('Loadshed'), helperStatus.errors.join('\n'));
        }

        this._rebuildEntryItems(entries);
    }

    _clearEntryItems() {
        this._entryItems.forEach(item => item.destroy());
        this._entryItems = [];
    }

    _rebuildEntryItems(entries) {
        this._clearEntryItems();

        const visibleEntries = [];
        const hiddenEntries = [];

        entries.forEach(entry => {
            if (this._entryVisible(entry)) {
                visibleEntries.push(entry);
            } else {
                hiddenEntries.push(entry);
            }
        });

        visibleEntries.forEach(entry => {
            this._addEntryItem(entry.label || entry.id || _('Unknown'), this._entryIcon(entry));
        });

        if (hiddenEntries.length > 0) {
            this._addEntryItem(
                this._hiddenEntriesLabel(hiddenEntries),
                this._hiddenEntriesIcon(hiddenEntries),
                'loadshed-summary-entry'
            );
        }
    }

    _addEntryItem(label, iconName, extraStyleClass = '') {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: `popup-menu-item loadshed-entry ${extraStyleClass}`,
        });
        const box = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'popup-menu-item-content loadshed-entry-content',
        });
        const icon = new St.Icon({
            icon_name: iconName,
            style_class: 'popup-menu-icon loadshed-entry-icon',
        });
        const title = new St.Label({
            text: label,
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'loadshed-entry-label',
        });

        box.add_child(icon);
        box.add_child(title);
        item.actor.add_child(box);
        this._itemsSection.addMenuItem(item);
        this._entryItems.push(item);
    }

    _entryVisible(entry) {
        return Boolean(
            entry.error ||
            entry.external_frozen ||
            entry.protected ||
            (entry.service_active && !entry.paused)
        );
    }

    _entryPaused(entry) {
        return Boolean(entry.paused);
    }

    _hiddenEntriesLabel(entries) {
        const pausedCount = entries.filter(entry => this._entryPaused(entry)).length;
        const releasedCount = entries.length - pausedCount;

        if (releasedCount === 0) {
            return formatCountLabel(ngettext('1 service paused', '%d services paused', pausedCount), pausedCount);
        }

        if (pausedCount === 0) {
            return formatCountLabel(ngettext('1 service released', '%d services released', releasedCount), releasedCount);
        }

        const pausedLabel = formatCountLabel(ngettext('1 paused', '%d paused', pausedCount), pausedCount);
        const releasedLabel = formatCountLabel(ngettext('1 released', '%d released', releasedCount), releasedCount);
        return _('%s, %s').format(pausedLabel, releasedLabel);
    }

    _hiddenEntriesIcon(entries) {
        const pausedCount = entries.filter(entry => this._entryPaused(entry)).length;

        if (pausedCount === entries.length) {
            return 'media-playback-pause-symbolic';
        }
        if (pausedCount === 0) {
            return 'emblem-ok-symbolic';
        }
        return 'dialog-information-symbolic';
    }

    _entryIcon(entry) {
        if (entry.error) {
            return 'dialog-warning-symbolic';
        }
        if (entry.paused) {
            return 'media-playback-pause-symbolic';
        }
        if (entry.protected) {
            return 'changes-prevent-symbolic';
        }
        if (entry.external_frozen) {
            return 'dialog-warning-symbolic';
        }
        if (entry.service_active) {
            return 'media-playback-start-symbolic';
        }
        return 'emblem-ok-symbolic';
    }
});

const LoadshedIndicator = GObject.registerClass(
class LoadshedIndicator extends QuickSettings.SystemIndicator {
    _init(extensionObject, manager) {
        super._init();

        this._indicator = this._addIndicator();
        this._indicator.icon_name = 'media-playback-pause-symbolic';
        this._indicator.visible = false;

        this._toggle = new LoadshedToggle(extensionObject, manager, this._indicator);
        this.quickSettingsItems.push(this._toggle);

        Main.panel.statusArea.quickSettings.addExternalIndicator(this);

        // Delay until after the mainloop turn in which addExternalIndicator
        // ran, so every extension's toggle is already in the grid — same
        // one-shot technique as hotspot@yurij.de's own moveToDefaultPosition().
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => this._reorderToggle());
    }

    get paused() {
        return Boolean(this._toggle?.checked);
    }

    _reorderToggle() {
        const grid = Main.panel?.statusArea?.quickSettings?.menu?._grid;
        if (!grid?.get_children)
            return GLib.SOURCE_REMOVE;

        const toggles = grid.get_children().filter(child =>
            child instanceof QuickSettings.QuickToggle ||
            child instanceof QuickSettings.QuickMenuToggle);

        const currentIndex = toggles.indexOf(this._toggle);
        if (currentIndex === -1)
            return GLib.SOURCE_REMOVE;

        const desired = Math.min(Math.max(0, TARGET_POSITION), toggles.length - 1);
        if (desired !== currentIndex) {
            toggles.splice(currentIndex, 1);
            toggles.splice(desired, 0, this._toggle);

            let last = null;
            for (const item of toggles) {
                grid.set_child_above_sibling(item, last);
                last = item;
            }
        }

        return GLib.SOURCE_REMOVE;
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class LoadshedExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._settings = null;
        this._manager = null;
        this._indicator = null;
        this._targetsSignalId = 0;
        this._fileTargetsSignalId = 0;
        this._appTargetsSignalId = 0;
    }

    enable() {
        this._settings = this.getSettings();
        this._manager = new LoadshedManager(this._settings);
        // Loadshed takes over pausing for enabled GSettings targets,
        // so their own Quick Settings toggle would be redundant while we
        // manage it. (Folder Size no longer has a GSettings-backed toggle
        // to hide - it's managed via file-targets instead, see B3/B4.)
        this._manager.hideOwnToggles();

        // GObject signal callbacks can't be awaited, so these fire the
        // (now async) reload and just log if it ever rejects.
        this._targetsSignalId = this._settings.connect('changed::gsettings-targets', () => {
            const pauseActive = Boolean(this._indicator?.paused);
            this._manager.reloadTargets(pauseActive)
                .catch(error => logError(error, 'Loadshed: failed to reload GSettings targets'));
        });
        this._fileTargetsSignalId = this._settings.connect('changed::file-targets', () => {
            const pauseActive = Boolean(this._indicator?.paused);
            this._manager.reloadTargets(pauseActive)
                .catch(error => logError(error, 'Loadshed: failed to reload file targets'));
        });
        this._appTargetsSignalId = this._settings.connect('changed::app-targets', () => {
            const pauseActive = Boolean(this._indicator?.paused);
            this._manager.reloadTargets(pauseActive)
                .catch(error => logError(error, 'Loadshed: failed to reload app targets'));
        });

        this._indicator = new LoadshedIndicator(this, this._manager);
    }

    disable() {
        if (this._settings && this._targetsSignalId) {
            this._settings.disconnect(this._targetsSignalId);
        }
        this._targetsSignalId = 0;
        if (this._settings && this._fileTargetsSignalId) {
            this._settings.disconnect(this._fileTargetsSignalId);
        }
        this._fileTargetsSignalId = 0;
        if (this._settings && this._appTargetsSignalId) {
            this._settings.disconnect(this._appTargetsSignalId);
        }
        this._appTargetsSignalId = 0;

        if (this._settings?.get_boolean('auto-resume-on-disable')) {
            this._manager?.resumeDetached();
            this._manager?.applyResume();
        }

        // Give back any own toggles we hid so the user never ends up
        // without a way to control the target once we stop managing it.
        this._manager?.restoreOwnToggles();

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._manager = null;
        this._settings = null;
    }
}
