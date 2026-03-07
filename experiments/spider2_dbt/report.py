"""Generate an interactive single-file HTML report for Spider 2.0-DBT benchmark.

Usage:
    python report.py                                              # Use latest evaluation
    python report.py --evaluation results/evaluation_*.json
    python report.py --output reports/custom_report.html
"""

from __future__ import annotations

import argparse
import html
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from config import LEADERBOARD, REPORTS_DIR, RESULTS_DIR


def find_latest_evaluation() -> Path:
    """Find the latest evaluation results file."""
    latest = RESULTS_DIR / "evaluation_latest.json"
    if latest.exists() or latest.is_symlink():
        return latest.resolve()

    files = sorted(RESULTS_DIR.glob("evaluation_*.json"), reverse=True)
    if not files:
        print("ERROR: No evaluation results found. Run `python evaluate_results.py` first.")
        sys.exit(1)
    return files[0]


def load_benchmark_results(evaluation: dict[str, Any]) -> dict[str, Any] | None:
    """Load the source benchmark results referenced by the evaluation."""
    src = evaluation.get("source_results", "")
    if src:
        p = Path(src)
        if p.exists():
            return json.loads(p.read_text())
    return None


def esc(text: str) -> str:
    """HTML-escape a string."""
    return html.escape(str(text))


def build_leaderboard_svg(pass_rate: float, model: str) -> str:
    """Build a horizontal bar chart SVG comparing against the leaderboard."""
    entries = list(LEADERBOARD) + [(f"Altimate Code ({model})", pass_rate)]
    entries.sort(key=lambda x: x[1], reverse=True)

    bar_height = 28
    gap = 4
    label_width = 220
    chart_width = 400
    total_width = label_width + chart_width + 80
    total_height = len(entries) * (bar_height + gap) + 20

    max_val = max(e[1] for e in entries)
    scale = chart_width / max(max_val, 1)

    bars = []
    for i, (name, rate) in enumerate(entries):
        y = i * (bar_height + gap) + 10
        w = rate * scale
        is_ours = "Altimate Code" in name

        fill = "#6366f1" if is_ours else "#e2e8f0"
        text_fill = "#1e1b4b" if is_ours else "#475569"
        font_weight = "bold" if is_ours else "normal"
        border = ' stroke="#4f46e5" stroke-width="2"' if is_ours else ""

        bars.append(f"""
    <text x="{label_width - 8}" y="{y + bar_height / 2 + 5}"
          text-anchor="end" font-size="13" fill="{text_fill}"
          font-weight="{font_weight}">{esc(name)}</text>
    <rect x="{label_width}" y="{y}" width="{w}" height="{bar_height}"
          rx="4" fill="{fill}"{border} />
    <text x="{label_width + w + 6}" y="{y + bar_height / 2 + 5}"
          font-size="12" fill="{text_fill}"
          font-weight="{font_weight}">{rate:.2f}%</text>""")

    return f"""<svg viewBox="0 0 {total_width} {total_height}"
     xmlns="http://www.w3.org/2000/svg"
     style="width:100%;max-width:{total_width}px;height:auto">
  {"".join(bars)}
</svg>"""


