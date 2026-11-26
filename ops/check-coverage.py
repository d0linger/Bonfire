"""Combine Go statement profiles from the same build and enforce measured minimums."""
from pathlib import Path
import subprocess
import sys

CORE = {"allocationValid", "amountPositions", "cashAdjustment", "checkBalance", "checkCashAmount",
        "checkOpenPayments", "pooledRevenue", "validateSettlement", "walletRevenue", "withinCount"}


def read_profile(path):
    header, *lines = Path(path).read_text(encoding="utf-8-sig").splitlines()
    if header != "mode: set" or not lines:
        raise ValueError(f"Expected a Go set profile in {path}")
    blocks = {}
    for line in lines:
        location, statements, hit = line.split()
        blocks[(location, int(statements))] = int(hit)
    return blocks


def main(unit, integration, output):
    unit, integration = read_profile(unit), read_profile(integration)
    if unit.keys() != integration.keys():
        raise ValueError("Coverage profiles describe different source blocks")
    with Path(output).open("w", encoding="utf-8") as report:
        report.write("mode: set\n")
        for (location, size), hit in sorted(unit.items()):
            report.write(f"{location} {size} {max(hit, integration[location, size])}\n")
    results = subprocess.check_output(["go", "tool", "cover", "-func=" + output], text=True)
    print(results)
    scores = {line.split()[-2]: float(line.split()[-1].rstrip("%")) for line in results.splitlines()}
    failed = [name for name in sorted(CORE) if scores.get(name, 0) < 90]
    if scores.get("(statements)", 0) < 52:
        failed.append("whole application (52% minimum)")
    if failed:
        raise SystemExit("Coverage below minimum: " + ", ".join(failed))


if __name__ == "__main__":
    main(*sys.argv[1:])
