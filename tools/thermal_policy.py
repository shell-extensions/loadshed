#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared validation and discovery helpers for Loadshed thermal control."""

import json
import os
from pathlib import Path
import re
import stat


CONFIG_DIR = "/etc/loadshed"
THERMAL_CONFIG_PATH = f"{CONFIG_DIR}/thermal.json"
THERMAL_STATE_PATH = "/run/loadshed/thermal-state.json"
THERMAL_LOG_PATH = "/run/loadshed/thermal-calibration.jsonl"

PROCESS_NAME_RE = re.compile(r"^[A-Za-z0-9_.@:+-]+$")
ID_RE = re.compile(r"^[A-Za-z0-9_.@:-]+$")

# These names are never valid automatic thermal targets.  The list is a
# defense-in-depth measure; PID/cgroup and UID checks remain authoritative.
PROTECTED_PROCESS_NAMES = frozenset({
    "systemd",
    "init",
    "systemd-journald",
    "systemd-logind",
    "systemd-udevd",
    "dbus-daemon",
    "dbus-broker",
    "NetworkManager",
    "gnome-shell",
    "Xwayland",
    "pipewire",
    "wireplumber",
    "loadshed-thermal",
})

DEFAULT_CONFIG = {
    "version": 1,
    "enabled": False,
    "interval_seconds": 1.0,
    "target_c": None,
    "fan_on_c": None,
    "fan_off_c": None,
    "critical_c": 90.0,
    "throttle_delta_c": 1.0,
    "pause_delta_c": 4.0,
    "resume_delta_c": 3.0,
    "dwell_seconds": 5.0,
    "cooldown_seconds": 15.0,
    "throttle_percent": 25.0,
    "essential": [],
    "important": [],
    "ad_hoc": [],
}


class ThermalPolicyError(Exception):
    """Raised when thermal configuration or state is unsafe."""


