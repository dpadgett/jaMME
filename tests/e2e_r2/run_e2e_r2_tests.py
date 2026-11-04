#!/usr/bin/env python3
"""
OpenJK WebAssembly Multiplayer Demo Player & JKA Demo Archive Integration (Round 2) — 4-Tier E2E Test Runner.

Usage:
  python3 /home/dan/OpenJK/tests/e2e_r2/run_e2e_r2_tests.py              # Run all tiers (1-4, 207 tests)
  python3 /home/dan/OpenJK/tests/e2e_r2/run_e2e_r2_tests.py --tier 1     # Run Tier 1 (Feature Coverage, 90 tests)
  python3 /home/dan/OpenJK/tests/e2e_r2/run_e2e_r2_tests.py --tier 2     # Run Tier 2 (Boundary & Corner Cases, 90 tests)
  python3 /home/dan/OpenJK/tests/e2e_r2/run_e2e_r2_tests.py --tier 3     # Run Tier 3 (Pairwise Combinations, 18 tests)
  python3 /home/dan/OpenJK/tests/e2e_r2/run_e2e_r2_tests.py --tier 4     # Run Tier 4 (Real-World Scenarios, 9 tests)
  python3 /home/dan/OpenJK/tests/e2e_r2/run_e2e_r2_tests.py --list       # List all test cases without executing
"""

import argparse
import json
from pathlib import Path
import sys
import time
import traceback
from typing import Dict, List

ROOT_DIR = Path("/home/dan/OpenJK/jaMME")
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from tests.e2e_r2.harness import E2ER2TestContext, TestCase
from tests.e2e_r2.tier1_features import get_tier1_tests
from tests.e2e_r2.tier2_boundaries import get_tier2_tests
from tests.e2e_r2.tier3_pairwise import get_tier3_tests
from tests.e2e_r2.tier4_scenarios import get_tier4_tests


def collect_all_tests() -> List[TestCase]:
    tests: List[TestCase] = []
    tests.extend(get_tier1_tests())
    tests.extend(get_tier2_tests())
    tests.extend(get_tier3_tests())
    tests.extend(get_tier4_tests())
    return tests


def filter_tests(
    all_tests: List[TestCase], tier_arg: str, filter_substr: str = ""
) -> List[TestCase]:
    selected = all_tests
    if tier_arg != "all":
        tier_num = int(tier_arg)
        selected = [t for t in selected if t.tier == tier_num]
    if filter_substr:
        needle = filter_substr.lower()
        selected = [
            t
            for t in selected
            if needle in t.test_id.lower()
            or needle in t.feature.lower()
            or needle in t.description.lower()
        ]
    return selected


