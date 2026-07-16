# Loadshed

[English](README.md) | **Deutsch** | [Español](README.es.md)

GNOME-Shell-Erweiterung zum Pausieren ausgewählter Hintergrund-Wartungsdienste über die Schnelleinstellungen.

Die Erweiterung delegiert privilegierte Arbeit an `/usr/local/bin/service-pauser-helper`.
Der Helper liest und schreibt root-eigene Units in `/etc/service-pauser/units.json` und nutzt
`systemctl freeze`/`systemctl thaw` für Dienste. Timer, die neben einem Dienst konfiguriert sind,
werden während der Pause gestoppt und nur dann neu gestartet, wenn der Helper sie selbst gestoppt hat.
Solange der Schalter in den Schnelleinstellungen pausiert ist, erzwingen Aktualisierungen diesen
Zustand erneut für konfigurierte Dienste, die später starten.

## Bildschirmfotos

![Loadshed-Menü mit laufenden Diensten](image/loadshed-running.png)
![Loadshed-Menü mit pausierten Diensten](image/loadshed-paused.png)

## Installation

```bash
git clone https://github.com/system-extensions/loadshed
cd loadshed
./install.sh
```

`install.sh` kompiliert die Schemas, packt das Erweiterungsbundle, installiert es mit
`gnome-extensions install -f` und richtet den privilegierten Helper, die Konfiguration und die
sudoers-Regel in einem Schritt ein.

Melde dich ab und wieder an, aktiviere dann:

```bash
gnome-extensions enable loadshed@yurij.de
```

Der Source-Checkout heißt `loadshed`, während die GNOME-Shell-UUID und das installierte
Erweiterungsverzeichnis `loadshed@yurij.de` heißen. Helper, Konfigurationsverzeichnis,
gettext-Domain und Settings-Schema verwenden aus Kompatibilitätsgründen weiterhin
`service-pauser`. Alle verbleibenden `service-pauser`-Pfade oder Befehle unten beziehen sich
auf diese Kompatibilitätsschnittstellen, nicht auf die Erweiterungs-UUID.

## Dienste konfigurieren

Öffne die Erweiterungseinstellungen in GNOME Extensions, um den eingebauten Wartungskatalog
hinzuzufügen, zu entfernen, zu speichern, neu zu laden oder wiederherzustellen. Der Standardkatalog
wird nur installiert, wenn `/etc/service-pauser/units.json` noch nicht existiert; Aktualisierungen
behalten deine bestehende Konfiguration. Jeder Dienst kann unabhängig aktiviert oder deaktiviert
werden. Wird ein Dienst deaktiviert oder ersetzt, während der Pause-Schalter aktiv ist, wird nur
dieser Dienst freigegeben; die anderen verwalteten Dienste bleiben pausiert.

Führe nach einer Aktualisierung der Erweiterung `./install.sh` aus, damit Helper und sudoers-Regeln
die Konfigurations- und Erzwingungsbefehle enthalten.

Fortgeschrittene Nutzer können `/etc/service-pauser/units.json` weiterhin als root direkt bearbeiten.
Eingebaute Katalogeinträge sind als optional markiert, sodass nicht installierte Dienste auf der
Maschine still ignoriert werden. Benutzerdefinierte Einträge sind standardmäßig nicht optional,
damit Fehler im Menü sichtbar bleiben. Eintragsformat:

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

Snap-Daemons sind normale systemd-Units und können hier ebenfalls hinzugefügt werden. Snap stellt
einen Daemon normalerweise als `snap.<snap-name>.<service-name>.service` bereit. Verwende den exakten
Unit-Namen, den systemd/snap für diesen Daemon anzeigt.

## Erweiterungsschalter

