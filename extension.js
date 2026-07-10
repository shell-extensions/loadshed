import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import { Extension, gettext as _, ngettext } from 'resource:///org/gnome/shell/extensions/extension.js';

const HELPER_INSTALL_PATH = '/usr/local/bin/service-pauser-helper';
const DEFAULT_REFRESH_INTERVAL = 10;

function formatCountLabel(label, count) {
    return label.replace('%d', String(count));
}

class ServicePauserManager {
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
            logError(error, 'Service Pauser: failed to resume on disable');
        }
    }
}

const ServicePauserToggle = GObject.registerClass(
class ServicePauserToggle extends QuickSettings.QuickMenuToggle {
    _init(extensionObject, manager, indicator) {
        super._init({
            title: _('Stop Load'),
            subtitle: _('Loading'),
            iconName: 'media-playback-pause-symbolic',
            toggleMode: true,
        });

        this._settings = extensionObject._settings;
        this._manager = manager;
        this._indicator = indicator;
        this._busy = false;
        this._entryItems = [];
        this._refreshSourceId = 0;
        this._settingsSignalIds = [];

        this.menu.setHeader('media-playback-pause-symbolic', _('Stop Load'), _('Background services'));
        this._itemsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._itemsSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Refresh'), () => this._refresh());
        this.menu.addAction(_('Resume managed services'), () => this._runAction('resume'));
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

    _refresh() {
        if (this._busy) {
            return;
        }

        this._busy = true;
        this.subtitle = _('Refreshing');
        this._manager.run('status')
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

        this._busy = true;
        this.subtitle = action === 'pause' ? _('Pausing') : _('Resuming');
        this._manager.run(action)
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
            this.checked = false;
            this._indicator.visible = false;
            this._clearEntryItems();
        }

        const message = error?.message || _('Unknown error');
        if (message === 'setup required') {
            this.subtitle = _('Setup required');
            this._notifySetupRequired();
            return;
        }

        this.subtitle = _('Error');
        Main.notify(_('Service Pauser'), message);
    }

    _notifySetupRequired() {
        Main.notify(
            _('Service Pauser setup required'),
            _('Run install.sh from the extension directory, then reload GNOME Shell or re-enable the extension.')
        );
    }

    _applyStatus(status) {
        const entries = Array.isArray(status.entries) ? status.entries : [];
        const paused = Boolean(status.paused);
        const pausedCount = Number(status.paused_count || 0);
        const runningCount = Number(status.running_count || 0);

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
            Main.notify(_('Service Pauser'), status.errors.join('\n'));
        }

        this._rebuildEntryItems(entries);
    }

    _clearEntryItems() {
        this._entryItems.forEach(item => item.destroy());
        this._entryItems = [];
    }

    _rebuildEntryItems(entries) {
        this._clearEntryItems();

        entries.forEach(entry => {
            const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
            const box = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                style_class: 'popup-menu-item-content',
            });
            const icon = new St.Icon({
                icon_name: this._entryIcon(entry),
                style_class: 'popup-menu-icon',
            });
            const labels = new St.BoxLayout({
                vertical: true,
                x_expand: true,
            });
            const title = new St.Label({
                text: entry.label || entry.id || _('Unknown'),
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            });
            const subtitle = new St.Label({
                text: this._entrySubtitle(entry),
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                style_class: 'popup-inactive-menu-item',
            });

            labels.add_child(title);
            labels.add_child(subtitle);
            box.add_child(icon);
            box.add_child(labels);
            item.actor.add_child(box);
            this._itemsSection.addMenuItem(item);
            this._entryItems.push(item);
        });
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

    _entrySubtitle(entry) {
        if (entry.error) {
            return entry.error;
        }
        if (entry.paused) {
            if (entry.managed_service_frozen && entry.managed_timer_stopped) {
                return _('Service frozen, timer stopped');
            }
            if (entry.managed_service_frozen) {
                return _('Service frozen');
            }
            if (entry.managed_timer_stopped) {
                return _('Timer stopped');
            }
            return _('Paused');
        }
        if (entry.external_frozen) {
            return _('Frozen externally');
        }
        if (entry.service_active) {
            return _('Running');
        }
        if (entry.timer_active) {
            return _('Timer active');
        }
        if (entry.service_load_state !== 'loaded') {
            return _('Not loaded');
        }
        return _('Inactive');
    }
});

const ServicePauserIndicator = GObject.registerClass(
class ServicePauserIndicator extends QuickSettings.SystemIndicator {
    _init(extensionObject, manager) {
        super._init();

        this._indicator = this._addIndicator();
        this._indicator.icon_name = 'media-playback-pause-symbolic';
        this._indicator.visible = false;

        this._toggle = new ServicePauserToggle(extensionObject, manager, this._indicator);
        this.quickSettingsItems.push(this._toggle);

        Main.panel.statusArea.quickSettings.addExternalIndicator(this);
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class ServicePauserExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._settings = null;
        this._manager = null;
        this._indicator = null;
    }

    enable() {
        this._settings = this.getSettings();
        this._manager = new ServicePauserManager();
        this._indicator = new ServicePauserIndicator(this, this._manager);
    }

    disable() {
        if (this._settings?.get_boolean('auto-resume-on-disable')) {
            this._manager?.resumeDetached();
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._manager = null;
        this._settings = null;
    }
}