def print_test_list(tests: List[TestCase]) -> None:
    print(f"OpenJK WebAssembly Round 2 E2E Test Suite — {len(tests)} Test Cases")
    print("=" * 105)
    tier_counts: Dict[int, int] = {1: 0, 2: 0, 3: 0, 4: 0}
    for tc in tests:
        tier_counts[tc.tier] = tier_counts.get(tc.tier, 0) + 1
        print(
            f"[Tier {tc.tier}] [{tc.feature:<15}] {tc.test_id:<65} — {tc.description}"
        )
    print("=" * 105)
    print(
        f"Summary: Tier 1={tier_counts[1]}, Tier 2={tier_counts[2]}, "
        f"Tier 3={tier_counts[3]}, Tier 4={tier_counts[4]}, Total={len(tests)}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="OpenJK WebAssembly Demo Player & JKA Demo Archive Integration (Round 2) 4-Tier E2E Test Runner"
    )
    parser.add_argument(
        "--tier",
        choices=["1", "2", "3", "4", "all"],
        default="all",
        help="Test tier to execute (1, 2, 3, 4, or all). Default: all",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List matching test cases and counts without running them",
    )
    parser.add_argument(
        "--filter",
        default="",
        help="Optional substring filter on test_id, feature ID, or description",
    )
    parser.add_argument(
        "--base-url",
        default="http://localhost:8081",
        help="Base URL for live JKA Demo Archive web stack (default: http://localhost:8081)",
    )
    parser.add_argument(
        "--json-out",
        default="",
        help="Optional file path to write JSON test report",
    )
    args = parser.parse_args()

    all_tests = collect_all_tests()
    selected = filter_tests(all_tests, args.tier, args.filter)

    if args.list:
        print_test_list(selected)
        return 0

    if not selected:
        print("No test cases matched the specified --tier / --filter criteria.")
        return 1

    print("=" * 100)
    print(
        f"Running OpenJK Round 2 E2E Test Suite (tier={args.tier}, count={len(selected)}, base_url={args.base_url})"
    )
    print("=" * 100)

    ctx = E2ER2TestContext(base_url=args.base_url)
    results = []
    tier_stats: Dict[int, Dict[str, int]] = {
        1: {"total": 0, "passed": 0, "failed": 0},
        2: {"total": 0, "passed": 0, "failed": 0},
        3: {"total": 0, "passed": 0, "failed": 0},
        4: {"total": 0, "passed": 0, "failed": 0},
    }

    suite_t0 = time.time()
    try:
        for idx, tc in enumerate(selected, 1):
            t0 = time.time()
            tier_stats[tc.tier]["total"] += 1
            try:
                tc.fn(ctx)
                dt_ms = (time.time() - t0) * 1000.0
                tier_stats[tc.tier]["passed"] += 1
                results.append(
                    {
                        "test_id": tc.test_id,
                        "tier": tc.tier,
                        "feature": tc.feature,
                        "status": "PASS",
                        "duration_ms": round(dt_ms, 1),
                    }
                )
                print(
                    f"[{idx:3d}/{len(selected):3d}] [PASS] (T{tc.tier} {tc.feature}) "
                    f"{tc.test_id} ({dt_ms:.0f} ms)"
                )
            except Exception as exc:
                dt_ms = (time.time() - t0) * 1000.0
                tier_stats[tc.tier]["failed"] += 1
                tb_str = traceback.format_exc()
                results.append(
                    {
                        "test_id": tc.test_id,
                        "tier": tc.tier,
                        "feature": tc.feature,
                        "status": "FAIL",
                        "duration_ms": round(dt_ms, 1),
                        "error": str(exc),
                        "traceback": tb_str,
                    }
                )
                print(
                    f"[{idx:3d}/{len(selected):3d}] [FAIL] (T{tc.tier} {tc.feature}) "
                    f"{tc.test_id} ({dt_ms:.0f} ms) -> {exc}"
                )
    finally:
        ctx.close()

    suite_elapsed = time.time() - suite_t0
    total_run = sum(s["total"] for s in tier_stats.values())
    total_passed = sum(s["passed"] for s in tier_stats.values())
    total_failed = sum(s["failed"] for s in tier_stats.values())

    print("\n" + "=" * 100)
    print("Round 2 E2E Test Suite Summary")
    print("-" * 100)
    for t_num in (1, 2, 3, 4):
        st = tier_stats[t_num]
        if st["total"] > 0:
            pct = (st["passed"] / st["total"]) * 100.0
            print(
                f"  Tier {t_num}: {st['passed']:3d}/{st['total']:3d} passed "
                f"({st['failed']:2d} failed) — {pct:5.1f}%"
            )
    overall_pct = (total_passed / total_run * 100.0) if total_run else 0.0
    print("-" * 100)
    print(
        f"  TOTAL : {total_passed:3d}/{total_run:3d} passed "
        f"({total_failed:2d} failed) — {overall_pct:5.1f}% in {suite_elapsed:.1f}s"
    )
    print("=" * 100)

    if args.json_out:
        out_path = Path(args.json_out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps(
                {
                    "total": total_run,
                    "passed": total_passed,
                    "failed": total_failed,
                    "elapsed_seconds": round(suite_elapsed, 2),
                    "tier_stats": tier_stats,
                    "results": results,
                },
                indent=2,
            ),
            encoding="utf-8",
        )

    return 0 if total_failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
