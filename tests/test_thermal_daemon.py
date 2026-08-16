import tempfile
from pathlib import Path
import sys
import unittest
from unittest import mock


TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
import thermal_daemon  # noqa: E402
import thermal_policy  # noqa: E402


def write_config(path, enabled=True, target=50.0):
    thermal_policy.save_config({
        "enabled": enabled,
        "target_c": target,
        "ad_hoc": [{
            "id": "batch",
            "process": "batch-job",
            "enabled": True,
            "throttle_percent": 25,
        }],
    }, str(path))


def process(cpu_percent=20.0):
    return {
        "pid": 123,
        "state": "R",
        "utime": 20,
        "stime": 2,
        "start_time": "77",
        "comm": "batch-job",
        "uid": 1000,
        "cgroup": "/user.slice/user-1000.slice",
        "cpu_percent": cpu_percent,
    }


class ThermalDaemonTests(unittest.TestCase):
    def controller(self, directory):
        config_path = Path(directory) / "thermal.json"
        state_path = Path(directory) / "state.json"
        cgroup_root = Path(directory) / "cgroup/loadshed-thermal"
        write_config(config_path)
        source = cgroup_root.parent / "source"
        source.mkdir(parents=True)
        (source / "cgroup.procs").touch()
        return thermal_daemon.ThermalController(
            config_path=str(config_path),
            state_path=str(state_path),
            cgroup_root=str(cgroup_root),
            require_root_owner=False,
        )

    def test_hot_process_is_throttled_before_it_is_paused(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = self.controller(directory)
            controller.discover = mock.Mock(return_value=(
                {"path": "/tmp/cpu", "label": "Package id 0"},
                None,
            ))
            controller.read_temperature = mock.Mock(return_value=52.0)
            with mock.patch.object(thermal_daemon, "list_processes", return_value=[process()]):
                controller.run_once()
                controller.pending_since -= controller.dwell_seconds
                controller.run_once()

            self.assertEqual(controller.stage, "throttled")
            quota = Path(directory) / "cgroup/loadshed-thermal/ad-hoc-batch/cpu.max"
            self.assertEqual(quota.read_text().strip(), "25000 100000")
            self.assertEqual(
                (Path(directory) / "cgroup/loadshed-thermal/ad-hoc-batch/cgroup.procs").read_text().strip(),
                "123",
            )

    def test_critical_temperature_freezes_only_ad_hoc_group(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = self.controller(directory)
            controller.discover = mock.Mock(return_value=(
                {"path": "/tmp/cpu", "label": "Package id 0"},
                None,
            ))
            controller.read_temperature = mock.Mock(return_value=91.0)
            with mock.patch.object(thermal_daemon, "list_processes", return_value=[process()]):
                controller.run_once()

            self.assertEqual(controller.stage, "critical")
            freeze = Path(directory) / "cgroup/loadshed-thermal/ad-hoc-batch/cgroup.freeze"
            self.assertEqual(freeze.read_text().strip(), "1")

    def test_throttle_transition_thaws_a_previously_paused_group(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = self.controller(directory)
            controller.stage = "paused"
            group = controller.cgroups.ensure("batch")
            (group / "cgroup.freeze").write_text("1\n")
            (group / "cpu.max").write_text("max 100000\n")
            (group / "cgroup.procs").touch()
            controller.discover = mock.Mock(return_value=(
                {"path": "/tmp/cpu", "label": "Package id 0"},
                None,
            ))
            controller.read_temperature = mock.Mock(return_value=51.0)
            with mock.patch.object(thermal_daemon, "list_processes", return_value=[process()]):
                controller.run_once()
                controller.pending_since -= controller.dwell_seconds
                controller.run_once()

            self.assertEqual(controller.stage, "throttled")
            self.assertEqual((group / "cgroup.freeze").read_text().strip(), "0")

    def test_disabled_policy_releases_thermal_state(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = self.controller(directory)
            controller.managed = {"batch": {"processes": {}}}
            config_path = Path(directory) / "thermal.json"
            write_config(config_path, enabled=False, target=None)
            controller.run_once()

            self.assertEqual(controller.stage, "normal")
            self.assertFalse(Path(directory, "state.json").exists())

    def test_pid_start_time_guard_rejects_reused_process(self):
        with tempfile.TemporaryDirectory() as directory:
            proc_root = Path(directory) / "proc"
            process_dir = proc_root / "123"
            process_dir.mkdir(parents=True)
            (process_dir / "comm").write_text("batch-job\n")
            (process_dir / "stat").write_text("123 (batch-job) R " + " ".join(["0"] * 19) + "\n")

            self.assertFalse(thermal_daemon.process_is_same(123, "batch-job", "77", str(proc_root)))


if __name__ == "__main__":
    unittest.main()
