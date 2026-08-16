#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Loadshed — Pause configured background maintenance services from GNOME Quick Settings.
# Copyright (C) 2026 yurij.de
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

EXT_UUID="loadshed@yurij.de"
LEGACY_EXT_UUID="service-pauser@yurij.de"
HELPER_NAME="loadshed-helper"
HELPER_INSTALL_PATH="/usr/local/bin/${HELPER_NAME}"
THERMAL_INSTALL_PATH="/usr/local/libexec/loadshed-thermal"
THERMAL_MODULE_DIR="/usr/local/libexec/loadshed"
THERMAL_DAEMON_SRC="${script_dir}/tools/thermal_daemon.py"
THERMAL_POLICY_SRC="${script_dir}/tools/thermal_policy.py"
THERMAL_CONFIG_PATH="/etc/loadshed/thermal.json"
THERMAL_DEFAULT_CONFIG_SRC="${script_dir}/tools/thermal.default.json"
THERMAL_UNIT_SRC="${script_dir}/systemd/loadshed-thermal.service"
THERMAL_UNIT_INSTALL_PATH="/etc/systemd/system/loadshed-thermal.service"
CONFIG_DIR="/etc/loadshed"
CONFIG_PATH="${CONFIG_DIR}/units.json"
SUDOERS_FILE="/etc/sudoers.d/loadshed"
LEGACY_CONFIG_PATH="/etc/service-pauser/units.json"
LEGACY_SUDOERS_FILE="/etc/sudoers.d/service-pauser"

helper_src="${script_dir}/tools/${HELPER_NAME}"
units_src="${script_dir}/tools/units.default.json"
schema_src="${script_dir}/schemas/org.gnome.shell.extensions.loadshed.gschema.xml"

if [[ ! -f "${helper_src}" ]]; then
  echo "Helper not found: ${helper_src}" >&2
  exit 1
fi

if [[ ! -f "${units_src}" ]]; then
  echo "Default units file not found: ${units_src}" >&2
  exit 1
fi

for required_file in "${THERMAL_DAEMON_SRC}" "${THERMAL_POLICY_SRC}" "${THERMAL_DEFAULT_CONFIG_SRC}" "${THERMAL_UNIT_SRC}"; do
  if [[ ! -f "${required_file}" ]]; then
    echo "Required thermal file not found: ${required_file}" >&2
    exit 1
  fi
done

if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo not found. Install sudo or run the privileged setup manually." >&2
  exit 1
fi

if [[ -n "${SUDO_USER:-}" ]]; then
  target_user="${SUDO_USER}"
elif [[ -n "${PKEXEC_UID:-}" ]]; then
  target_user="$(getent passwd "${PKEXEC_UID}" | cut -d: -f1)"
else
  target_user="${USER:-$(id -un)}"
fi

if [[ -z "${target_user}" ]]; then
  echo "Could not determine target user." >&2
  exit 1
fi

if [[ ! "${target_user}" =~ ^[a-z_][a-z0-9._-]*$ ]]; then
  echo "Refusing to write sudoers for unexpected username: ${target_user}" >&2
  exit 1
fi

target_home="$(getent passwd "${target_user}" | cut -d: -f6)"
if [[ -z "${target_home}" ]]; then
  echo "Could not determine home for ${target_user}." >&2
  exit 1
fi

if [[ "${EUID}" -eq 0 && "${target_user}" != "root" ]]; then
  as_user=(sudo -u "${target_user}")
else
  as_user=()
fi

if command -v glib-compile-schemas >/dev/null 2>&1; then
  "${as_user[@]}" glib-compile-schemas "${script_dir}/schemas"
else
  echo "glib-compile-schemas not found; schema compilation skipped." >&2
fi

if ! command -v gnome-extensions >/dev/null 2>&1; then
  echo "gnome-extensions not found. Install gnome-shell and gnome-shell-extensions first." >&2
  exit 1
fi

pack_dir="$("${as_user[@]}" mktemp -d)"
trap 'rm -rf "${pack_dir}"' EXIT
bundle_source="${pack_dir}/source"

"${as_user[@]}" mkdir -p "${bundle_source}/tools" "${bundle_source}/schemas" "${bundle_source}/po"
"${as_user[@]}" install -m 0644 \
  "${script_dir}/metadata.json" \
  "${script_dir}/extension.js" \
  "${script_dir}/prefs.js" \
  "${script_dir}/appTargets.js" \
  "${script_dir}/gsettingsTargets.js" \
  "${script_dir}/fileTargets.js" \
  "${script_dir}/stylesheet.css" \
  "${script_dir}/README.md" \
  "${script_dir}/README.de.md" \
  "${script_dir}/README.es.md" \
  "${bundle_source}/"
