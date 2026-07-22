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

const HELPER_INSTALL_PATH = '/usr/local/bin/loadshed-helper';
const DEFAULT_REFRESH_INTERVAL = 10;

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
        const preAction = this.checked ? this._manager.enforceTargets() : Promise.resolve();

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

        let preAction;
        if (action === 'pause') {
            preAction = this._manager.applyPause();
        } else if (action === 'resume') {
            preAction = Promise.resolve(this._manager.applyResume());
        } else {
            preAction = Promise.resolve();
        }

        this._busy = true;
        this.subtitle = action === 'pause' ? _('Pausing') : _('Resuming');
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
        const helperEntries = Array.isArray(status.entries) ? status.entries : [];
        const helperPaused = Boolean(status.paused);
        let targetEntries = await this._manager.targetsStatus();
        const targetManaged = targetEntries.some(entry => entry.managed);
        if (helperPaused || targetManaged) {
            await this._manager.enforceTargets();
            targetEntries = await this._manager.targetsStatus();
        }
        const entries = helperEntries.concat(targetEntries);

        const pausedCount = Number(status.paused_count || 0) + targetEntries.filter(entry => entry.managed).length;
        const runningCount = Number(status.running_count || 0) + targetEntries.filter(entry => !entry.paused).length;
        const paused = helperPaused || targetEntries.some(entry => entry.managed);

        this.checked = paused;
        this._indicator.visible = paused;

        if (entries.length === 0) {
            this.subtitle = _('No services configured');
        } else if (pausedCount > 0) {
            this.subtitle = formatCountLabel(ngettext('1 paused', '%d paused', pausedCount), pausedCount);
        } else if (runningCount > 0) {
            this.subtitle = formatCountLabel(ngettext('1 running', '%d running', runningCount), runningCount);
        } else {
            this.subtitle = _('Nothing running');
        }

        if (Array.isArray(status.errors) && status.errors.length > 0) {
            this.subtitle = _('Partial error');
            Main.notify(_('Loadshed'), status.errors.join('\n'));
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
        return Boolean(entry.error) || (
            entry.service_active &&
            !entry.paused &&
            !entry.service_frozen
        );
    }

    _entryPaused(entry) {
        return Boolean(entry.paused || entry.managed || entry.service_frozen);
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
        if (entry.paused || entry.service_frozen) {
            return 'media-playback-pause-symbolic';
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
    }

    get paused() {
        return Boolean(this._toggle?.checked);
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
