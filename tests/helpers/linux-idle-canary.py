import argparse
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import socket
import unittest
from types import SimpleNamespace
from unittest.mock import patch

# The mandatory Node bridge supplies print-only output from the current tracked generator.
# Disable import bytecode even when the portable suite is invoked directly rather than through -B.
sys.dont_write_bytecode = True
parser = argparse.ArgumentParser()
parser.add_argument("--helper", required=True)
options, unittest_args = parser.parse_known_args()
ROOT = Path(__file__).resolve().parents[2]
HELPER = Path(options.helper).resolve(strict=True)
spec = importlib.util.spec_from_file_location("canary", ROOT / "scripts/linux-idle-canary.py")
C = importlib.util.module_from_spec(spec)
spec.loader.exec_module(C)
SOURCE = HELPER.read_text()
CFG = C.identities("1234abcd", 61234)


def trace(kind, stamp):
    group = CFG["cgroup"]
    stamp = f"{float(stamp):.6f}"
    return {
        "freeze1": f'{stamp} write(3<{group}/cgroup.freeze>, "1\\n", 2) = 2',
        "freeze0": f'{stamp} write(3<{group}/cgroup.freeze>, "0\\n", 2) = 2',
        "kill": f'{stamp} write(4<{group}/cgroup.kill>, "1\\n", 2) = 2',
        "empty": f'{stamp} read(3<{group}/cgroup.events>, "populated 0\\nfrozen 1\\n", 131072) = 21',
        "removed": f'{stamp} newfstatat(AT_FDCWD, "{group}", 0x123, 0) = -1 ENOENT (No such file or directory)',
        "stop": f'{stamp} execve("/usr/bin/systemctl", ["systemctl", "stop", "{CFG["unit"]}"], 0x123 /* 5 vars */) = 0',
    }[kind]