"${as_user[@]}" install -m 0755 "${script_dir}/install.sh" "${bundle_source}/install.sh"
"${as_user[@]}" install -m 0755 "${helper_src}" "${bundle_source}/tools/${HELPER_NAME}"
"${as_user[@]}" install -m 0644 "${units_src}" "${bundle_source}/tools/units.default.json"
"${as_user[@]}" install -m 0644 "${THERMAL_DEFAULT_CONFIG_SRC}" "${bundle_source}/tools/thermal.default.json"
"${as_user[@]}" install -m 0644 "${schema_src}" "${bundle_source}/schemas/"
for translation_src in "${script_dir}"/po/*.po; do
  [[ -e "${translation_src}" ]] || continue
  "${as_user[@]}" install -m 0644 "${translation_src}" "${bundle_source}/po/"
done

echo "Packing extension bundle"
(cd "${bundle_source}" && "${as_user[@]}" gnome-extensions pack . --force \
  --podir=po \
  --gettext-domain=loadshed \
  --extra-source=install.sh \
  --extra-source=README.md \
  --extra-source=README.de.md \
  --extra-source=README.es.md \
  --extra-source=appTargets.js \
  --extra-source=gsettingsTargets.js \
  --extra-source=fileTargets.js \
  --extra-source=po \
  --extra-source=tools \
  -o "${pack_dir}")

echo "Installing extension bundle"
"${as_user[@]}" gnome-extensions install -f "${pack_dir}/${EXT_UUID}.shell-extension.zip"

echo "Installing helper to ${HELPER_INSTALL_PATH}"
sudo install -o root -g root -m 0755 "${helper_src}" "${HELPER_INSTALL_PATH}"

echo "Installing thermal daemon to ${THERMAL_INSTALL_PATH}"
sudo install -d -o root -g root -m 0755 "${THERMAL_MODULE_DIR}"
sudo install -o root -g root -m 0755 "${script_dir}/tools/loadshed-thermal" "${THERMAL_INSTALL_PATH}"
sudo install -o root -g root -m 0644 "${THERMAL_DAEMON_SRC}" "${THERMAL_MODULE_DIR}/thermal_daemon.py"
sudo install -o root -g root -m 0644 "${THERMAL_POLICY_SRC}" "${THERMAL_MODULE_DIR}/thermal_policy.py"
sudo install -o root -g root -m 0644 "${THERMAL_UNIT_SRC}" "${THERMAL_UNIT_INSTALL_PATH}"
sudo systemctl daemon-reload

echo "Installing configuration directory ${CONFIG_DIR}"
sudo install -d -o root -g root -m 0755 "${CONFIG_DIR}"

if sudo test -e "${CONFIG_PATH}"; then
  echo "Keeping existing ${CONFIG_PATH}"
  sudo chown root:root "${CONFIG_PATH}"
  sudo chmod 0644 "${CONFIG_PATH}"
elif sudo test -e "${LEGACY_CONFIG_PATH}"; then
  echo "Migrating existing configuration from ${LEGACY_CONFIG_PATH} to ${CONFIG_PATH}"
  sudo install -o root -g root -m 0644 "${LEGACY_CONFIG_PATH}" "${CONFIG_PATH}"
else
  echo "Installing default units to ${CONFIG_PATH}"
  sudo install -o root -g root -m 0644 "${units_src}" "${CONFIG_PATH}"
fi

if sudo test -e "${THERMAL_CONFIG_PATH}"; then
  echo "Keeping existing ${THERMAL_CONFIG_PATH}"
  sudo chown root:root "${THERMAL_CONFIG_PATH}"
  sudo chmod 0644 "${THERMAL_CONFIG_PATH}"
else
  echo "Installing disabled thermal configuration to ${THERMAL_CONFIG_PATH}"
  sudo install -o root -g root -m 0644 "${THERMAL_DEFAULT_CONFIG_SRC}" "${THERMAL_CONFIG_PATH}"
fi

sudo tee "${SUDOERS_FILE}" >/dev/null <<EOF
Cmnd_Alias LOADSHED_HELPER = ${HELPER_INSTALL_PATH} status, ${HELPER_INSTALL_PATH} pause, ${HELPER_INSTALL_PATH} resume, ${HELPER_INSTALL_PATH} toggle, ${HELPER_INSTALL_PATH} enforce, ${HELPER_INSTALL_PATH} config-get, ${HELPER_INSTALL_PATH} config-set, ${HELPER_INSTALL_PATH} catalog-status, ${HELPER_INSTALL_PATH} thermal-status, ${HELPER_INSTALL_PATH} thermal-calibrate, ${HELPER_INSTALL_PATH} thermal-config-get, ${HELPER_INSTALL_PATH} thermal-config-set, ${HELPER_INSTALL_PATH} thermal-enable, ${HELPER_INSTALL_PATH} thermal-disable
${target_user} ALL=(root) NOPASSWD: LOADSHED_HELPER
EOF

sudo chmod 0440 "${SUDOERS_FILE}"
sudo visudo -c -f "${SUDOERS_FILE}" >/dev/null

echo "Done."
echo "Enable after GNOME Shell reload/login with: gnome-extensions enable ${EXT_UUID}"
echo "Thermal governor is installed but disabled until calibration and review: sudo systemctl enable --now loadshed-thermal.service"
if sudo test -e "${LEGACY_SUDOERS_FILE}"; then
  echo "Legacy sudoers file detected. Remove after verifying the new helper works: sudo rm -f ${LEGACY_SUDOERS_FILE}"
fi
if "${as_user[@]}" gnome-extensions info "${LEGACY_EXT_UUID}" >/dev/null 2>&1; then
  echo "Legacy extension UUID detected. Disable the old copy after migration with: gnome-extensions disable ${LEGACY_EXT_UUID}"
fi
