# Loadshed

GNOME Shell extension for pausing selected background maintenance services from Quick Settings.

The extension delegates privileged work to `/usr/local/bin/service-pauser-helper`.
The helper reads and writes root-owned units in `/etc/service-pauser/units.json` and uses
`systemctl freeze`/`systemctl thaw` for services. Timers configured next to a service
are stopped while paused and only restarted if the helper stopped them. While the
Quick Settings button is paused, refreshes enforce that state again for configured
services that start later.

## Install

```bash
git clone https://github.com/system-extensions/loadshed loadshed@yurij.de
cd loadshed@yurij.de
./install.sh
```

`install.sh` compiles the schemas, packs the extension bundle, installs it with
`gnome-extensions install -f`, and sets up the privileged helper, configuration, and
sudoers rule in one step.

Log out and back in, then enable:

```bash
gnome-extensions enable loadshed@yurij.de
```

The GNOME Shell UUID is `loadshed@yurij.de`. The helper, config directory,
gettext domain, and settings schema still use `service-pauser` for compatibility
with existing installations. Any remaining `service-pauser` paths or commands
below refer to those compatibility interfaces, not to the extension UUID.

If you previously installed the old UUID, disable it after the new extension is
installed:

```bash
gnome-extensions disable service-pauser@yurij.de
```

## Configure Services

Open the extension preferences in GNOME Extensions to add, remove, save, reload,
or restore the built-in maintenance catalog. The default catalog is installed only
when `/etc/service-pauser/units.json` does not already exist; updates keep your
existing configuration. Each service can be enabled or disabled independently.
Disabling or replacing a service while the pause button is active releases only
that service; the other managed services remain paused.

Run `./install.sh` after updating the extension so the helper and sudoers rules
include the configuration and enforce commands.

Advanced users can still edit `/etc/service-pauser/units.json` as root. Built-in
catalog entries are marked optional, so services not installed on the machine are
ignored silently. Custom entries are not optional by default, so mistakes remain
visible in the menu. Entry format:

```json
[
  {
    "id": "aide",
    "label": "AIDE daily check",
    "service": "dailyaidecheck.service",
    "timer": "dailyaidecheck.timer",
    "optional": true,
    "enabled": true
  }
]
```

Snap daemons are normal systemd units and can be added here too. For example,
Snap usually exposes a daemon as `snap.<snap-name>.<service-name>.service`.
Use the exact unit name shown by systemd/snap for that daemon.

## Extension switches

Not everything worth pausing is a systemd unit. The supported
[Folder Size](https://github.com/system-extensions/foldersize) extension scans
folder sizes in Nautilus, Caja, or Nemo and stores its scan toggle in
`~/.config/foldersize.conf`. Loadshed ships a Folder Size file-target preset
that sets `FolderSize:auto_scan=false` while paused and restores the previous
state on resume. The target is handled in the user session, so no root helper is
needed for this switch.

Loadshed can also toggle arbitrary GSettings booleans together with the pause
button. This is configured in Preferences under "GSettings switches",
separately from the systemd service list. Each entry has a schema id, a key,
and the value the key should hold while paused; entries are validated (schema
installed, key exists and is boolean) before being used, and unavailable ones
are skipped silently rather than breaking the extension.

Before changing a managed boolean or file-backed switch, Loadshed records its
current value. Resume restores that exact value instead of assuming the
opposite of the pause value. The saved state also survives a GNOME Shell
restart. The same rule applies to another extension's Quick Settings
visibility: a toggle that was already hidden remains hidden after Loadshed
stops managing it.

Most extensions compile their schema only inside their own extension
directory rather than installing it system-wide, so it won't be found by
plain schema lookup. If that happens ("Schema not installed" in
Preferences even though the extension is installed), set the entry's
"Extension UUID" field (e.g. `foldersize@yurij.de`) — Loadshed then
also looks in that extension's own `schemas/` directory, the same way GNOME
Shell resolves an extension's own settings.

If an entry's target extension also has its own Quick Settings toggle (like
Folder Size's "Scan on/off"), that toggle becomes redundant once Loadshed
manages it — set as `own_toggle_key`, it gets hidden automatically
while managed here and reappears once you disable the switch or Loadshed
itself, provided it was visible before Loadshed took control.

## Desktop apps

Desktop apps that are not systemd services can be configured in Preferences
under "Desktop apps". This is intended for apps such as Flatpak Signal, where
GNOME autostart launches a `.desktop` file instead of a `.service` unit. The
default configuration includes Signal:

```json
{
  "id": "signal",
  "label": "Signal",
  "kind": "flatpak",
  "app_id": "org.signal.Signal",
  "desktop_id": "org.signal.Signal.desktop",
  "enabled": true
}
```

`kind` may be `flatpak` or `snap`. Flatpak targets are stopped with
`flatpak kill <app_id>`. Snap desktop apps are matched by their process command
and stopped with `SIGTERM`. Resume only restarts an app if Loadshed found
it running when pause was activated. If no start command is configured, Loadshed
resumes Flatpak apps with `flatpak run <app_id>` and Snap apps with
`snap run <app_id>`. Set a start command only when an app needs a different
launcher or extra flags, for example a tray/background option.

## Manual Recovery

```bash
sudo /usr/local/bin/service-pauser-helper status
sudo /usr/local/bin/service-pauser-helper resume
sudo /usr/local/bin/service-pauser-helper config-get
```
