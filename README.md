# Service Pauser

GNOME Shell extension for pausing selected background maintenance services from Quick Settings.

The extension delegates privileged work to `/usr/local/bin/service-pauser-helper`.
The helper only reads root-owned units from `/etc/service-pauser/units.json` and uses
`systemctl freeze`/`systemctl thaw` for services. Timers configured next to a service
are stopped while paused and only restarted if the helper stopped them.

## Install

```bash
cd /home/yurij/web/git/service-pauser@yurij.de
glib-compile-schemas schemas
gnome-extensions pack . --force --podir=po --gettext-domain=service-pauser --extra-source=install.sh --extra-source=README.md --extra-source=tools -o /tmp
gnome-extensions install -f /tmp/service-pauser@yurij.de.shell-extension.zip
./install.sh
```

Log out and back in, then enable:

```bash
gnome-extensions enable service-pauser@yurij.de
```

## Configure Services

Edit `/etc/service-pauser/units.json` as root. The default entry is:

```json
[
  {
    "id": "aide",
    "label": "AIDE daily check",
    "service": "dailyaidecheck.service",
    "timer": "dailyaidecheck.timer"
  }
]
```

## Manual Recovery

```bash
sudo /usr/local/bin/service-pauser-helper status
sudo /usr/local/bin/service-pauser-helper resume
```
