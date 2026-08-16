import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


GATE_PATH = Path(__file__).resolve().parents[1] / "tools" / "loadshed-gate"
LOADER = importlib.machinery.SourceFileLoader("loadshed_gate", str(GATE_PATH))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
gate_module = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(gate_module)


class FakeFanotify:
    def __init__(self):
        self.fd = -1
        self.marks = []

    def mark(self, path, add=True):
        self.marks.append((path, add))

    def close(self):
        pass


class FakeConnection:
    def __init__(self, payload):
        self._payload = payload
        self.responses = []

    def recv(self, _size):
        payload, self._payload = self._payload, b""
        return payload

    def sendall(self, payload):
        self.responses.append(json.loads(payload))


def protocol_request(socket_path, request):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(2)
        client.connect(socket_path)
        client.sendall((json.dumps(request) + "\n").encode())
        response = b""
        while not response.endswith(b"\n"):
            response += client.recv(65536)
    return json.loads(response)


class LoadshedGateUnitTests(unittest.TestCase):
    def make_gate(self, state_path):
        gate = gate_module.LoadshedGate.__new__(gate_module.LoadshedGate)
        gate.socket_path = "/tmp/unused-loadshed-gate.sock"
        gate.state_path = str(state_path)
        gate.fanotify = FakeFanotify()
        gate.listener = None
        gate.selector = None
        gate.active = False
        gate.generation = 0
        gate.targets = {}
        gate.queued = []
        gate.error = None
        gate._stop = False
        gate._last_identity_check = 0.0
        return gate

    def test_configure_and_release_persist_gate_intent(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "gate-state.json"
            gate = self.make_gate(state_path)
            target = {"id": "true", "executable": "/usr/bin/true"}

            with mock.patch.object(gate_module.os, "chown"):
                configured = gate.configure({"paused": True, "generation": 7, "targets": [target]})

            self.assertTrue(configured["active"])
            self.assertTrue(configured["healthy"])
            self.assertEqual(gate.generation, 7)
            self.assertEqual(json.loads(state_path.read_text())["paused"], True)
            self.assertEqual(gate.fanotify.marks, [("/usr/bin/true", True)])

            with mock.patch.object(gate_module.os, "chown"):
                released = gate.release({"generation": 7})

            self.assertFalse(released["active"])
            self.assertFalse(json.loads(state_path.read_text())["paused"])

    def test_replaced_executable_is_remarked_and_stays_active(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "target"
            executable.write_bytes(Path("/usr/bin/true").read_bytes())
            executable.chmod(0o755)
            gate = self.make_gate(Path(directory) / "gate-state.json")
            with mock.patch.object(gate_module.os, "chown"):
                gate.configure({
                    "paused": True,
                    "generation": 1,
                    "targets": [{"id": "target", "executable": str(executable)}],
                })

            original_inode = gate.targets["target"]["inode"]

            replacement = Path(directory) / "replacement"
            replacement.write_bytes(Path("/usr/bin/false").read_bytes())
            replacement.chmod(0o755)
            replacement.replace(executable)

            gate._check_target_identity()

            self.assertTrue(gate.active)
            self.assertTrue(gate.status()["healthy"])
            self.assertIsNone(gate.error)
            self.assertEqual(
                gate.fanotify.marks,
                [(str(executable), True), (str(executable), True)],
            )
            self.assertNotEqual(gate.targets["target"]["inode"], original_inode)
            self.assertEqual(gate.targets["target"]["inode"], os.stat(executable).st_ino)

    def test_remark_does_not_rewrite_state(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "target"
            executable.write_bytes(Path("/usr/bin/true").read_bytes())
            executable.chmod(0o755)
            gate = self.make_gate(Path(directory) / "gate-state.json")
            with mock.patch.object(gate_module.os, "chown"):
                gate.configure({
                    "paused": True,
                    "generation": 1,
                    "targets": [{"id": "target", "executable": str(executable)}],
                })

            replacement = Path(directory) / "replacement"
            replacement.write_bytes(Path("/usr/bin/false").read_bytes())
            replacement.chmod(0o755)
            replacement.replace(executable)

            with mock.patch.object(gate, "_write_state") as write_state:
                gate._check_target_identity()

            write_state.assert_not_called()

    def test_replaced_executable_keeps_queued_processes_blocked(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "target"
            executable.write_bytes(Path("/usr/bin/true").read_bytes())
            executable.chmod(0o755)
            gate = self.make_gate(Path(directory) / "gate-state.json")
            with mock.patch.object(gate_module.os, "chown"):
                gate.configure({
                    "paused": True,
                    "generation": 1,
                    "targets": [{"id": "target", "executable": str(executable)}],
                })

            gate.queued = [(123, str(executable))]

            replacement = Path(directory) / "replacement"
            replacement.write_bytes(Path("/usr/bin/false").read_bytes())
            replacement.chmod(0o755)
            replacement.replace(executable)

            with mock.patch.object(gate, "_respond") as respond:
                gate._check_target_identity()

            respond.assert_not_called()
            self.assertEqual(gate.queued, [(123, str(executable))])

    def test_remark_failure_deactivates_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "gate-state.json"
            executable = Path(directory) / "target"
            executable.write_bytes(Path("/usr/bin/true").read_bytes())
            executable.chmod(0o755)
            gate = self.make_gate(state_path)
            with mock.patch.object(gate_module.os, "chown"):
                gate.configure({
                    "paused": True,
                    "generation": 1,
                    "targets": [{"id": "target", "executable": str(executable)}],
                })

            replacement = Path(directory) / "replacement"
            replacement.write_bytes(Path("/usr/bin/false").read_bytes())
            replacement.chmod(0o755)
            replacement.replace(executable)

            gate.queued = [(123, str(executable))]

            with (
                mock.patch.object(gate.fanotify, "mark", side_effect=gate_module.GateError("boom")),
                mock.patch.object(gate_module.os, "chown"),
            ):
                gate._check_target_identity()

            self.assertFalse(gate.active)
            self.assertFalse(gate.status()["healthy"])
            self.assertIn("re-marked", gate.error)
            self.assertEqual(gate.queued, [])
            self.assertFalse(json.loads(state_path.read_text())["paused"])

    def test_replaced_executable_with_two_targets_remarks_both(self):
        with tempfile.TemporaryDirectory() as directory:
            executable_a = Path(directory) / "a_target"
            executable_b = Path(directory) / "b_target"
            for executable in (executable_a, executable_b):
                executable.write_bytes(Path("/usr/bin/true").read_bytes())
                executable.chmod(0o755)
            gate = self.make_gate(Path(directory) / "gate-state.json")
            with mock.patch.object(gate_module.os, "chown"):
                gate.configure({
                    "paused": True,
                    "generation": 1,
                    "targets": [
                        {"id": "a", "executable": str(executable_a)},
                        {"id": "b", "executable": str(executable_b)},
                    ],
                })

            for executable, replacement_name in (
                (executable_a, "a_replacement"),
                (executable_b, "b_replacement"),
            ):
                replacement = Path(directory) / replacement_name
                replacement.write_bytes(Path("/usr/bin/false").read_bytes())
                replacement.chmod(0o755)
                replacement.replace(executable)

            gate._check_target_identity()

            self.assertTrue(gate.active)
            self.assertIsNone(gate.error)
            self.assertEqual(gate.targets["a"]["inode"], os.stat(executable_a).st_ino)
            self.assertEqual(gate.targets["b"]["inode"], os.stat(executable_b).st_ino)

    def test_missing_executable_still_deactivates_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "target"
            executable.write_bytes(Path("/usr/bin/true").read_bytes())
            executable.chmod(0o755)
            gate = self.make_gate(Path(directory) / "gate-state.json")
            with mock.patch.object(gate_module.os, "chown"):
                gate.configure({
                    "paused": True,
                    "generation": 1,
                    "targets": [{"id": "target", "executable": str(executable)}],
                })

            executable.unlink()

            with mock.patch.object(gate_module.os, "chown"):
                gate._check_target_identity()

            self.assertFalse(gate.active)
            self.assertIn("disappeared", gate.error)

    def test_configure_failure_keeps_previous_targets_blocked(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "gate-state.json"
            executable = Path(directory) / "kept"
            executable.write_bytes(Path("/usr/bin/true").read_bytes())
            executable.chmod(0o755)
            gate = self.make_gate(state_path)
            with mock.patch.object(gate_module.os, "chown"):
                gate.configure({
                    "paused": True,
                    "generation": 1,
                    "targets": [{"id": "kept", "executable": str(executable)}],
                })

            gate.queued = [(123, str(executable))]

            with (
                mock.patch.object(gate, "_respond") as respond,
                mock.patch.object(gate_module.os, "chown"),
            ):
                with self.assertRaises(gate_module.GateError):
                    gate.configure({
                        "paused": True,
                        "generation": 2,
                        "targets": [{"id": "bad", "executable": "/nonexistent/binary"}],
                    })

            respond.assert_not_called()
            self.assertTrue(gate.active)
            self.assertEqual(set(gate.targets), {"kept"})
            self.assertEqual(gate.queued, [(123, str(executable))])
            self.assertTrue(json.loads(state_path.read_text())["paused"])

    def test_configure_failure_adopts_requested_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "kept"
            executable.write_bytes(Path("/usr/bin/true").read_bytes())
            executable.chmod(0o755)
            gate = self.make_gate(Path(directory) / "gate-state.json")
            with mock.patch.object(gate_module.os, "chown"):
                gate.configure({
                    "paused": True,
                    "generation": 1,
                    "targets": [{"id": "kept", "executable": str(executable)}],
                })

            with mock.patch.object(gate_module.os, "chown"):
                with self.assertRaises(gate_module.GateError):
                    gate.configure({
                        "paused": True,
                        "generation": 8,
                        "targets": [{"id": "bad", "executable": "/nonexistent/binary"}],
                    })

            self.assertEqual(gate.generation, 8)

            with mock.patch.object(gate_module.os, "chown"):
                released = gate.release({"generation": 8})

            self.assertFalse(released["active"])

    def test_release_recovers_from_unconfigured_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            gate = self.make_gate(Path(directory) / "gate-state.json")

            with mock.patch.object(gate_module.os, "chown"):
                released = gate.release({"generation": 9})

            self.assertFalse(released["active"])
            self.assertEqual(gate.generation, 9)

    def test_release_rejects_generation_mismatch_while_active(self):
        gate = self.make_gate(Path(tempfile.gettempdir()) / "unused-loadshed-gate-state.json")
        gate.active = True
        gate.generation = 3

        with self.assertRaisesRegex(gate_module.GateError, "generation mismatch"):
            gate.release({"generation": 4})

    def test_non_object_socket_request_is_rejected_without_crashing(self):
        gate = self.make_gate(Path(tempfile.gettempdir()) / "unused-loadshed-gate-state.json")
        connection = FakeConnection(b"[]\n")

        gate._handle_connection(connection)

        self.assertEqual(len(connection.responses), 1)
        self.assertFalse(connection.responses[0]["ok"])
        self.assertIn("JSON object", connection.responses[0]["error"])

    def test_configure_failure_rolls_back_newly_added_marks(self):
        with tempfile.TemporaryDirectory() as directory:
            existing = Path(directory) / "a_existing"
            c_target = Path(directory) / "c_target"
            d_target = Path(directory) / "d_target"
            for executable in (existing, c_target, d_target):
                executable.write_bytes(Path("/usr/bin/true").read_bytes())
                executable.chmod(0o755)

            gate = self.make_gate(Path(directory) / "gate-state.json")
            with mock.patch.object(gate_module.os, "chown"):
                gate.configure({
                    "paused": True,
                    "generation": 1,
                    "targets": [{"id": "existing", "executable": str(existing)}],
                })

            real_mark = gate.fanotify.mark

            def flaky_mark(path, add=True):
                if path == str(d_target) and add:
                    raise gate_module.GateError("boom")
                real_mark(path, add=add)

            with (
                mock.patch.object(gate.fanotify, "mark", side_effect=flaky_mark),
                mock.patch.object(gate_module.os, "chown"),
            ):
                with self.assertRaises(gate_module.GateError):
                    gate.configure({
                        "paused": True,
                        "generation": 2,
                        "targets": [
                            {"id": "existing", "executable": str(existing)},
                            {"id": "c", "executable": str(c_target)},
                            {"id": "d", "executable": str(d_target)},
                        ],
                    })

            self.assertIn((str(c_target), False), gate.fanotify.marks)
            self.assertNotIn((str(existing), False), gate.fanotify.marks)
            self.assertEqual(set(gate.targets), {"existing"})

    def test_reconfigure_with_replaced_inode_remarks_without_reopen(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "target"
            executable.write_bytes(Path("/usr/bin/true").read_bytes())
            executable.chmod(0o755)
            gate = self.make_gate(Path(directory) / "gate-state.json")
            with mock.patch.object(gate_module.os, "chown"):
                gate.configure({
                    "paused": True,
                    "generation": 1,
                    "targets": [{"id": "target", "executable": str(executable)}],
                })

            gate.queued = [(123, str(executable))]
            fanotify_before = gate.fanotify

            replacement = Path(directory) / "replacement"
            replacement.write_bytes(Path("/usr/bin/false").read_bytes())
            replacement.chmod(0o755)
            replacement.replace(executable)

            with mock.patch.object(gate_module.os, "chown"):
                gate.configure({
                    "paused": True,
                    "generation": 2,
                    "targets": [{"id": "target", "executable": str(executable)}],
                })

            self.assertIs(gate.fanotify, fanotify_before)
            self.assertEqual(
                gate.fanotify.marks,
                [(str(executable), True), (str(executable), True)],
            )
            self.assertEqual(gate.queued, [(123, str(executable))])

    def test_removed_target_releases_only_its_queued_processes(self):
        with tempfile.TemporaryDirectory() as directory:
            kept = Path(directory) / "kept"
            removed = Path(directory) / "removed"
            for executable in (kept, removed):
                executable.write_bytes(Path("/usr/bin/true").read_bytes())
                executable.chmod(0o755)
            gate = self.make_gate(Path(directory) / "gate-state.json")
            with mock.patch.object(gate_module.os, "chown"):
                gate.configure({
                    "paused": True,
                    "generation": 1,
                    "targets": [
                        {"id": "kept", "executable": str(kept)},
                        {"id": "removed", "executable": str(removed)},
                    ],
                })

            gate.queued = [(111, str(kept)), (222, str(removed))]

            with (
                mock.patch.object(gate, "_respond") as respond,
                mock.patch.object(gate_module.os, "chown"),
            ):
                gate.configure({
                    "paused": True,
                    "generation": 2,
                    "targets": [{"id": "kept", "executable": str(kept)}],
                })

            respond.assert_called_once_with(222)
            self.assertEqual(gate.queued, [(111, str(kept))])

    def test_remove_mark_failure_is_tolerated(self):
        with tempfile.TemporaryDirectory() as directory:
            kept = Path(directory) / "kept"
            removed = Path(directory) / "removed"
            for executable in (kept, removed):
                executable.write_bytes(Path("/usr/bin/true").read_bytes())
                executable.chmod(0o755)
            gate = self.make_gate(Path(directory) / "gate-state.json")
            with mock.patch.object(gate_module.os, "chown"):
                gate.configure({
                    "paused": True,
                    "generation": 1,
                    "targets": [
                        {"id": "kept", "executable": str(kept)},
                        {"id": "removed", "executable": str(removed)},
                    ],
                })

            fanotify_before = gate.fanotify
            real_mark = gate.fanotify.mark

            def flaky_mark(path, add=True):
                if path == str(removed) and not add:
                    raise gate_module.GateError("boom")
                real_mark(path, add=add)

            with (
                mock.patch.object(gate.fanotify, "mark", side_effect=flaky_mark),
                mock.patch.object(gate_module.os, "chown"),
            ):
                gate.configure({
                    "paused": True,
                    "generation": 2,
                    "targets": [{"id": "kept", "executable": str(kept)}],
                })

            self.assertIs(gate.fanotify, fanotify_before)
            self.assertEqual(set(gate.targets), {"kept"})

    def test_read_events_queues_open_exec_event(self):
        # Regression test for the metadata struct itself: the kernel's
        # fanotify_event_metadata has 7 fields (event_len, vers, reserved,
        # metadata_len, mask, fd, pid).  Packing exactly that layout and
        # feeding it through _read_events would raise ValueError if the
        # unpack ever drops a field again.
        with tempfile.TemporaryDirectory() as directory:
            gate = self.make_gate(Path(directory) / "gate-state.json")
            gate.active = True
            test_file = os.path.abspath(__file__)
            fd = os.open(test_file, os.O_RDONLY)
            try:
                event = struct.pack(
                    "I B B H Q i i",
                    gate_module.FAN_EVENT_METADATA_LEN,
                    gate_module.FANOTIFY_METADATA_VERSION,
                    0,
                    gate_module.FAN_EVENT_METADATA_LEN,
                    gate_module.FAN_OPEN_EXEC_PERM,
                    fd,
                    os.getpid(),
                )
                with mock.patch.object(gate_module.os, "read", return_value=event):
                    gate._read_events()

                self.assertIsNone(gate.error)
                self.assertEqual(gate.queued, [(fd, test_file)])
            finally:
                os.close(fd)

    def test_read_events_responds_to_invalid_length_event(self):
        with tempfile.TemporaryDirectory() as directory:
            gate = self.make_gate(Path(directory) / "gate-state.json")
            gate.active = True
            fd = os.open(__file__, os.O_RDONLY)
            try:
                bogus_event = struct.pack(
                    "I B B H Q i i",
                    10,  # shorter than FAN_EVENT_METADATA_LEN -> invalid
                    gate_module.FANOTIFY_METADATA_VERSION,
                    0,
                    gate_module.FAN_EVENT_METADATA_LEN,
                    gate_module.FAN_OPEN_EXEC_PERM,
                    fd,
                    os.getpid(),
                )
                with (
                    mock.patch.object(gate_module.os, "read", return_value=bogus_event),
                    mock.patch.object(gate, "_respond") as respond,
                ):
                    gate._read_events()

                respond.assert_called_once_with(fd)
                self.assertEqual(gate.error, "invalid fanotify event metadata")
            finally:
                os.close(fd)

    def test_read_events_responds_to_unsupported_version_event(self):
        with tempfile.TemporaryDirectory() as directory:
            gate = self.make_gate(Path(directory) / "gate-state.json")
            gate.active = True
            fd = os.open(__file__, os.O_RDONLY)
            try:
                bogus_event = struct.pack(
                    "I B B H Q i i",
                    gate_module.FAN_EVENT_METADATA_LEN,
                    gate_module.FANOTIFY_METADATA_VERSION + 1,  # unsupported
                    0,
                    gate_module.FAN_EVENT_METADATA_LEN,
                    gate_module.FAN_OPEN_EXEC_PERM,
                    fd,
                    os.getpid(),
                )
                with (
                    mock.patch.object(gate_module.os, "read", return_value=bogus_event),
                    mock.patch.object(gate, "_respond") as respond,
                ):
                    gate._read_events()

                respond.assert_called_once_with(fd)
                self.assertEqual(gate.error, "unsupported fanotify event metadata")
            finally:
                os.close(fd)


@unittest.skipUnless(os.environ.get("LOADSHED_GATE_INTEGRATION") == "1", "set LOADSHED_GATE_INTEGRATION=1")
class LoadshedGateIntegrationTests(unittest.TestCase):
    def test_direct_exec_waits_until_release(self):
        if os.geteuid() != 0:
            self.skipTest("fanotify permission tests require root")

        with tempfile.TemporaryDirectory() as directory:
            directory_path = Path(directory)
            socket_path = directory_path / "gate.sock"
            state_path = directory_path / "gate-state.json"
            markers = [directory_path / "started-1", directory_path / "started-2"]
            process = subprocess.Popen([
                str(GATE_PATH),
                "--socket", str(socket_path),
                "--state", str(state_path),
            ])
            children = []
            try:
                deadline = time.monotonic() + 3
                while not socket_path.exists() and time.monotonic() < deadline:
                    if process.poll() is not None:
                        self.skipTest("fanotify is unavailable in this environment")
                    time.sleep(0.05)
                if not socket_path.exists():
                    self.fail("gate socket did not appear")

                response = protocol_request(socket_path, {
                    "command": "configure",
                    "paused": True,
                    "generation": 1,
                    "targets": [{"id": "python", "executable": sys.executable}],
                })
                self.assertTrue(response["active"])

                children = [subprocess.Popen([
                    sys.executable,
                    "-c",
                    f"from pathlib import Path; Path({str(marker)!r}).write_text('ok')",
                ]) for marker in markers]
                time.sleep(0.3)
                self.assertTrue(all(not marker.exists() for marker in markers))
                self.assertTrue(all(child.poll() is None for child in children))
                queued = protocol_request(socket_path, {"command": "status"})
                self.assertGreaterEqual(queued["queued_exec_count"], 2)

                response = protocol_request(socket_path, {"command": "release", "generation": 1})
                self.assertFalse(response["active"])
                self.assertTrue(all(child.wait(timeout=3) == 0 for child in children))
                self.assertTrue(all(marker.exists() for marker in markers))
            finally:
                process.send_signal(signal.SIGTERM)
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                for child in children:
                    if child.poll() is None:
                        child.terminate()
                    child.wait(timeout=2)


if __name__ == "__main__":
    unittest.main()