def _number(value, name, minimum=None, maximum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ThermalPolicyError(f"{name} must be a number")
    value = float(value)
    if minimum is not None and value < minimum:
        raise ThermalPolicyError(f"{name} must be at least {minimum}")
    if maximum is not None and value > maximum:
        raise ThermalPolicyError(f"{name} must be at most {maximum}")
    return value


def _optional_number(value, name, minimum=None, maximum=None):
    if value is None:
        return None
    return _number(value, name, minimum, maximum)


def _process_name(value, field, allow_protected=False):
    if not isinstance(value, str) or not PROCESS_NAME_RE.fullmatch(value.strip()):
        raise ThermalPolicyError(f"invalid process name in {field}: {value!r}")
    value = value.strip()
    if value in PROTECTED_PROCESS_NAMES and not allow_protected:
        raise ThermalPolicyError(f"protected process cannot be configured as a target: {value}")
    return value


def _process_list(value, field):
    if not isinstance(value, list):
        raise ThermalPolicyError(f"{field} must be a list")
    result = []
    seen = set()
    for item in value:
        process = _process_name(item, field, allow_protected=field == "essential")
        if process in seen:
            raise ThermalPolicyError(f"duplicate process in {field}: {process}")
        seen.add(process)
        result.append(process)
    return result


def validate_config(raw):
    if not isinstance(raw, dict):
        raise ThermalPolicyError("thermal configuration root must be an object")

    version = raw.get("version", 1)
    if version != 1:
        raise ThermalPolicyError(f"unsupported thermal configuration version: {version!r}")

    enabled = raw.get("enabled", False)
    if not isinstance(enabled, bool):
        raise ThermalPolicyError("enabled must be a boolean")

    config = {
        "version": 1,
        "enabled": enabled,
        "interval_seconds": _number(raw.get("interval_seconds", 1.0), "interval_seconds", 0.2, 60.0),
        "target_c": _optional_number(raw.get("target_c"), "target_c", 30.0, 90.0),
        "fan_on_c": _optional_number(raw.get("fan_on_c"), "fan_on_c", 30.0, 99.0),
        "fan_off_c": _optional_number(raw.get("fan_off_c"), "fan_off_c", 25.0, 99.0),
        "critical_c": _number(raw.get("critical_c", 90.0), "critical_c", 60.0, 99.0),
        "throttle_delta_c": _number(raw.get("throttle_delta_c", 1.0), "throttle_delta_c", 0.1, 20.0),
        "pause_delta_c": _number(raw.get("pause_delta_c", 4.0), "pause_delta_c", 0.2, 30.0),
        "resume_delta_c": _number(raw.get("resume_delta_c", 3.0), "resume_delta_c", 0.2, 30.0),
        "dwell_seconds": _number(raw.get("dwell_seconds", 5.0), "dwell_seconds", 0.0, 120.0),
        "cooldown_seconds": _number(raw.get("cooldown_seconds", 15.0), "cooldown_seconds", 0.0, 300.0),
        "throttle_percent": _number(raw.get("throttle_percent", 25.0), "throttle_percent", 1.0, 100.0),
        "essential": _process_list(raw.get("essential", []), "essential"),
        "important": _process_list(raw.get("important", []), "important"),
        "ad_hoc": [],
    }

    if config["pause_delta_c"] < config["throttle_delta_c"]:
        raise ThermalPolicyError("pause_delta_c must not be below throttle_delta_c")
    if config["target_c"] is not None and config["target_c"] >= config["critical_c"]:
        raise ThermalPolicyError("target_c must be below critical_c")
    if config["fan_on_c"] is not None and config["fan_off_c"] is not None:
        if config["fan_off_c"] > config["fan_on_c"]:
            raise ThermalPolicyError("fan_off_c must not exceed fan_on_c")
    if config["target_c"] is not None:
        for fan_limit in (config["fan_on_c"], config["fan_off_c"]):
            if fan_limit is not None and config["target_c"] >= fan_limit:
                raise ThermalPolicyError("target_c must be below calibrated fan limits")

    memberships = {
        process: "essential" for process in config["essential"]
    }
    for process in config["important"]:
        if process in memberships:
            raise ThermalPolicyError(f"process appears in multiple lists: {process}")
        memberships[process] = "important"

    seen_ids = set()
    seen_processes = set()
    for index, raw_entry in enumerate(raw.get("ad_hoc", [])):
        if not isinstance(raw_entry, dict):
            raise ThermalPolicyError(f"ad_hoc entry #{index + 1} is not an object")
        entry_id = raw_entry.get("id")
        if not isinstance(entry_id, str) or not ID_RE.fullmatch(entry_id.strip()):
            raise ThermalPolicyError(f"invalid ad_hoc id: {entry_id!r}")
        entry_id = entry_id.strip()
        if entry_id in seen_ids:
            raise ThermalPolicyError(f"duplicate ad_hoc id: {entry_id}")
        seen_ids.add(entry_id)

        process = _process_name(raw_entry.get("process"), f"ad_hoc[{entry_id}].process")
        if process in memberships:
            raise ThermalPolicyError(f"process appears in multiple lists: {process}")
        if process in seen_processes:
            raise ThermalPolicyError(f"duplicate ad_hoc process: {process}")
        seen_processes.add(process)

        entry_enabled = raw_entry.get("enabled", False)
        if not isinstance(entry_enabled, bool):
            raise ThermalPolicyError(f"ad_hoc[{entry_id}].enabled must be a boolean")
        allow_system = raw_entry.get("allow_system", False)
        if not isinstance(allow_system, bool):
            raise ThermalPolicyError(f"ad_hoc[{entry_id}].allow_system must be a boolean")
        if allow_system:
            raise ThermalPolicyError("allow_system is reserved and cannot be enabled yet")

        config["ad_hoc"].append({
            "id": entry_id,
            "process": process,
            "enabled": entry_enabled,
            "throttle_percent": _number(
                raw_entry.get("throttle_percent", config["throttle_percent"]),
                f"ad_hoc[{entry_id}].throttle_percent",
                1.0,
                100.0,
            ),
        })

    return config


def serialize_config(config):
    validated = validate_config(config)
    return json.loads(json.dumps(validated, sort_keys=True))


def load_config(path=THERMAL_CONFIG_PATH, require_root_owner=True):
    try:
        st = os.stat(path)
    except FileNotFoundError as exc:
        raise ThermalPolicyError(f"configuration missing: {path}") from exc
    if require_root_owner and st.st_uid != 0:
        raise ThermalPolicyError(f"configuration must be owned by root: {path}")
    if st.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise ThermalPolicyError(f"configuration must not be group/world writable: {path}")
    try:
        with open(path, "r", encoding="utf-8") as config_file:
            raw = json.load(config_file)
    except json.JSONDecodeError as exc:
        raise ThermalPolicyError(f"invalid JSON in {path}: {exc}") from exc
    return validate_config(raw)


def save_config(config, path=THERMAL_CONFIG_PATH):
    validated = serialize_config(config)
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, mode=0o755, exist_ok=True)
    temp_path = f"{path}.tmp.{os.getpid()}"
    with open(temp_path, "w", encoding="utf-8") as config_file:
        json.dump(validated, config_file, indent=2, sort_keys=True)
        config_file.write("\n")
    if os.geteuid() == 0:
        os.chown(temp_path, 0, 0)
    os.chmod(temp_path, 0o644)
    os.replace(temp_path, path)
    return validated


