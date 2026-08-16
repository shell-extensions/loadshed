#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Temperature-driven process throttling for Loadshed.

The daemon deliberately leaves ThinkPad fan control to firmware.  It only
uses cgroup v2 CPU limits and freezer state for explicitly configured,
non-root ad-hoc processes.
"""

import errno
import fcntl
import json
import math
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

from thermal_policy import (
    PROTECTED_PROCESS_NAMES,
    THERMAL_CONFIG_PATH,
    THERMAL_LOG_PATH,
    THERMAL_STATE_PATH,
    ThermalPolicyError,
    discover_fan,
    discover_sensor,
    load_config,
    read_fan_rpm,
    read_temperature,
    save_config,
)


CGROUP_ROOT = "/sys/fs/cgroup"
THERMAL_CGROUP_ROOT = f"{CGROUP_ROOT}/loadshed-thermal"
CGROUP_PERIOD_US = 100000
MAX_CALIBRATION_SECONDS = 180
CALIBRATION_ABORT_C = 85.0


def json_print(payload):
    print(json.dumps(payload, sort_keys=True, separators=(",", ":")))


def systemd_notify(message):
    notify_socket = os.environ.get("NOTIFY_SOCKET")
    if not notify_socket:
        return
    address = notify_socket
    if address.startswith("@"):
        address = "\0" + address[1:]
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as notify:
            notify.connect(address)
            notify.sendall(message.encode("utf-8"))
    except OSError:
        pass


def read_proc_stat(pid, proc_root="/proc"):
    try:
        text = Path(proc_root, str(pid), "stat").read_text(encoding="utf-8")
    except OSError:
        return None
    parts = text.rsplit(") ", 1)
    if len(parts) != 2:
        return None
    fields = parts[1].split()
    if len(fields) < 20:
        return None
    try:
        return {
            "pid": int(pid),
            "state": fields[0],
            "utime": int(fields[11]),
            "stime": int(fields[12]),
            "start_time": fields[19],
        }
    except ValueError:
        return None


def read_proc_comm(pid, proc_root="/proc"):
    try:
        return Path(proc_root, str(pid), "comm").read_text(encoding="utf-8").strip()
    except OSError:
        return None


def read_proc_uid(pid, proc_root="/proc"):
    try:
        text = Path(proc_root, str(pid), "status").read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        if line.startswith("Uid:"):
            fields = line.split()
            try:
                return int(fields[1])
            except (IndexError, ValueError):
                return None
    return None


def read_proc_cgroup(pid, proc_root="/proc"):
    try:
        text = Path(proc_root, str(pid), "cgroup").read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        if line.startswith("0::"):
            return line[3:] or "/"
    return None


def process_is_same(pid, process, start_time, proc_root="/proc"):
    stat = read_proc_stat(pid, proc_root)
    return bool(
        stat and
        read_proc_comm(pid, proc_root) == process and
        stat["start_time"] == str(start_time)
    )


def list_processes(process_names, proc_root="/proc", excluded_pids=None):
    excluded_pids = set(excluded_pids or ())
    names = set(process_names)
    result = []
    try:
        entries = os.listdir(proc_root)
    except OSError:
        return result
    for entry in entries:
        if not entry.isdigit():
            continue
        pid = int(entry)
        if pid in excluded_pids:
            continue
        comm = read_proc_comm(pid, proc_root)
        if comm not in names:
            continue
        stat = read_proc_stat(pid, proc_root)
        uid = read_proc_uid(pid, proc_root)
        cgroup = read_proc_cgroup(pid, proc_root)
        if not stat or uid is None or cgroup is None:
            continue
        result.append({
            **stat,
            "comm": comm,
            "uid": uid,
            "cgroup": cgroup,
        })
    return result


def cpu_percent(previous, current, elapsed, ticks_per_second):
    if not previous or elapsed <= 0:
        return 0.0
    delta = (current["utime"] + current["stime"]) - (previous["utime"] + previous["stime"])
    return max(0.0, delta / ticks_per_second / elapsed * 100.0)


def safe_group_name(entry_id):
    return "".join(char if char.isalnum() or char in "._-" else "_" for char in entry_id)


class CgroupManager:
    def __init__(self, root=THERMAL_CGROUP_ROOT):
        self.root = Path(root)

    def group_path(self, entry_id):
        return self.root / f"ad-hoc-{safe_group_name(entry_id)}"

    def ensure(self, entry_id):
        path = self.group_path(entry_id)
        path.mkdir(mode=0o755, parents=True, exist_ok=True)
        return path

    @staticmethod
    def _write(path, value):
        try:
            Path(path).write_text(f"{value}\n", encoding="utf-8")
        except OSError as exc:
            raise ThermalPolicyError(f"cannot write {path}: {exc}") from exc

    def set_quota(self, entry_id, percent):
        path = self.ensure(entry_id)
        quota = max(1000, min(CGROUP_PERIOD_US, round(percent / 100.0 * CGROUP_PERIOD_US)))
        self._write(path / "cpu.max", f"{quota} {CGROUP_PERIOD_US}")

    def clear_quota(self, entry_id):
        path = self.group_path(entry_id)
        if path.exists():
            self._write(path / "cpu.max", f"max {CGROUP_PERIOD_US}")

    def freeze(self, entry_id):
        self._write(self.ensure(entry_id) / "cgroup.freeze", "1")

    def thaw(self, entry_id):
        path = self.group_path(entry_id)
        if (path / "cgroup.freeze").exists():
            self._write(path / "cgroup.freeze", "0")

    def move(self, entry_id, pid):
        self._write(self.ensure(entry_id) / "cgroup.procs", pid)

    def move_back(self, original_cgroup, pid):
        if not original_cgroup or original_cgroup == "/":
            target = Path(CGROUP_ROOT)
        else:
            target = Path(CGROUP_ROOT, original_cgroup.lstrip("/"))
        if not target.exists():
            target = Path(CGROUP_ROOT)
        self._write(target / "cgroup.procs", pid)

    def remove(self, entry_id):
        path = self.group_path(entry_id)
        try:
            path.rmdir()
        except OSError as exc:
            if exc.errno not in (errno.ENOENT, errno.ENOTEMPTY, errno.EBUSY):
                raise


class ThermalController:
    def __init__(self, config_path=THERMAL_CONFIG_PATH, state_path=THERMAL_STATE_PATH,
                 sysfs_root="/sys", proc_root="/proc", cgroup_root=THERMAL_CGROUP_ROOT,
                 require_root_owner=True):
        self.config_path = config_path
        self.state_path = state_path
        self.sysfs_root = sysfs_root
        self.proc_root = proc_root
        self.require_root_owner = require_root_owner
        self.cgroups = CgroupManager(cgroup_root)
        self.ticks_per_second = os.sysconf(os.sysconf_names["SC_CLK_TCK"])
        self.previous = {}
        self.last_sample = None
        self.stage = "normal"
        self.stage_since = time.monotonic()
        self.pending_stage = None
        self.pending_since = None
        self.cool_since = None
        self.dwell_seconds = 5.0
        self.cooldown_seconds = 15.0
        self.interval_seconds = 1.0
        self.managed = {}
        self._load_state()
        self.sensor = None
        self.fan = None

    def load(self):
        return load_config(self.config_path, require_root_owner=self.require_root_owner)

    def discover(self):
        self.sensor = discover_sensor(self.sysfs_root)
        self.fan = discover_fan(self.sysfs_root)
        return self.sensor, self.fan

    def _load_state(self):
        try:
            with open(self.state_path, "r", encoding="utf-8") as state_file:
                state = json.load(state_file)
        except (OSError, json.JSONDecodeError):
            return
        if isinstance(state, dict):
            if isinstance(state.get("stage"), str):
                self.stage = state["stage"]
            if isinstance(state.get("stage_since"), (int, float)):
                self.stage_since = float(state["stage_since"])
            if isinstance(state.get("managed"), dict):
                self.managed = state["managed"]

    def read_temperature(self):
        if self.sensor is None:
            self.discover()
        return read_temperature(self.sensor)

    def _save_state(self):
        state = {
            "stage": self.stage,
            "stage_since": self.stage_since,
            "managed": getattr(self, "managed", {}),
        }
        path = Path(self.state_path)
        path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        temp_path = Path(f"{path}.tmp")
        with temp_path.open("w", encoding="utf-8") as state_file:
            json.dump(state, state_file, sort_keys=True, separators=(",", ":"))
            state_file.write("\n")
        os.chmod(temp_path, 0o644)
        os.replace(temp_path, path)

    def _managed_for(self, entry_id):
        if not hasattr(self, "managed"):
            self.managed = {}
        return self.managed.setdefault(entry_id, {})

    def _processes_for(self, entry, now):
        matches = list_processes([entry["process"]], self.proc_root, {os.getpid()})
        values = []
        for process in matches:
            if process["uid"] == 0 or process["comm"] in PROTECTED_PROCESS_NAMES:
                continue
            if process["pid"] <= 1:
                continue
            previous = self.previous.get(process["pid"])
            process["cpu_percent"] = cpu_percent(
                previous,
                process,
                now - self.last_sample if self.last_sample is not None else 0,
                self.ticks_per_second,
            )
            if previous and previous.get("start_time") != process["start_time"]:
                process["cpu_percent"] = 0.0
            self.previous[process["pid"]] = process
            values.append(process)
        return values

    def _record_process(self, entry_id, process):
        managed = self._managed_for(entry_id)
        pid_key = str(process["pid"])
        record = managed.setdefault("processes", {}).get(pid_key)
        if record and record.get("start_time") == process["start_time"]:
            return record
        record = {
            "process": process["comm"],
            "start_time": process["start_time"],
            "original_cgroup": process["cgroup"],
            "uid": process["uid"],
        }
        managed.setdefault("processes", {})[pid_key] = record
        return record

    def _move_processes(self, entry_id, processes):
        for process in processes:
            record = self._record_process(entry_id, process)
            try:
                if process["cgroup"] != f"/loadshed-thermal/ad-hoc-{safe_group_name(entry_id)}":
                    self.cgroups.move(entry_id, process["pid"])
            except ThermalPolicyError:
                # A process that cannot be moved is not paused by fallback
                # signals.  Keep the controller fail-safe and report it.
                record["move_error"] = True

    def _release_entry(self, entry_id):
        managed = getattr(self, "managed", {}).get(entry_id)
        if not managed:
            return
        try:
            self.cgroups.thaw(entry_id)
            self.cgroups.clear_quota(entry_id)
        except ThermalPolicyError:
            managed["cleanup_error"] = True
        for pid, record in list((managed.get("processes") or {}).items()):
            pid_int = int(pid)
            if process_is_same(pid_int, record.get("process"), record.get("start_time"), self.proc_root):
                try:
                    self.cgroups.move_back(record.get("original_cgroup"), pid_int)
                except ThermalPolicyError:
                    managed["cleanup_error"] = True
            else:
                managed["processes"].pop(pid, None)
        if not managed.get("processes") and not managed.get("cleanup_error"):
            self.cgroups.remove(entry_id)
            self.managed.pop(entry_id, None)

    def release_all(self):
        for entry_id in list(getattr(self, "managed", {})):
            self._release_entry(entry_id)
        self.stage = "normal"
        self.stage_since = time.monotonic()
        self.cool_since = None
        if getattr(self, "managed", {}):
            self._save_state()
        else:
            try:
                Path(self.state_path).unlink()
            except FileNotFoundError:
                pass

    def _apply_throttle(self, entries, process_map):
        selected = []
        for entry in entries:
            processes = process_map.get(entry["id"], [])
            if processes:
                selected.append((max(p["cpu_percent"] for p in processes), entry, processes))
        selected.sort(key=lambda item: item[0], reverse=True)
        if not selected:
            self.release_all()
            return

        # Only the current largest ad-hoc consumer is throttled first.  The
        # pause stage handles all explicit ad-hoc targets if heat persists.
        selected_entry = selected[0][1]
        selected_processes = selected[0][2]
        self._move_processes(selected_entry["id"], selected_processes)
        self.cgroups.thaw(selected_entry["id"])
        percent = selected_entry.get("throttle_percent", 25.0)
        self.cgroups.set_quota(selected_entry["id"], percent)
        managed = self._managed_for(selected_entry["id"])
        managed["stage"] = "throttled"
        for _, entry, _ in selected[1:]:
            self._release_entry(entry["id"])
        self.stage = "throttled"

    def _apply_pause(self, entries, process_map):
        for entry in entries:
            processes = process_map.get(entry["id"], [])
            if not processes:
                continue
            self._move_processes(entry["id"], processes)
            self.cgroups.set_quota(entry["id"], entry.get("throttle_percent", 25.0))
            self.cgroups.freeze(entry["id"])
            self._managed_for(entry["id"])["stage"] = "paused"
        self.stage = "critical" if self.stage == "critical" else "paused"

    def _transition(self, desired, entries, process_map, now):
        if desired == self.stage:
            self.pending_stage = None
            self.pending_since = None
            return
        if self.pending_stage != desired:
            self.pending_stage = desired
            self.pending_since = now
        elapsed = now - self.pending_since
        required = 0.0 if desired in ("normal", "critical") else self.dwell_seconds
        if desired == "normal":
            required = self.cooldown_seconds
        if elapsed < required:
            return
        if desired == "normal":
            self.release_all()
        elif desired == "throttled":
            self._apply_throttle(entries, process_map)
        elif desired in ("paused", "critical"):
            self.stage = desired
            self._apply_pause(entries, process_map)
        self.stage = desired
        self.stage_since = now
        self.pending_stage = None
        self.pending_since = None
        self._save_state()

    def run_once(self):
        config = self.load()
        self.dwell_seconds = config["dwell_seconds"]
        self.cooldown_seconds = config["cooldown_seconds"]
        self.interval_seconds = config["interval_seconds"]
        self.discover()
        if not config["enabled"] or config["target_c"] is None:
            self.release_all()
            return self.status(config, None, "disabled" if not config["enabled"] else "calibration-required")

        now = time.monotonic()
        temperature = self.read_temperature()
        entries = [entry for entry in config["ad_hoc"] if entry["enabled"]]
        process_map = {entry["id"]: self._processes_for(entry, now) for entry in entries}
        has_active_ad_hoc = any(process_map.values())

        target = config["target_c"]
        if temperature >= config["critical_c"]:
            desired = "critical"
        elif temperature >= target + config["pause_delta_c"]:
            desired = "paused"
        elif temperature >= target + config["throttle_delta_c"]:
            desired = "throttled"
        elif temperature <= target - config["resume_delta_c"]:
            desired = "normal"
        else:
            desired = self.stage

        if desired in ("throttled", "paused") and not has_active_ad_hoc:
            desired = "normal"

        self._transition(desired, entries, process_map, now)
        self.last_sample = now
        return self.status(config, temperature, None)

    def status(self, config=None, temperature=None, error=None):
        config = config or self.load()
        if self.sensor is None or self.fan is None:
            self.discover()
        if temperature is None and self.sensor:
            try:
                temperature = read_temperature(self.sensor)
            except ThermalPolicyError:
                pass
        return {
            "ok": error is None,
            "action": "thermal-status",
            "enabled": config["enabled"],
            "stage": self.stage,
            "temperature_c": temperature,
            "target_c": config["target_c"],
            "fan_on_c": config["fan_on_c"],
            "fan_off_c": config["fan_off_c"],
            "critical_c": config["critical_c"],
            "sensor": self.sensor,
            "fan_path": self.fan,
            "fan_rpm": read_fan_rpm(self.fan),
            "managed": getattr(self, "managed", {}),
            "error": error,
        }

    def run(self):
        lock_path = Path("/run/loadshed/thermal.lock")
        lock_path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        with lock_path.open("w", encoding="utf-8") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            systemd_notify("READY=1\nSTATUS=temperature governor running")
            while True:
                try:
                    status = self.run_once()
                    systemd_notify(
                        f"WATCHDOG=1\nSTATUS=stage={status.get('stage')} "
                        f"temperature={status.get('temperature_c')}"
                    )
                except (OSError, ThermalPolicyError) as exc:
                    self.release_all()
                    self.stage = "sensor-error"
                    self.stage_since = time.monotonic()
                    self._save_state()
                    print(f"loadshed-thermal: {exc}", file=sys.stderr)
                    systemd_notify(f"WATCHDOG=1\nSTATUS=sensor error: {exc}")
                time.sleep(self.interval_seconds)


def append_calibration_log(record, path=THERMAL_LOG_PATH):
    target = Path(path)
    target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    with target.open("a", encoding="utf-8") as log_file:
        log_file.write(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n")


def calibration_worker():
    value = 0.123
    while True:
        value = math.sin(value) * math.cos(value + 0.1) + 0.123


def calibrate(config_path=THERMAL_CONFIG_PATH, sysfs_root="/sys", duration=MAX_CALIBRATION_SECONDS):
    config = load_config(config_path)
    sensor = discover_sensor(sysfs_root)
    fan = discover_fan(sysfs_root)
    if not sensor:
        raise ThermalPolicyError("calibration requires a CPU temperature sensor")
    initial_rpm = read_fan_rpm(fan)
    if initial_rpm and initial_rpm > 0:
        raise ThermalPolicyError("calibration requires the fan to be off at start")

    workers = []
    samples = []
    start = time.monotonic()
    fan_on_c = None
    try:
        worker_path = Path(__file__).resolve()
        count = max(1, min(os.cpu_count() or 1, 4))
        for index in range(count):
            workers.append(subprocess.Popen([sys.executable, str(worker_path), "calibration-worker"]))
            step_end = min(time.monotonic() + 10.0, start + duration)
            while time.monotonic() < step_end:
                temperature = read_temperature(sensor)
                rpm = read_fan_rpm(fan)
                record = {
                    "timestamp": time.time(),
                    "temperature_c": temperature,
                    "fan_rpm": rpm,
                    "workers": index + 1,
                }
                samples.append(record)
                append_calibration_log(record)
                if temperature >= CALIBRATION_ABORT_C:
                    raise ThermalPolicyError("calibration aborted at the safety temperature")
                if rpm and rpm > 0 and fan_on_c is None:
                    fan_on_c = temperature
                time.sleep(1.0)
            if time.monotonic() >= start + duration:
                break
    finally:
        for worker in workers:
            worker.send_signal(signal.SIGTERM)
        for worker in workers:
            try:
                worker.wait(timeout=3)
            except subprocess.TimeoutExpired:
                worker.kill()

    if fan_on_c is None:
        raise ThermalPolicyError("calibration did not observe a fan start")
    fan_off_c = min(
        (record["temperature_c"] for record in reversed(samples) if record["fan_rpm"] in (None, 0)),
        default=fan_on_c - 2.0,
    )
    target_c = min(fan_on_c - 5.0, fan_off_c - 3.0)
    if target_c < 35.0:
        raise ThermalPolicyError("calibration produced an unsafe target temperature")

    updated = dict(config)
    updated.update({
        "target_c": round(target_c, 1),
        "fan_on_c": round(fan_on_c, 1),
        "fan_off_c": round(fan_off_c, 1),
        "enabled": False,
    })
    save_config(updated, config_path)
    return {
        "ok": True,
        "action": "thermal-calibrate",
        "target_c": updated["target_c"],
        "fan_on_c": updated["fan_on_c"],
        "fan_off_c": updated["fan_off_c"],
        "samples": len(samples),
        "enabled": False,
    }


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    action = argv[0] if argv else "status"
    try:
        if action == "calibration-worker":
            calibration_worker()
            return 0
        controller = ThermalController()
        if action == "daemon":
            controller.run()
            return 0
        if action == "status":
            json_print(controller.status())
            return 0
        if action == "cleanup":
            controller.release_all()
            json_print({"ok": True, "action": "thermal-cleanup"})
            return 0
        if action == "calibrate":
            json_print(calibrate())
            return 0
        raise ThermalPolicyError("usage: loadshed-thermal daemon|status|calibrate|cleanup")
    except (OSError, ThermalPolicyError) as exc:
        json_print({"ok": False, "action": action, "error": str(exc)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
