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

if command -v glib-compile-schemas >/dev/null 2>&1; then
  if [[ "${EUID}" -eq 0 && "${target_user}" != "root" ]]; then
    sudo -u "${target_user}" glib-compile-schemas "${script_dir}/schemas"
  else
    glib-compile-schemas "${script_dir}/schemas"
  fi
else
  echo "glib-compile-schemas not found; schema compilation skipped." >&2
fi

local_ext_dir="${target_home}/.local/share/gnome-shell/extensions/${EXT_UUID}"
if [[ "$(readlink -f "${script_dir}")" != "$(readlink -f "${local_ext_dir}" 2>/dev/null || true)" ]]; then
  echo "Extension files are not installed in ${local_ext_dir}."
  echo "Install the bundle with gnome-extensions install -f before enabling."
fi

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
Cmnd_Alias SERVICE_PAUSER = ${HELPER_INSTALL_PATH} status, ${HELPER_INSTALL_PATH} pause, ${HELPER_INSTALL_PATH} resume, ${HELPER_INSTALL_PATH} toggle
${target_user} ALL=(root) NOPASSWD: SERVICE_PAUSER
EOF

sudo chmod 0440 "${SUDOERS_FILE}"
sudo visudo -c -f "${SUDOERS_FILE}" >/dev/null

echo "Done."
echo "Enable after GNOME Shell reload/login with: gnome-extensions enable ${EXT_UUID}"