def default_config():
    return serialize_config(DEFAULT_CONFIG)


def discover_sensor(sysfs_root="/sys"):
    """Return the best package-temperature sensor without hardcoded hwmon ids."""
    hwmon_root = Path(sysfs_root) / "class" / "hwmon"
    candidates = []
    if hwmon_root.is_dir():
        for hwmon in sorted(hwmon_root.glob("hwmon*")):
            try:
                name = (hwmon / "name").read_text(encoding="utf-8").strip()
            except OSError:
                continue
            for input_path in sorted(hwmon.glob("temp*_input")):
                label_path = input_path.with_name(input_path.name.replace("_input", "_label"))
                try:
                    label = label_path.read_text(encoding="utf-8").strip() if label_path.exists() else ""
                except OSError:
                    label = ""
                score = 0
                if name == "coretemp":
                    score += 100
                if label.lower() == "package id 0":
                    score += 100
                if label.lower() == "cpu":
                    score += 50
                candidates.append((score, str(input_path), label or name))

    thermal_root = Path(sysfs_root) / "class" / "thermal"
    if thermal_root.is_dir():
        for zone in sorted(thermal_root.glob("thermal_zone*")):
            try:
                zone_type = (zone / "type").read_text(encoding="utf-8").strip()
            except OSError:
                continue
            if zone_type == "x86_pkg_temp":
                candidates.append((90, str(zone / "temp"), zone_type))

    if not candidates:
        return None
    candidates.sort(key=lambda item: (-item[0], item[1]))
    score, path, label = candidates[0]
    return {"path": path, "label": label, "score": score}


def discover_fan(sysfs_root="/sys"):
    hwmon_root = Path(sysfs_root) / "class" / "hwmon"
    candidates = []
    if hwmon_root.is_dir():
        for hwmon in sorted(hwmon_root.glob("hwmon*")):
            try:
                name = (hwmon / "name").read_text(encoding="utf-8").strip()
            except OSError:
                continue
            if name != "thinkpad":
                continue
            candidates.extend(str(path) for path in sorted(hwmon.glob("fan*_input")))
    return candidates[0] if candidates else None


def read_temperature(sensor):
    if not sensor:
        raise ThermalPolicyError("CPU temperature sensor not found")
    try:
        raw = Path(sensor["path"]).read_text(encoding="utf-8").strip()
        return float(raw) / 1000.0
    except (OSError, ValueError) as exc:
        raise ThermalPolicyError(f"could not read CPU temperature: {exc}") from exc


def read_fan_rpm(path):
    if not path:
        return None
    try:
        return int(Path(path).read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None
