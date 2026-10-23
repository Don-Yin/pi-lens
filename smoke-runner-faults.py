"""Measured smoke-classifier false passes, at a 16 cm display width."""

from __future__ import annotations

import json
from pathlib import Path

from python_plotting_convention import publication_subplots, tag_artist


def build_figure():
    data_path = Path(__file__).with_name("smoke-verdicts.json")
    data = json.loads(data_path.read_text())
    variants = data["variants"]
    counts = [
        sum(row["verdict"]["state"] == "pass" for row in variant["rows"])
        for variant in variants
    ]
    totals = [len(variant["rows"]) for variant in variants]
    if len(variants) != 2 or totals[0] != totals[1]:
        raise ValueError("Expected equal base/fixed scenario populations")

    fig, ax = publication_subplots(target_width_cm=16, height_cm=7.5)
    fig.subplots_adjust(left=0.17, right=0.97, bottom=0.18, top=0.87)
    bars = ax.bar([0, 1], counts, width=0.5, color="#356D9D")
    ax.bar_label(
        bars,
        labels=[f"{count}/{total}" for count, total in zip(counts, totals, strict=True)],
        padding=4,
    )
    ax.set_xticks([0, 1], [f"Base {data['baseSha'][:7]}", "Fixed"])
    ax.set_xlim(-0.65, 1.65)
    ax.set_ylim(0, totals[0] + 0.5)
    ax.set_yticks([0, 6, 12, 18])
    ax.set_ylabel("Fault scenarios counted as pass", fontsize=11)
    ax.grid(axis="y", linestyle=":", alpha=0.3)
    ax.set_axisbelow(True)
    tag_artist(ax, semantic_role="body")
    fig.text(
        0.17, 0.94, "Controlled probe: 9 kinds × 2 diagnostic states",
        fontsize=10, ha="left", va="center",
    )
    return fig, {
        "scientific_job": "comparison",
        "data_source": "smoke-verdicts.json",
        "source_seam": data["source"],
        "base_sha": data["baseSha"],
        "scenario_counts": totals,
        "false_pass_counts": counts,
        "illustrative_data": False,
    }