def build_timing_svg(task_results: list[dict[str, Any]]) -> str:
    """Build a histogram SVG of task execution times."""
    times = [t.get("elapsed_s", 0) for t in task_results if t.get("elapsed_s", 0) > 0]
    if not times:
        return "<p>No timing data available.</p>"

    # Bucket into bins
    max_time = max(times)
    num_bins = min(20, len(times))
    bin_width = max_time / num_bins if num_bins > 0 else 1
    bins = [0] * num_bins

    for t in times:
        idx = min(int(t / bin_width), num_bins - 1)
        bins[idx] += 1

    max_count = max(bins) if bins else 1
    chart_w = 600
    chart_h = 200
    bar_w = chart_w / num_bins
    scale = (chart_h - 30) / max(max_count, 1)

    bars = []
    for i, count in enumerate(bins):
        x = i * bar_w
        h = count * scale
        y = chart_h - 30 - h
        label = f"{bin_width * i:.0f}-{bin_width * (i + 1):.0f}s"
        bars.append(
            f'<rect x="{x + 1}" y="{y}" width="{bar_w - 2}" height="{h}" '
            f'rx="2" fill="#6366f1" opacity="0.8">'
            f"<title>{label}: {count} tasks</title></rect>"
        )

    # X-axis labels (every 4th bin)
    labels = []
    for i in range(0, num_bins, max(1, num_bins // 5)):
        x = i * bar_w + bar_w / 2
        labels.append(
            f'<text x="{x}" y="{chart_h - 5}" text-anchor="middle" '
            f'font-size="10" fill="#64748b">{bin_width * i:.0f}s</text>'
        )

    return f"""<svg viewBox="0 0 {chart_w} {chart_h}"
     xmlns="http://www.w3.org/2000/svg"
     style="width:100%;max-width:{chart_w}px;height:auto">
  {"".join(bars)}
  {"".join(labels)}
</svg>"""


def build_html(evaluation: dict[str, Any], benchmark: dict[str, Any] | None) -> str:
    """Build the complete HTML report."""
    model = evaluation.get("model", "unknown")
    total = evaluation.get("total", 0)
    passed = evaluation.get("passed", 0)
    failed = evaluation.get("failed", 0)
    errors = evaluation.get("errors", 0)
    pass_rate = evaluation.get("pass_rate", 0.0)
    timestamp = evaluation.get("timestamp", "")
    domain_stats = evaluation.get("domain_stats", {})
    evaluations = evaluation.get("evaluations", [])

    task_results = benchmark.get("task_results", []) if benchmark else []

    # Map instance_id -> task result for merging
    task_map = {t["instance_id"]: t for t in task_results}

    # Compute projected rank
    all_entries = list(LEADERBOARD) + [("Altimate Code", pass_rate)]
    all_entries.sort(key=lambda x: x[1], reverse=True)
    rank = next(i + 1 for i, (n, _) in enumerate(all_entries) if n == "Altimate Code")

    total_time = benchmark.get("total_elapsed_s", 0) if benchmark else 0
    avg_time = benchmark.get("avg_elapsed_s", 0) if benchmark else 0

    # Leaderboard chart
    leaderboard_svg = build_leaderboard_svg(pass_rate, model)

    # Timing histogram
    timing_svg = build_timing_svg(task_results) if task_results else "<p>No timing data.</p>"

    # Domain breakdown rows
    domain_rows = ""
    for domain, stats in sorted(domain_stats.items()):
        dr = (stats["passed"] / stats["total"] * 100) if stats["total"] > 0 else 0
        bar_w = dr * 2  # max 200px at 100%
        domain_rows += f"""
      <tr>
        <td>{esc(domain)}</td>
        <td>{stats['total']}</td>
        <td>{stats['passed']}</td>
        <td>{stats['failed']}</td>
        <td>{stats.get('errors', 0)}</td>
        <td>
          <div class="bar-cell">
            <div class="bar" style="width:{bar_w}px"></div>
            <span>{dr:.1f}%</span>
          </div>
        </td>
      </tr>"""

    # Per-task rows
    task_rows = ""
    for ev in evaluations:
        iid = ev["instance_id"]
        task_data = task_map.get(iid, {})
        status_class = "pass" if ev["passed"] else "fail"
        status_text = "PASS" if ev["passed"] else "FAIL"
        if ev.get("error"):
            status_class = "error"
            status_text = "ERROR"
        elapsed = task_data.get("elapsed_s", "—")
        domain = task_data.get("domain", "—")
        instruction = task_data.get("instruction", "")[:120]
        agent_output = task_data.get("agent_output", "")
        error_detail = ev.get("error", "")
        stderr = task_data.get("stderr_tail", "")

        details_content = ""
        if agent_output:
            details_content += f"<h4>Agent Output</h4><pre>{esc(agent_output[:3000])}</pre>"
        if error_detail:
            details_content += f"<h4>Evaluation Error</h4><pre>{esc(error_detail)}</pre>"
        if stderr:
            details_content += f"<h4>Stderr</h4><pre>{esc(stderr[:1000])}</pre>"

        task_rows += f"""
      <tr class="task-row" data-status="{status_class}" data-domain="{esc(domain)}">
        <td><code>{esc(iid)}</code></td>
        <td>{esc(domain)}</td>
        <td><span class="badge {status_class}">{status_text}</span></td>
        <td>{elapsed}</td>
        <td class="instruction">{esc(instruction)}</td>
      </tr>"""
        if details_content:
            task_rows += f"""
      <tr class="detail-row" style="display:none">
        <td colspan="5"><div class="details">{details_content}</div></td>
      </tr>"""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Spider 2.0-DBT Benchmark — Altimate Code</title>
<style>
  :root {{
    --bg: #f8fafc; --card: #fff; --border: #e2e8f0;
    --text: #1e293b; --muted: #64748b;
    --pass: #22c55e; --fail: #ef4444; --error: #f59e0b;
    --accent: #6366f1; --accent-light: #e0e7ff;
  }}
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg); color: var(--text);
    line-height: 1.6; padding: 2rem; max-width: 1200px; margin: 0 auto;
  }}
  h1 {{ font-size: 1.8rem; margin-bottom: 0.5rem; }}
  h2 {{ font-size: 1.3rem; margin: 2rem 0 1rem; color: var(--text); }}
  h3 {{ font-size: 1.1rem; margin: 1.5rem 0 0.5rem; }}
  h4 {{ font-size: 0.9rem; margin: 0.5rem 0; color: var(--muted); }}

  .meta {{ color: var(--muted); font-size: 0.9rem; margin-bottom: 2rem; }}

  .cards {{
    display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 1rem; margin-bottom: 2rem;
  }}
  .card {{
    background: var(--card); border: 1px solid var(--border);
    border-radius: 12px; padding: 1.2rem; text-align: center;
  }}
  .card .value {{
    font-size: 2rem; font-weight: 700; line-height: 1.2;
  }}
  .card .label {{
    font-size: 0.85rem; color: var(--muted); margin-top: 0.3rem;
  }}
  .card.highlight {{ border-color: var(--accent); background: var(--accent-light); }}
  .card.highlight .value {{ color: var(--accent); }}

  .section {{
    background: var(--card); border: 1px solid var(--border);
    border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem;
  }}

  table {{
    width: 100%; border-collapse: collapse; font-size: 0.9rem;
  }}
  th, td {{ padding: 0.6rem 0.8rem; text-align: left; border-bottom: 1px solid var(--border); }}
  th {{ font-weight: 600; color: var(--muted); font-size: 0.8rem; text-transform: uppercase; }}

  .badge {{
    display: inline-block; padding: 0.15rem 0.6rem; border-radius: 9999px;
    font-size: 0.75rem; font-weight: 600; text-transform: uppercase;
  }}
  .badge.pass {{ background: #dcfce7; color: #166534; }}
  .badge.fail {{ background: #fee2e2; color: #991b1b; }}
  .badge.error {{ background: #fef3c7; color: #92400e; }}

  .bar-cell {{ display: flex; align-items: center; gap: 0.5rem; }}
  .bar {{ height: 20px; background: var(--accent); border-radius: 4px; min-width: 2px; }}

  .task-row {{ cursor: pointer; }}
  .task-row:hover {{ background: #f1f5f9; }}
  .instruction {{ max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}

  .detail-row td {{ padding: 0; }}
  .details {{
    padding: 1rem 1.5rem; background: #f8fafc; border-left: 3px solid var(--accent);
    margin: 0.5rem 0;
  }}
  .details pre {{
    background: #1e293b; color: #e2e8f0; padding: 1rem; border-radius: 8px;
    overflow-x: auto; font-size: 0.8rem; max-height: 300px; overflow-y: auto;
    white-space: pre-wrap; word-break: break-word;
  }}

  .filters {{
    display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap;
  }}
  .filter-btn {{
    padding: 0.3rem 0.8rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--card); cursor: pointer; font-size: 0.85rem;
    transition: all 0.15s;
  }}
  .filter-btn:hover {{ border-color: var(--accent); }}
  .filter-btn.active {{ background: var(--accent); color: white; border-color: var(--accent); }}

  .sort-btn {{ cursor: pointer; user-select: none; }}
  .sort-btn:hover {{ color: var(--accent); }}

  footer {{
    text-align: center; color: var(--muted); font-size: 0.8rem;
    margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border);
  }}
</style>
</head>
<body>

<h1>Spider 2.0-DBT Benchmark Results</h1>
<p class="meta">
  Model: <strong>{esc(model)}</strong> &middot;
  Generated: {esc(timestamp)} UTC &middot;
  Projected Rank: <strong>#{rank}</strong> of {len(all_entries)}
</p>

<!-- Summary Cards -->
<div class="cards">
  <div class="card highlight">
    <div class="value">{pass_rate:.1f}%</div>
    <div class="label">Pass Rate</div>
  </div>
  <div class="card">
    <div class="value">{passed}/{total}</div>
    <div class="label">Tasks Passed</div>
  </div>
  <div class="card">
    <div class="value">{failed}</div>
    <div class="label">Failed</div>
  </div>
  <div class="card">
    <div class="value">{errors}</div>
    <div class="label">Errors</div>
  </div>
  <div class="card">
    <div class="value">{total_time:.0f}s</div>
    <div class="label">Total Time</div>
  </div>
  <div class="card">
    <div class="value">{avg_time:.0f}s</div>
    <div class="label">Avg per Task</div>
  </div>
</div>

<!-- Leaderboard Chart -->
<div class="section">
  <h2>Leaderboard Comparison</h2>
  {leaderboard_svg}
</div>

<!-- Domain Breakdown -->
<div class="section">
  <h2>Category Breakdown</h2>
  <table>
    <thead>
      <tr>
        <th>Domain</th><th>Total</th><th>Passed</th><th>Failed</th><th>Errors</th><th>Pass Rate</th>
      </tr>
    </thead>
    <tbody>{domain_rows}</tbody>
  </table>
</div>

<!-- Timing Distribution -->
<div class="section">
  <h2>Execution Time Distribution</h2>
  {timing_svg}
</div>

<!-- Per-Task Results -->
<div class="section">
  <h2>Per-Task Results</h2>

  <div class="filters">
    <button class="filter-btn active" data-filter="all">All ({total})</button>
    <button class="filter-btn" data-filter="pass">Passed ({passed})</button>
    <button class="filter-btn" data-filter="fail">Failed ({failed})</button>
    <button class="filter-btn" data-filter="error">Errors ({errors})</button>
  </div>

  <table id="task-table">
    <thead>
      <tr>
        <th class="sort-btn" data-col="0">Task ID</th>
        <th class="sort-btn" data-col="1">Domain</th>
        <th class="sort-btn" data-col="2">Status</th>
        <th class="sort-btn" data-col="3">Time (s)</th>
        <th>Instruction</th>
      </tr>
    </thead>
    <tbody>{task_rows}</tbody>
  </table>
</div>

<footer>
  Generated by Altimate Code &middot; Spider 2.0-DBT Benchmark Evaluation Pipeline
</footer>

<script>
// Filter buttons
document.querySelectorAll('.filter-btn').forEach(btn => {{
  btn.addEventListener('click', () => {{
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const filter = btn.dataset.filter;
    document.querySelectorAll('.task-row').forEach(row => {{
      const show = filter === 'all' || row.dataset.status === filter;
      row.style.display = show ? '' : 'none';
      const detail = row.nextElementSibling;
      if (detail && detail.classList.contains('detail-row')) {{
        detail.style.display = 'none';
      }}
    }});
  }});
}});

// Expandable rows
document.querySelectorAll('.task-row').forEach(row => {{
  row.addEventListener('click', () => {{
    const detail = row.nextElementSibling;
    if (detail && detail.classList.contains('detail-row')) {{
      detail.style.display = detail.style.display === 'none' ? '' : 'none';
    }}
  }});
}});

// Column sorting
let sortDir = {{}};
document.querySelectorAll('.sort-btn').forEach(btn => {{
  btn.addEventListener('click', () => {{
    const col = parseInt(btn.dataset.col);
    sortDir[col] = !(sortDir[col] || false);
    const tbody = document.querySelector('#task-table tbody');
    const rows = [];
    let i = 0;
    const allRows = Array.from(tbody.children);
    while (i < allRows.length) {{
      const taskRow = allRows[i];
      if (taskRow.classList.contains('task-row')) {{
        const group = [taskRow];
        if (i + 1 < allRows.length && allRows[i + 1].classList.contains('detail-row')) {{
          group.push(allRows[i + 1]);
          i++;
        }}
        rows.push(group);
      }}
      i++;
    }}
    rows.sort((a, b) => {{
      const va = a[0].children[col]?.textContent || '';
      const vb = b[0].children[col]?.textContent || '';
      const na = parseFloat(va), nb = parseFloat(vb);
      const cmp = (!isNaN(na) && !isNaN(nb)) ? na - nb : va.localeCompare(vb);
      return sortDir[col] ? -cmp : cmp;
    }});
    rows.forEach(group => group.forEach(r => tbody.appendChild(r)));
  }});
}});
</script>

</body>
</html>"""


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Spider 2.0-DBT benchmark report")
    parser.add_argument("--evaluation", type=str, default=None, help="Path to evaluation JSON")
    parser.add_argument("--output", type=str, default=None, help="Output HTML file path")
    args = parser.parse_args()

    # Load evaluation
    eval_path = Path(args.evaluation) if args.evaluation else find_latest_evaluation()
    print(f"Loading evaluation: {eval_path}")
    evaluation = json.loads(eval_path.read_text())

    # Load benchmark results for timing/output data
    benchmark = load_benchmark_results(evaluation)
    if benchmark:
        print(f"Loaded benchmark results: {evaluation.get('source_results', '')}")
    else:
        print("Warning: Source benchmark results not found; report will lack timing/output data.")

    # Generate HTML
    html_content = build_html(evaluation, benchmark)

    # Write output
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = evaluation.get("timestamp", datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S"))
    output_path = Path(args.output) if args.output else REPORTS_DIR / f"spider2_report_{timestamp}.html"
    output_path.write_text(html_content)

    print(f"Report generated: {output_path}")
    print(f"Open in browser: file://{output_path.resolve()}")


if __name__ == "__main__":
    main()
