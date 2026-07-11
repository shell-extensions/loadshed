#!/usr/bin/env bash
set -euo pipefail

EXT_UUID="service-pauser@yurij.de"
HELPER_NAME="service-pauser-helper"
HELPER_INSTALL_PATH="/usr/local/bin/${HELPER_NAME}"
CONFIG_DIR="/etc/service-pauser"
CONFIG_PATH="${CONFIG_DIR}/units.json"
SUDOERS_FILE="/etc/sudoers.d/service-pauser"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

helper_src="${script_dir}/tools/${HELPER_NAME}"
units_src="${script_dir}/tools/units.default.json"
schema_src="${script_dir}/schemas/org.gnome.shell.extensions.service-pauser.gschema.xml"
translation_src="${script_dir}/po/de.po"

if [[ ! -f "${helper_src}" ]]; then
  echo "Helper not found: ${helper_src}" >&2
  exit 1
fi

if [[ ! -f "${units_src}" ]]; then
  echo "Default units file not found: ${units_src}" >&2
  exit 1
fi

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
  "${script_dir}/stylesheet.css" \
  "${script_dir}/README.md" \
  "${bundle_source}/"
"${as_user[@]}" install -m 0755 "${script_dir}/install.sh" "${bundle_source}/install.sh"
"${as_user[@]}" install -m 0755 "${helper_src}" "${bundle_source}/tools/${HELPER_NAME}"
"${as_user[@]}" install -m 0644 "${units_src}" "${bundle_source}/tools/units.default.json"
"${as_user[@]}" install -m 0644 "${schema_src}" "${bundle_source}/schemas/"
"${as_user[@]}" install -m 0644 "${translation_src}" "${bundle_source}/po/"

echo "Packing extension bundle"
(cd "${bundle_source}" && "${as_user[@]}" gnome-extensions pack . --force \
  --podir=po \
  --gettext-domain=service-pauser \
  --extra-source=install.sh \
  --extra-source=README.md \
  --extra-source=appTargets.js \
  --extra-source=gsettingsTargets.js \
  --extra-source=po \
  --extra-source=tools \
  -o "${pack_dir}")

echo "Installing extension bundle"
"${as_user[@]}" gnome-extensions install -f "${pack_dir}/${EXT_UUID}.shell-extension.zip"

echo "Installing helper to ${HELPER_INSTALL_PATH}"
sudo install -o root -g root -m 0755 "${helper_src}" "${HELPER_INSTALL_PATH}"

echo "Installing configuration directory ${CONFIG_DIR}"
sudo install -d -o root -g root -m 0755 "${CONFIG_DIR}"

if sudo test -e "${CONFIG_PATH}"; then
  echo "Keeping existing ${CONFIG_PATH}"
  sudo chown root:root "${CONFIG_PATH}"
  sudo chmod 0644 "${CONFIG_PATH}"
else
  echo "Installing default units to ${CONFIG_PATH}"
  sudo install -o root -g root -m 0644 "${units_src}" "${CONFIG_PATH}"
fi

sudo tee "${SUDOERS_FILE}" >/dev/null <<EOF
Cmnd_Alias SERVICE_PAUSER = ${HELPER_INSTALL_PATH} status, ${HELPER_INSTALL_PATH} pause, ${HELPER_INSTALL_PATH} resume, ${HELPER_INSTALL_PATH} toggle, ${HELPER_INSTALL_PATH} enforce, ${HELPER_INSTALL_PATH} config-get, ${HELPER_INSTALL_PATH} config-set, ${HELPER_INSTALL_PATH} catalog-status
${target_user} ALL=(root) NOPASSWD: SERVICE_PAUSER
EOF

sudo chmod 0440 "${SUDOERS_FILE}"
sudo visudo -c -f "${SUDOERS_FILE}" >/dev/null

echo "Done."
echo "Enable after GNOME Shell reload/login with: gnome-extensions enable ${EXT_UUID}"
