# Deslastre (Loadshed)

[English](README.md) | [Deutsch](README.de.md) | **Español**

Loadshed (deslastre) es una extensión de GNOME Shell para pausar servicios de mantenimiento en segundo plano seleccionados desde los ajustes rápidos.

La extensión delega el trabajo privilegiado en `/usr/local/bin/loadshed-helper`.
El helper lee y escribe unidades propiedad de root en `/etc/loadshed/units.json` y usa
`systemctl freeze`/`systemctl thaw` para los servicios. Los temporizadores configurados junto a un
servicio se detienen durante la pausa y solo se reinician si el helper los detuvo. Mientras el botón
de los ajustes rápidos está pausado, las actualizaciones vuelven a aplicar ese estado a los servicios
configurados que arranquen más tarde.

## Capturas de pantalla

![Menú de Loadshed con servicios en ejecución](image/loadshed-running.png)
![Menú de Loadshed con servicios pausados](image/loadshed-paused.png)

## Instalación

```bash
git clone https://github.com/shell-extensions/loadshed
cd loadshed
./install.sh
```

`install.sh` compila los schemas, empaqueta la extensión, la instala con
`gnome-extensions install -f` y configura el helper privilegiado, la configuración y la regla de
sudoers en un solo paso.

Cierra sesión y vuelve a entrar, después activa:

```bash
gnome-extensions enable loadshed@yurij.de
```

El checkout de código fuente se llama `loadshed`, mientras que la UUID de GNOME Shell y el directorio
de la extensión instalada son `loadshed@yurij.de`. El helper, el directorio de configuración, el
dominio gettext y el schema de ajustes usan todos el nombre de Loadshed.

## Configurar servicios

Abre las preferencias de la extensión en GNOME Extensions para añadir, eliminar, guardar, recargar o
restaurar el catálogo de mantenimiento integrado. El catálogo predeterminado solo se instala cuando
`/etc/loadshed/units.json` aún no existe; las actualizaciones conservan tu configuración
existente. Cada servicio puede activarse o desactivarse de forma independiente. Si se desactiva o
reemplaza un servicio mientras el botón de pausa está activo, solo se libera ese servicio; los demás
servicios gestionados permanecen pausados.

Ejecuta `./install.sh` después de actualizar la extensión para que el helper y las reglas sudoers
incluyan los comandos de configuración y aplicación.

Los usuarios avanzados pueden seguir editando `/etc/loadshed/units.json` como root. Las entradas
integradas del catálogo están marcadas como opcionales, por lo que los servicios no instalados en la
máquina se ignoran silenciosamente. Las entradas personalizadas no son opcionales por defecto, para
que los errores sigan visibles en el menú. Formato de entrada:

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

Los daemons de Snap son unidades systemd normales y también pueden añadirse aquí. Snap suele exponer
un daemon como `snap.<snap-name>.<service-name>.service`. Usa el nombre exacto de la unidad mostrado
por systemd/snap para ese daemon.

## Interruptores de extensión

No todo lo que merece pausarse es una unidad systemd. La extensión compatible
[Folder Size](https://github.com/nautilus-extensions/foldersize) escanea tamaños de carpetas en
Nautilus, Caja o Nemo y guarda su interruptor de escaneo en `~/.config/foldersize.conf`. Loadshed
incluye un preset de objetivo de archivo para Folder Size que establece `FolderSize:auto_scan=false`
durante la pausa y restaura el estado anterior al reanudar. El objetivo se gestiona en la sesión del
usuario, por lo que no se necesita helper root para este interruptor.

Loadshed también puede alternar valores booleanos arbitrarios de GSettings junto con el botón de
pausa. Esto se configura en Preferencias, en "GSettings switches", separado de la lista de servicios
systemd. Cada entrada tiene un ID de schema, una clave y el valor que la clave debe tener durante la
pausa; las entradas se validan antes de usarse (schema instalado, clave existente y booleana), y las
no disponibles se omiten silenciosamente en lugar de romper la extensión.

Antes de cambiar un booleano gestionado o un interruptor basado en archivo, Loadshed registra su valor
actual. Al reanudar restaura exactamente ese valor en vez de asumir el opuesto del valor de pausa. El
estado guardado también sobrevive a un reinicio de GNOME Shell. La misma regla se aplica a la
visibilidad del interruptor de ajustes rápidos de otra extensión: un interruptor que ya estaba oculto
permanece oculto después de que Loadshed deje de gestionarlo.

La mayoría de las extensiones compilan su schema solo dentro de su propio directorio de extensión, en
lugar de instalarlo en todo el sistema, así que no aparece con una búsqueda de schema normal. Si eso
ocurre ("Schema not installed" en Preferencias aunque la extensión esté instalada), define el campo
"Extension UUID" de la entrada (por ejemplo, `foldersize@yurij.de`); Loadshed también buscará en el
directorio `schemas/` de esa extensión, igual que GNOME Shell resuelve los ajustes propios de una
extensión.

Si la extensión objetivo de una entrada también tiene su propio interruptor de ajustes rápidos (como
"Scan on/off" de Folder Size), ese interruptor se vuelve redundante cuando Loadshed lo gestiona.
Configurado como `own_toggle_key`, se oculta automáticamente mientras se gestiona aquí y vuelve a
aparecer cuando desactivas el interruptor o Loadshed, siempre que antes fuera visible.

## Aplicaciones de escritorio

Las aplicaciones de escritorio que no son servicios systemd pueden configurarse en Preferencias, en
"Desktop apps". Esto está pensado para aplicaciones como Flatpak Signal, donde el autostart de GNOME
lanza un archivo `.desktop` en lugar de una unidad `.service`. La configuración predeterminada incluye
Signal:

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

`kind` puede ser `flatpak` o `snap`. Los objetivos Flatpak se detienen con
`flatpak kill <app_id>`. Las aplicaciones de escritorio Snap se identifican por su comando de proceso
y se detienen con `SIGTERM`. Al reanudar, una aplicación solo se reinicia si Loadshed la encontró en
ejecución cuando se activó la pausa. Si no hay comando de inicio configurado, Loadshed reanuda las
aplicaciones Flatpak con `flatpak run <app_id>` y las Snap con `snap run <app_id>`. Define un comando
de inicio solo cuando una aplicación necesite otro lanzador o flags adicionales, por ejemplo una
opción de bandeja o segundo plano.

## Recuperación manual

```bash
sudo /usr/local/bin/loadshed-helper status
sudo /usr/local/bin/loadshed-helper resume
sudo /usr/local/bin/loadshed-helper config-get
```

## Licencia

Loadshed es software libre, publicado bajo la GNU General Public License v3.0 o posterior
(GPL-3.0-or-later). El texto completo está disponible en el archivo [LICENSE](LICENSE).