Nicht alles, was sich zu pausieren lohnt, ist eine systemd-Unit. Die unterstützte
[Folder Size](https://github.com/system-extensions/foldersize)-Erweiterung scannt Ordnergrößen in
Nautilus, Caja oder Nemo und speichert ihren Scan-Schalter in `~/.config/foldersize.conf`. Loadshed
liefert ein Folder-Size-Dateiziel-Preset mit, das während der Pause `FolderSize:auto_scan=false`
setzt und beim Fortsetzen den vorherigen Zustand wiederherstellt. Das Ziel wird in der
Benutzersitzung behandelt, daher ist für diesen Schalter kein root-Helper nötig.

Loadshed kann zusammen mit dem Pause-Schalter auch beliebige GSettings-Boolean-Werte umschalten.
Das wird in den Einstellungen unter "GSettings switches" konfiguriert, getrennt von der
systemd-Dienstliste. Jeder Eintrag hat eine Schema-ID, einen Schlüssel und den Wert, den der
Schlüssel während der Pause haben soll; Einträge werden vor der Nutzung validiert (Schema
installiert, Schlüssel vorhanden und Boolean), und nicht verfügbare Einträge werden still
übersprungen, statt die Erweiterung zu blockieren.

Bevor Loadshed einen verwalteten Boolean oder dateibasierten Schalter ändert, zeichnet es dessen
aktuellen Wert auf. Beim Fortsetzen wird genau dieser Wert wiederhergestellt, statt das Gegenteil
des Pause-Werts anzunehmen. Der gespeicherte Zustand überlebt auch einen GNOME-Shell-Neustart.
Dieselbe Regel gilt für die Sichtbarkeit eines Quick-Settings-Schalters einer anderen Erweiterung:
Ein bereits versteckter Schalter bleibt versteckt, nachdem Loadshed ihn nicht mehr verwaltet.

Die meisten Erweiterungen kompilieren ihr Schema nur im eigenen Erweiterungsverzeichnis, statt es
systemweit zu installieren, sodass es bei einfacher Schema-Suche nicht gefunden wird. Wenn das
passiert ("Schema not installed" in den Einstellungen, obwohl die Erweiterung installiert ist),
setze das Feld "Extension UUID" des Eintrags (z. B. `foldersize@yurij.de`) - Loadshed sucht dann
auch im eigenen `schemas/`-Verzeichnis dieser Erweiterung, so wie GNOME Shell die eigenen
Einstellungen einer Erweiterung auflöst.

Wenn die Zielerweiterung eines Eintrags auch einen eigenen Quick-Settings-Schalter hat (wie
Folder Sizes "Scan on/off"), wird dieser Schalter redundant, sobald Loadshed ihn verwaltet.
Als `own_toggle_key` gesetzt, wird er automatisch versteckt, solange er hier verwaltet wird, und
erscheint wieder, sobald du den Schalter oder Loadshed selbst deaktivierst, sofern er vorher
sichtbar war.

## Desktop-Apps

Desktop-Apps, die keine systemd-Dienste sind, können in den Einstellungen unter "Desktop apps"
konfiguriert werden. Das ist für Apps wie Flatpak Signal gedacht, bei denen GNOME Autostart eine
`.desktop`-Datei statt einer `.service`-Unit startet. Die Standardkonfiguration enthält Signal:

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

`kind` kann `flatpak` oder `snap` sein. Flatpak-Ziele werden mit `flatpak kill <app_id>` gestoppt.
Snap-Desktop-Apps werden über ihren Prozessbefehl erkannt und mit `SIGTERM` gestoppt. Beim Fortsetzen
wird eine App nur neu gestartet, wenn Loadshed sie beim Aktivieren der Pause laufend vorgefunden hat.
Wenn kein Startbefehl konfiguriert ist, setzt Loadshed Flatpak-Apps mit `flatpak run <app_id>` und
Snap-Apps mit `snap run <app_id>` fort. Setze einen Startbefehl nur, wenn eine App einen anderen
Launcher oder zusätzliche Flags benötigt, zum Beispiel eine Tray-/Hintergrundoption.

## Manuelle Wiederherstellung

```bash
sudo /usr/local/bin/service-pauser-helper status
sudo /usr/local/bin/service-pauser-helper resume
sudo /usr/local/bin/service-pauser-helper config-get
```
