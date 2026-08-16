import contextlib
import importlib.machinery
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
from unittest import mock


HELPER_PATH = Path(__file__).resolve().parents[1] / "tools" / "loadshed-helper"
LOADER = importlib.machinery.SourceFileLoader("loadshed_helper", str(HELPER_PATH))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
helper = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(helper)


def unit(entry_id, service=None, timer=None, enabled=True):
    return {
        "id": entry_id,
        "label": entry_id.upper(),
        "service": service or f"{entry_id}.service",
        "timer": timer,
        "optional": False,
        "enabled": enabled,
    }


def process(entry_id, name=None, enabled=True):
    return {
        "id": entry_id,
        "label": entry_id.upper(),
        "process": name or entry_id,
        "optional": False,
        "enabled": enabled,
    }


def state_entry(entry_id, service=None, timer=None):
    return {
        "service": service or f"{entry_id}.service",
        "timer": timer,
        "service_frozen": True,
        "timer_stopped": False,
        "freeze_method": "systemctl",
    }


class LoadshedHelperTests(unittest.TestCase):
    def test_serialize_units_preserves_disabled_flag_only_when_false(self):
        serialized = helper.serialize_units([unit("active"), unit("disabled", enabled=False)])

        self.assertNotIn("enabled", serialized[0])
        self.assertIs(serialized[1]["enabled"], False)

    def test_resume_units_releases_only_selected_entries(self):
        current_state = {
            "entries": {
                "alpha": state_entry("alpha"),
                "beta": state_entry("beta"),
            }
        }
        saved = []
        thawed = []

        with (
            mock.patch.object(helper, "load_state", return_value=current_state),
            mock.patch.object(helper, "save_state", side_effect=saved.append),
            mock.patch.object(helper, "show_unit", return_value={"FreezerState": "frozen"}),
            mock.patch.object(helper, "cgroup_frozen_from_status", return_value=False),
            mock.patch.object(helper, "thaw_service", side_effect=lambda name, method: thawed.append(name)),
        ):
            errors = helper.resume_units([unit("alpha"), unit("beta")], {"alpha"})

        self.assertEqual(errors, [])
        self.assertEqual(thawed, ["alpha.service"])
        self.assertEqual(saved, [{"entries": {"beta": current_state["entries"]["beta"]}}])

    def test_reconcile_releases_disabled_and_replaced_entries(self):
        old_units = [unit("alpha"), unit("beta", service="beta-old.service"), unit("gamma")]
        new_units = [
            unit("alpha", enabled=False),
            unit("beta", service="beta-new.service"),
            unit("gamma"),
        ]
        current_state = {
            "entries": {
                "alpha": state_entry("alpha"),
                "beta": state_entry("beta", service="beta-old.service"),
                "gamma": state_entry("gamma"),
            }
        }

        with (
            mock.patch.object(helper, "load_state", return_value=current_state),
            mock.patch.object(helper, "resume_units", return_value=[]) as resume,
        ):
            errors = helper.reconcile_config_state(old_units, new_units)

        self.assertEqual(errors, [])
        resume.assert_called_once_with(old_units, ["alpha", "beta"])

    def test_status_keeps_managed_disabled_entry_visible(self):
        disabled = unit("alpha", enabled=False)
        current_state = {"entries": {"alpha": state_entry("alpha")}}

        with (
            mock.patch.object(helper, "load_state", return_value=current_state),
            mock.patch.object(helper, "status_entry", return_value={"id": "alpha", "paused": True}),
        ):
            payload = helper.status_payload([disabled], "status")

        self.assertEqual(payload["entries"], [{"id": "alpha", "paused": True}])
        self.assertTrue(payload["paused"])

    def test_config_set_does_not_save_when_release_fails(self):
        old_units = [unit("alpha")]
        requested = helper.serialize_units([unit("alpha", enabled=False)])
        output = io.StringIO()

        with (
            mock.patch.object(sys, "argv", [str(HELPER_PATH), "config-set"]),
            mock.patch.object(sys, "stdin", io.StringIO(json.dumps(requested))),
            mock.patch.object(helper, "require_root"),
            mock.patch.object(helper, "require_systemctl"),
            mock.patch.object(helper, "load_units", return_value=old_units),
            mock.patch.object(helper, "load_state", return_value={"entries": {"alpha": state_entry("alpha")}}),
            mock.patch.object(helper, "reconcile_config_state", return_value=["release failed"]),
            mock.patch.object(helper, "pause_units", return_value=[]) as pause_units,
            mock.patch.object(helper, "save_units_config") as save_config,
            contextlib.redirect_stdout(output),
        ):
            result = helper.main()

        payload = json.loads(output.getvalue())
        self.assertEqual(result, 1)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["entries"], helper.serialize_units(old_units))
        pause_units.assert_called_once_with(old_units)
        save_config.assert_not_called()

    def test_pause_units_stops_timer_restarted_after_saved_pause(self):
        current_state = {
            "entries": {
                "alpha": {
                    "service": "alpha.service",
                    "timer": "alpha.timer",
                    "service_frozen": False,
                    "timer_stopped": True,
                }
            }
        }
        saved = []
        systemctl_calls = []

        def show_unit(name, include_freezer=False, extra_properties=None):
            if name == "alpha.timer":
                return {"LoadState": "loaded", "ActiveState": "active", "SubState": "waiting"}
            return {"LoadState": "loaded", "ActiveState": "inactive", "SubState": "dead", "FreezerState": "running"}

        with (
            mock.patch.object(helper, "load_state", return_value=current_state),
            mock.patch.object(helper, "save_state", side_effect=saved.append),
            mock.patch.object(helper, "show_unit", side_effect=show_unit),
            mock.patch.object(helper, "cgroup_frozen_from_status", return_value=False),
            mock.patch.object(helper, "systemctl", side_effect=lambda args, check=False: systemctl_calls.append(args)),
        ):
            errors = helper.pause_units([unit("alpha", timer="alpha.timer")])

        self.assertEqual(errors, [])
        self.assertEqual(systemctl_calls, [["stop", "alpha.timer"]])
        self.assertTrue(saved[0]["entries"]["alpha"]["timer_stopped"])

    def test_config_set_reapplies_pause_after_successful_save(self):
        old_units = [unit("alpha")]
        new_units = [unit("alpha"), unit("beta")]
        output = io.StringIO()

        with (
            mock.patch.object(sys, "argv", [str(HELPER_PATH), "config-set"]),
            mock.patch.object(sys, "stdin", io.StringIO(json.dumps(helper.serialize_units(new_units)))),
            mock.patch.object(helper, "require_root"),
            mock.patch.object(helper, "require_systemctl"),
            mock.patch.object(helper, "load_units", return_value=old_units),
            mock.patch.object(helper, "load_state", return_value={"entries": {"alpha": state_entry("alpha")}}),
            mock.patch.object(helper, "reconcile_config_state", return_value=[]),
            mock.patch.object(helper, "save_units_config") as save_config,
            mock.patch.object(helper, "pause_units", return_value=[]) as pause_units,
            contextlib.redirect_stdout(output),
        ):
            result = helper.main()

        self.assertEqual(result, 0)
        save_config.assert_called_once_with(new_units)
        pause_units.assert_called_once_with(new_units)

    def test_process_entry_validates_and_serializes(self):
        entries = helper.validate_units([{
            "id": "rsync",
            "label": "rsync file sync",
            "process": "rsync",
            "optional": True,
        }])

        self.assertEqual(entries, [process("rsync", name="rsync") | {"label": "rsync file sync", "optional": True}])
        self.assertEqual(helper.serialize_units(entries), [{
            "id": "rsync",
            "label": "rsync file sync",
            "process": "rsync",
            "optional": True,
        }])

    def test_pause_units_stops_matching_process(self):
        current_state = {"entries": {}}
        saved = []
        stopped = []

        with (
            mock.patch.object(helper, "load_state", return_value=current_state),
            mock.patch.object(helper, "save_state", side_effect=saved.append),
            mock.patch.object(helper, "find_processes", return_value=[{"pid": 123, "start_time": "42", "state": "S"}]),
            mock.patch.object(helper, "stop_process", side_effect=lambda pid, name, start: stopped.append((pid, name, start))),
        ):
            errors = helper.pause_units([process("rsync")])

        self.assertEqual(errors, [])
        self.assertEqual(stopped, [(123, "rsync", "42")])
        self.assertTrue(saved[0]["entries"]["rsync"]["process_stopped"])
        self.assertEqual(saved[0]["entries"]["rsync"]["processes"]["123"]["start_time"], "42")

    def test_pause_units_keeps_progress_when_one_process_stop_fails(self):
        current_state = {"entries": {}}
        saved = []

        def failing_stop(pid, name, start):
            if pid == 222:
                raise OSError("permission denied")

        with (
            mock.patch.object(helper, "load_state", return_value=current_state),
            mock.patch.object(helper, "save_state", side_effect=saved.append),
            mock.patch.object(helper, "find_processes", return_value=[
                {"pid": 111, "start_time": "10", "state": "S"},
                {"pid": 222, "start_time": "20", "state": "S"},
            ]),
            mock.patch.object(helper, "stop_process", side_effect=failing_stop),
        ):
            errors = helper.pause_units([process("rsync")])

        self.assertEqual(len(errors), 1)
        self.assertIn("222", errors[0])
        entry_state = saved[0]["entries"]["rsync"]
        self.assertTrue(entry_state["process_stopped"])
        self.assertEqual(list(entry_state["processes"]), ["111"])

    def test_resume_units_continues_tracked_process(self):
        current_state = {
            "entries": {
                "rsync": {
                    "process": "rsync",
                    "process_stopped": True,
                    "processes": {"123": {"start_time": "42", "process": "rsync"}},
                }
            }
        }
        saved = []
        continued = []

        with (
            mock.patch.object(helper, "load_state", return_value=current_state),
            mock.patch.object(helper, "save_state", side_effect=saved.append),
            mock.patch.object(helper, "continue_process", side_effect=lambda pid, name, start: continued.append((pid, name, start))),
        ):
            errors = helper.resume_units([process("rsync")])

        self.assertEqual(errors, [])
        self.assertEqual(continued, [(123, "rsync", "42")])
        self.assertEqual(saved, [{"entries": {}}])


if __name__ == "__main__":
    unittest.main()
