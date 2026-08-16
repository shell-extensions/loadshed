import json
import tempfile
from pathlib import Path
import unittest

import sys


TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
import thermal_policy  # noqa: E402


class ThermalPolicyTests(unittest.TestCase):
    def test_default_config_is_disabled_and_valid(self):
        config = thermal_policy.default_config()

        self.assertFalse(config["enabled"])
        self.assertIsNone(config["target_c"])
        self.assertEqual(config["ad_hoc"], [])

    def test_essential_may_contain_protected_process(self):
        config = thermal_policy.validate_config({
            "version": 1,
            "essential": ["systemd", "dbus-daemon"],
            "important": [],
            "ad_hoc": [],
        })

        self.assertEqual(config["essential"], ["systemd", "dbus-daemon"])

    def test_ad_hoc_rejects_protected_process(self):
        with self.assertRaisesRegex(thermal_policy.ThermalPolicyError, "protected process"):
            thermal_policy.validate_config({
                "ad_hoc": [{"id": "shell", "process": "gnome-shell"}],
            })

    def test_lists_cannot_overlap(self):
        with self.assertRaisesRegex(thermal_policy.ThermalPolicyError, "multiple lists"):
            thermal_policy.validate_config({
                "essential": ["rsync"],
                "ad_hoc": [{"id": "rsync", "process": "rsync"}],
            })

    def test_target_must_remain_below_calibrated_fan_limits(self):
        with self.assertRaisesRegex(thermal_policy.ThermalPolicyError, "fan limits"):
            thermal_policy.validate_config({
                "target_c": 60,
                "fan_on_c": 60,
                "fan_off_c": 55,
                "ad_hoc": [],
            })

    def test_save_and_load_without_root_requirement_for_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "thermal.json"
            config = thermal_policy.save_config({
                "enabled": False,
                "target_c": 50,
                "ad_hoc": [{"id": "rsync", "process": "rsync"}],
            }, str(path))

            loaded = thermal_policy.load_config(str(path), require_root_owner=False)
            self.assertEqual(loaded, config)
            self.assertEqual(json.loads(path.read_text())["target_c"], 50.0)

    def test_sensor_discovery_prefers_coretemp_package_label(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            coretemp = root / "class/hwmon/hwmon0"
            coretemp.mkdir(parents=True)
            (coretemp / "name").write_text("coretemp\n")
            (coretemp / "temp1_label").write_text("Core 0\n")
            (coretemp / "temp1_input").write_text("51000\n")
            (coretemp / "temp2_label").write_text("Package id 0\n")
            (coretemp / "temp2_input").write_text("53000\n")
            zone = root / "class/thermal/thermal_zone0"
            zone.mkdir(parents=True)
            (zone / "type").write_text("x86_pkg_temp\n")
            (zone / "temp").write_text("52000\n")

            sensor = thermal_policy.discover_sensor(str(root))

            self.assertEqual(sensor["label"], "Package id 0")
            self.assertEqual(thermal_policy.read_temperature(sensor), 53.0)


if __name__ == "__main__":
    unittest.main()
