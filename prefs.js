import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SCHEMA_ID = 'org.gnome.shell.extensions.service-pauser';

export default class ServicePauserPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const _ = this.gettext.bind(this);
        const settings = this.getSettings(SCHEMA_ID);

        const page = new Adw.PreferencesPage();
        window.add(page);

        const generalGroup = new Adw.PreferencesGroup({ title: _('General') });
        page.add(generalGroup);

        generalGroup.add(this._switchRow(settings, _('Show Quick Settings toggle'), 'show-quick-settings'));
        generalGroup.add(this._switchRow(settings, _('Resume on extension disable'), 'auto-resume-on-disable'));
        generalGroup.add(this._spinRow(settings, _('Refresh interval (s)'), 'refresh-interval', 2, 300, 1));

        const pathsGroup = new Adw.PreferencesGroup({ title: _('System files') });
        page.add(pathsGroup);
        pathsGroup.add(this._infoRow(_('Helper'), '/usr/local/bin/service-pauser-helper'));
        pathsGroup.add(this._infoRow(_('Services'), '/etc/service-pauser/units.json'));

        window.set_default_size(520, 360);
    }

    _switchRow(settings, label, key) {
        const row = new Adw.ActionRow({ title: label });
        const sw = new Gtk.Switch({
            active: settings.get_boolean(key),
            valign: Gtk.Align.CENTER,
        });
        settings.bind(key, sw, 'active', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(sw);
        row.activatable_widget = sw;
        return row;
    }

    _spinRow(settings, label, key, min, max, step) {
        const row = new Adw.ActionRow({ title: label });
        const adj = new Gtk.Adjustment({
            lower: min,
            upper: max,
            step_increment: step,
            page_increment: step * 5,
            value: settings.get_int(key),
        });
        const spin = new Gtk.SpinButton({
            adjustment: adj,
            digits: 0,
            valign: Gtk.Align.CENTER,
        });
        settings.bind(key, adj, 'value', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(spin);
        row.activatable_widget = spin;
        return row;
    }

    _infoRow(title, subtitle) {
        return new Adw.ActionRow({ title, subtitle });
    }
}