class CanaryOfflineTests(unittest.TestCase):
    def test_identity_adapter_reverses_to_exact_original_algorithm(self):
        result = C.adapt(SOURCE, CFG)
        for a, b in ((CFG["unit"], "case-runner.service"),
                     ("OWNED=" + CFG["runtime"] + "/freeze-owned", "OWNED=/run/case-ci/idle-reset-freeze-owned"),
                     ("runner_uid=$(id -u " + CFG["name"] + ")", "runner_uid=$(id -u runner)"),
                     ('[ "$(property User)" = ' + CFG["name"] + ' ]', '[ "$(property User)" = runner ]'),
                     (CFG["program"] + "/Runner.Listener)", "/opt/actions-runner/bin/Runner.Listener)"),
                     ("DIAG=" + CFG["program"] + "/_diag", "DIAG=/opt/actions-runner/_diag")):
            result = result.replace(a, b)
        self.assertEqual(result, SOURCE)

    def test_production_and_unbounded_identity_inputs_refused(self):
        for name, uid in (("case-runner", 61234), ("../evil", 61234), ("1234abcd", 0), ("1234abcd", 1001), ("1234abcd", 65534)):
            with self.assertRaises(RuntimeError): C.identities(name, uid)

    def test_unrecognized_source_is_not_silently_adapted(self):
        with self.assertRaises(RuntimeError): C.adapt(SOURCE.replace("runner_uid=$(id -u runner)", "runner_uid=0"), CFG)

    def test_generated_scripts_parse_without_execution(self):
        files = C.bundle(SOURCE, CFG)
        for name in ("idle-reset.sh", "pgrep-wrapper.sh", "listener.sh"):
            result = subprocess.run(["/bin/bash", "-n"], input=files[name], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_private_namespace_and_cleanup_unit_are_concrete(self):
        files = C.bundle(SOURCE, CFG)
        self.assertNotIn("case-runner.service", files["idle-reset.sh"])
        self.assertIn("PrivateMounts=yes", files[CFG["admit"]])
        self.assertIn("ExecStart=/bin/bash " + CFG["program"] + "/idle-reset.sh", files[CFG["admit"]])
        self.assertIn("BindReadOnlyPaths=" + CFG["program"] + "/pgrep-wrapper.sh:/usr/bin/pgrep", files[CFG["admit"]])
        self.assertIn("ExecStopPost=/bin/bash " + CFG["program"] + "/idle-reset.sh thaw", files[CFG["admit"]])
        self.assertIn('pids=$(' + CFG["program"] + '/pgrep.real "$@")', files["pgrep-wrapper.sh"])
        self.assertIn('first-snapshot', files["pgrep-wrapper.sh"])
        self.assertIn('second-snapshot', files["pgrep-wrapper.sh"])

    def test_default_plan_never_executes_a_system_command(self):
        with patch.object(C.subprocess, "run", side_effect=AssertionError("executed")), patch.object(C.subprocess, "Popen", side_effect=AssertionError("executed")):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(C.main(["--helper", str(HELPER), "--id", "1234abcd"]), 0)
            self.assertEqual(json.loads(output.getvalue())["mode"], "OFFLINE PLAN")

    def test_emit_only_writes_the_requested_offline_bundle(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(C.subprocess, "run", side_effect=AssertionError("executed")):
            target = Path(directory) / "bundle"
            with contextlib.redirect_stdout(io.StringIO()):
                C.main(["--helper", str(HELPER), "--id", "1234abcd", "--emit-dir", str(target)])
            self.assertEqual((target / "idle-reset.sh").read_text(), C.adapt(SOURCE, CFG))
            self.assertEqual(len(list(target.iterdir())), 6)

    def test_helper_input_is_required_instead_of_a_stale_sibling_copy(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as error:
                C.main(["--id", "1234abcd"])
        self.assertEqual(error.exception.code, 2)

    def test_offline_plan_and_emit_cannot_enter_live_privileged_or_network_paths(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.ExitStack() as stack:
            for target, name in ((C, "preflight"), (C, "cmd"), (C.Harness, "setup"),
                                 (C.subprocess, "run"), (C.subprocess, "Popen"),
                                 (C.os, "system"), (C.os, "chown"), (C.os, "kill"),
                                 (socket, "socket"), (socket, "create_connection"), (socket, "getaddrinfo")):
                stack.enter_context(patch.object(target, name, side_effect=AssertionError("offline reached " + name)))
            for extra in ([], ["--emit-dir", str(Path(directory) / "bundle")]):
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    self.assertEqual(C.main(["--helper", str(HELPER), "--id", "1234abcd", *extra]), 0)
                manifest = json.loads(output.getvalue())
                self.assertEqual(manifest["mode"], "OFFLINE PLAN")
                self.assertEqual(manifest["helper_sha256"], C.digest(SOURCE))
                self.assertEqual(len(manifest["coverage"]["pending_live"]), 2)
                self.assertFalse(manifest["coverage"]["factory_reset_exercised"])

    def test_import_bytecode_is_disabled(self):
        self.assertTrue(sys.dont_write_bytecode)

    def test_run_refuses_non_linux_or_non_root_before_any_system_command(self):
        with patch.object(C.platform, "system", return_value="Darwin"), patch.object(C.subprocess, "run", side_effect=AssertionError("executed")):
            with self.assertRaisesRegex(RuntimeError, "root in a disposable Linux VM"):
                C.main(["--helper", str(HELPER), "--id", "1234abcd", "--run"])

    def test_missing_owner_ack_refuses_before_machine_or_system_access(self):
        with patch.object(C.platform, "system", return_value="Linux"), patch.object(C.os, "geteuid", return_value=0), patch.object(C.subprocess, "run", side_effect=AssertionError("executed")):
            with self.assertRaisesRegex(RuntimeError, "acknowledgement"):
                C.main(["--helper", str(HELPER), "--id", "1234abcd", "--run"])

    def test_preexisting_evidence_never_grants_root_capture_ownership(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg = dict(CFG, evidence=directory)
            harness = C.Harness(cfg, C.bundle(SOURCE, cfg))
            with patch.object(C, "cmd", side_effect=AssertionError("executed")):
                with self.assertRaises(FileExistsError): harness.setup()
                self.assertFalse(harness.owns_evidence())
                with self.assertRaisesRegex(RuntimeError, "unowned/replaced"):
                    harness.capture_failure("setup-failure", "failed")
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_evidence_identity_requires_original_root_private_directory(self):
        harness = C.Harness(CFG, C.bundle(SOURCE, CFG))
        harness.evidence_identity = (7, 42)
        good = dict(st_mode=0o40700, st_uid=0, st_dev=7, st_ino=42)
        for change in ({"st_mode": 0o120777}, {"st_uid": 1001}, {"st_mode": 0o40777}, {"st_ino": 43}, {"st_dev": 8}):
            with patch.object(C.Path, "lstat", return_value=SimpleNamespace(**dict(good, **change))):
                self.assertFalse(harness.owns_evidence())
                with self.assertRaisesRegex(RuntimeError, "unowned/replaced"):
                    harness.receipt()
        with patch.object(C.Path, "lstat", return_value=SimpleNamespace(**good)):
            self.assertTrue(harness.owns_evidence())

    def recovery_fixture(self, directory):
        cfg = dict(CFG, evidence=directory)
        files = C.bundle(SOURCE, cfg)
        record = {"identity": cfg, "machine_id": "a" * 32,
                  "file_sha256": {name: C.digest(text) for name, text in files.items()},
                  "created": {"program": True, "runtime": True, "group": True, "user": True, "units": [cfg["unit"]]}}
        (Path(directory) / "receipt.json").write_text(json.dumps(record))
        return cfg, files, record

    def recovery_metadata(self, path):
        return SimpleNamespace(st_mode=0o100600 if path.name == "receipt.json" else 0o40700, st_uid=0)

    def test_recovery_accepts_only_validated_private_root_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg, files, record = self.recovery_fixture(directory)
            with patch.object(C.Path, "lstat", lambda path: self.recovery_metadata(path)):
                self.assertEqual(C.load_recovery_receipt(cfg, files, "a" * 32), record["created"])
                with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
                    C.load_recovery_receipt(cfg, files, "b" * 32)

    def test_recovery_refuses_foreign_symlink_or_writable_evidence_and_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg, files, record = self.recovery_fixture(directory)
            for target, mode, uid in (("evidence", 0o40700, 1001), ("evidence", 0o120777, 0), ("evidence", 0o40755, 0),
                                      ("receipt", 0o100600, 1001), ("receipt", 0o120777, 0), ("receipt", 0o100666, 0)):
                def metadata(path):
                    if (path.name == "receipt.json") == (target == "receipt"):
                        return SimpleNamespace(st_mode=mode, st_uid=uid)
                    return self.recovery_metadata(path)
                with patch.object(C.Path, "lstat", metadata), patch.object(C.Path, "read_text", side_effect=AssertionError("untrusted read")):
                    with self.assertRaisesRegex(RuntimeError, "untrusted"):
                        C.load_recovery_receipt(cfg, files, "a" * 32)

    def test_recovery_refuses_forged_ownership_schema_or_foreign_unit(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg, files, record = self.recovery_fixture(directory)
            for created in ({}, dict(record["created"], program="yes"), dict(record["created"], units=["case-runner.service"]),
                            dict(record["created"], units=[cfg["unit"], cfg["unit"]]), dict(record["created"], units=[{}])):
                bad = dict(record, created=created)
                (Path(directory) / "receipt.json").write_text(json.dumps(bad))
                with patch.object(C.Path, "lstat", lambda path: self.recovery_metadata(path)):
                    with self.assertRaises(RuntimeError): C.load_recovery_receipt(cfg, files, "a" * 32)

    def test_cleanup_refuses_changed_unit_before_any_stop_or_signal(self):
        files = C.bundle(SOURCE, CFG)
        harness = C.Harness(CFG, files)
        harness.created["units"] = [CFG["unit"]]
        with patch.object(C.Path, "read_text", return_value="changed unit"), patch.object(C, "cmd", side_effect=AssertionError("executed")):
            with self.assertRaisesRegex(RuntimeError, "changed unit file"):
                harness.clean_case()

    def test_cleanup_refuses_foreign_cgroup_before_writing_or_stopping(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg = dict(CFG, cgroup=directory)
            files = C.bundle(SOURCE, cfg)
            harness = C.Harness(cfg, files)
            harness.created["units"] = [cfg["unit"]]
            freeze = Path(directory) / "cgroup.freeze"
            freeze.write_text("1\n")
            with patch.object(C.Path, "read_text", return_value=files[cfg["unit"]]), patch.object(C, "properties", return_value={"User": cfg["name"], "ControlGroup": "/foreign", "FragmentPath": "/etc/systemd/system/" + cfg["unit"], "DropInPaths": ""}), patch.object(C, "cmd", side_effect=AssertionError("executed")):
                with self.assertRaisesRegex(RuntimeError, "foreign cgroup identity"):
                    harness.clean_case()
            self.assertEqual(freeze.read_text(), "1\n")

    def test_cleanup_allows_private_group_already_removed_by_userdel(self):
        harness = C.Harness(CFG, C.bundle(SOURCE, CFG))
        harness.created.update(user=True, group=True)
        with patch.object(harness, "clean_case"), patch.object(C.pwd, "getpwnam", return_value=SimpleNamespace(pw_uid=CFG["uid"])), patch.object(C, "pids", return_value=[]), patch.object(C.grp, "getgrnam", side_effect=KeyError), patch.object(C, "cmd") as commands:
            harness.cleanup()
        commands.assert_called_once_with(["/usr/sbin/userdel", CFG["name"]])

    def test_cleanup_refuses_replaced_group_even_after_user_is_gone(self):
        harness = C.Harness(CFG, C.bundle(SOURCE, CFG))
        harness.created.update(group=True)
        with patch.object(harness, "clean_case"), patch.object(C.grp, "getgrnam", return_value=SimpleNamespace(gr_gid=1001)), patch.object(C, "cmd", side_effect=AssertionError("executed")):
            with self.assertRaisesRegex(RuntimeError, "changed group"):
                harness.cleanup()

    def test_idle_requires_kernel_write_order_and_empty_proof(self):
        for empty in ("empty", "removed"):
            text = "\n".join(trace(k, 1000 + i / 100) for i, k in enumerate(("freeze1", "kill", empty, "stop", "freeze0")))
            self.assertEqual(len(C.analyze_trace(text, CFG, "idle")), 5)

    def test_thaw_before_kill_is_rejected(self):
        text = "\n".join(trace(k, 1000 + i / 100) for i, k in enumerate(("freeze1", "freeze0", "kill", "empty", "stop")))
        with self.assertRaisesRegex(RuntimeError, "thawed before"): C.analyze_trace(text, CFG, "idle")

    def test_no_empty_proof_or_failed_kernel_write_cannot_pass(self):
        for text in ("\n".join(trace(k, 1000 + i / 100) for i, k in enumerate(("freeze1", "kill", "stop"))),
                     "\n".join(trace(k, 1000 + i / 100) for i, k in enumerate(("freeze1", "kill", "empty", "stop"))).replace('"1\\n", 2) = 2', '"1\\n", 2) = -1 EIO')):
            with self.assertRaises(RuntimeError): C.analyze_trace(text, CFG, "idle")

    def test_a_failed_read_cannot_be_claimed_as_empty_proof(self):
        text = "\n".join(trace(k, 1000 + i / 100) for i, k in enumerate(("freeze1", "kill", "empty", "stop")))
        with self.assertRaisesRegex(RuntimeError, "no empty"):
            C.analyze_trace(text.replace('131072) = 21', '131072) = -1 EIO'), CFG, "idle")

    def test_busy_and_abnormal_cases_reject_any_kill_or_stop(self):
        for phase in ("before", "race", "sigkill", "timeout"):
            text = "\n".join(trace(k, 1000 + i / 100) for i, k in enumerate(("freeze1", "kill", "empty", "stop")))
            with self.assertRaisesRegex(RuntimeError, "killed or stopped"): C.analyze_trace(text, CFG, phase)

    def test_allow_list_identities_are_adapted_and_bash_stays_real(self):
        helper = C.adapt(SOURCE, CFG)
        self.assertIn("      " + CFG["program"] + "/Runner.Listener)", helper)
        self.assertIn("      /usr/bin/bash) ;;", helper, "the canary checks the guest's real bash, as production does")
        self.assertNotIn("/opt/actions-runner", helper)
        with self.assertRaisesRegex(RuntimeError, "unrecognized source identity"):
            C.adapt(SOURCE.replace("/opt/actions-runner/bin/Runner.Listener)", "*/Runner.Listener)"), CFG)

    def test_listener_is_bash_with_one_native_listener_and_spawns_each_visible_kind(self):
        files = C.bundle(SOURCE, CFG)
        self.assertIn("ExecStart=/bin/bash " + CFG["program"] + "/listener.sh " + CFG["runtime"] + " " + CFG["program"], files[CFG["unit"]])
        listener = files["listener.sh"]
        self.assertIn('"$program/Runner.Listener" 600 &', listener.split("exec 3<>")[0], "one Listener before any request")
        for request, name in C.VISIBLE.values():
            self.assertIn(request + ') "$program/' + name + '" 600 & ;;', listener)
        self.assertEqual(C.SCENARIOS, ["before", "leftover", "second-listener", "race", "sigkill", "idle", "timeout"])

    def test_visible_busy_processes_cannot_be_paused_killed_or_stopped(self):
        for phase in ("leftover", "second-listener"):
            self.assertEqual(C.analyze_trace("", CFG, phase), [])
            with self.assertRaisesRegex(RuntimeError, "already-visible busy process was paused"): C.analyze_trace(trace("freeze1", 1000), CFG, phase)
            text = "\n".join(trace(k, 1000 + i / 100) for i, k in enumerate(("freeze1", "kill", "empty", "stop")))
            with self.assertRaisesRegex(RuntimeError, "killed or stopped"): C.analyze_trace(text, CFG, phase)

    def test_before_worker_cannot_be_paused_and_race_must_reach_freezer(self):
        self.assertEqual(C.analyze_trace("", CFG, "before"), [])
        with self.assertRaises(RuntimeError): C.analyze_trace(trace("freeze1", 1000), CFG, "before")
        with self.assertRaises(RuntimeError): C.analyze_trace("", CFG, "race")
        self.assertEqual(len(C.analyze_trace(trace("freeze1", 1000), CFG, "sigkill")), 1)


if __name__ == "__main__": unittest.main(argv=[sys.argv[0], *unittest_args])
