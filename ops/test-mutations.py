"""Prove that three deliberately broken copies fail their specific acceptance tests."""
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import zipfile


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def replace_once(path, old, new):
    source = path.read_text(encoding="utf-8")
    if source.count(old) != 1:
        raise RuntimeError(f"Mutation target changed in {path.name}")
    path.write_text(source.replace(old, new), encoding="utf-8")


def expect_failure(args, marker, cwd, env=None):
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True,
                            encoding="utf-8", errors="replace")
    if result.returncode == 0 or marker not in result.stdout + result.stderr:
        raise RuntimeError(f"Expected test failure containing {marker!r}; exit {result.returncode}")
    print(f"Detected mutation: {marker}", flush=True)


def main():
    with tempfile.TemporaryDirectory(prefix="bonfire-mutations-") as scratch:
        root = Path(scratch) / "source"
        snapshot = Path(scratch) / "source.zip"
        run("git", "archive", "--format=zip", "-o", str(snapshot), "HEAD")
        with zipfile.ZipFile(snapshot) as archive:
            archive.extractall(root)
        cash = root / "sync.go"
        replace_once(cash, "total += c * n", "total += c * n + 1")
        expect_failure(["go", "test", "-count=1", "-run", "^TestCashVectors$", "."],
                       "FAIL: TestCashVectors/R01", root)
        replace_once(cash, "total += c * n + 1", "total += c * n")

        workflow = root / ".github/workflows/test.yml"
        replace_once(workflow, "recovery, coverage]", "recovery]")
        expect_failure(["go", "test", "-count=1", "-run", "^TestRequiredJobs$", "."],
                       'Required check omits "coverage"', root)
        replace_once(workflow, "recovery]", "recovery, coverage]")

        replace_once(root / "finance.go", "if err != nil || duplicate {", "if err != nil {")
        env = os.environ.copy()
        env.update(COMPOSE_PROJECT_NAME="bonfire-mutant-" + secrets.token_hex(6),
                   BONFIRE_DISPOSABLE_TEST="1", COMPOSE_FILE="compose.yaml", BONFIRE_PORT="0",
                   BONFIRE_ADMIN_PASSWORD=secrets.token_hex(24),
                   BONFIRE_RUNTIME_PASSWORD=secrets.token_hex(24),
                   BONFIRE_DB_PASSWORD=secrets.token_hex(24))
        try:
            run("docker", "compose", "up", "--build", "--wait", "app", cwd=root, env=env)
            port = run("docker", "compose", "port", "app", "8080", cwd=root, env=env,
                       capture_output=True, text=True).stdout.strip()
            env["BONFIRE_URL"] = "http://" + port
            expect_failure(["node", "tests/duplicate-reference.mjs"],
                           "Duplicate business reference must return 409; received 200", root, env)
        finally:
            run("docker", "compose", "down", "-v", "--rmi", "local", cwd=root, env=env)


if __name__ == "__main__":
    main()
