#!/usr/bin/env python3
"""汇总 ocr 的原始 LLM 请求记录（OCR_RAW_LOGGING=1 产生的 jsonl），量化评审时间花在哪。

只读 ~/.opencodereview/raw 下的记录，输出耗时 / token / 状态码统计，不输出请求或响应正文。
用法：ocr-timing.py [raw_dir]，结果打到 stdout（Markdown），可直接追加进 Job Summary。
"""
import glob
import json
import os
import statistics
import sys
from collections import defaultdict
from datetime import datetime, timedelta


def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def usage_of(rec):
    body = rec.get("response_body")
    if isinstance(body, dict):
        u = body.get("usage") or {}
        details = u.get("completion_tokens_details") or u.get("output_tokens_details") or {}
        return (
            u.get("prompt_tokens") or u.get("input_tokens") or 0,
            u.get("completion_tokens") or u.get("output_tokens") or 0,
            details.get("reasoning_tokens") or 0,
        )
    return (0, 0, 0)


def pct(vals, p):
    if not vals:
        return 0
    vals = sorted(vals)
    k = min(len(vals) - 1, max(0, int(round(p / 100 * (len(vals) - 1)))))
    return vals[k]


def fmt_s(ms):
    return f"{ms / 1000:.1f}s"


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.opencodereview/raw")
    recs = []
    for path in glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    recs.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    if not recs:
        print("## ocr 耗时分析\n\n没有原始请求记录（OCR_RAW_LOGGING 未生效或未发出请求）。")
        return

    for r in recs:
        r["_start"] = parse_ts(r["timestamp"])
        r["_end"] = r["_start"] + timedelta(milliseconds=r.get("duration_ms", 0))
        r["_in"], r["_out"], r["_reason"] = usage_of(r)

    t0 = min(r["_start"] for r in recs)
    t1 = max(r["_end"] for r in recs)
    wall = (t1 - t0).total_seconds()
    busy = sum(r.get("duration_ms", 0) for r in recs) / 1000

    status = defaultdict(int)
    for r in recs:
        status[r.get("status_code") or ("transport_error" if r.get("error") else "none")] += 1

    out = []
    out.append("## ocr 耗时分析\n")
    out.append(f"- 首个请求到最后一个响应：**{wall / 60:.1f} 分钟**；LLM 请求累计 {busy / 60:.1f} 分钟，平均并行度 {busy / wall if wall else 0:.2f}")
    out.append(f"- HTTP 尝试 {len(recs)} 次，状态码分布：" + "，".join(f"`{k}`×{v}" for k, v in sorted(status.items(), key=lambda x: str(x[0]))))
    tot_in = sum(r["_in"] for r in recs)
    tot_out = sum(r["_out"] for r in recs)
    tot_reason = sum(r["_reason"] for r in recs)
    out.append(f"- token：输入 {tot_in:,}，输出 {tot_out:,}（其中推理 {tot_reason:,}）")

    out.append("\n### 按任务类型\n")
    out.append("| 任务 | 次数 | 单次中位 | P90 | 最长 | 平均输入 tok | 平均输出 tok | 平均推理 tok |")
    out.append("|---|---|---|---|---|---|---|---|")
    by_type = defaultdict(list)
    for r in recs:
        by_type[r.get("task_type") or "?"].append(r)
    for t, rs in sorted(by_type.items(), key=lambda x: -len(x[1])):
        d = [r.get("duration_ms", 0) for r in rs]
        ok = [r for r in rs if r.get("status_code") == 200] or rs
        out.append(
            f"| {t} | {len(rs)} | {fmt_s(statistics.median(d))} | {fmt_s(pct(d, 90))} | {fmt_s(max(d))} "
            f"| {sum(r['_in'] for r in ok) // len(ok):,} | {sum(r['_out'] for r in ok) // len(ok):,} | {sum(r['_reason'] for r in ok) // len(ok):,} |"
        )

    # 输出速度：只看成功、有输出 token 的请求
    speed = [r["_out"] / (r["duration_ms"] / 1000) for r in recs if r.get("status_code") == 200 and r["_out"] and r.get("duration_ms")]
    if speed:
        out.append(f"\n单次请求的「输出 token / 耗时」中位 {statistics.median(speed):.0f} tok/s")

    out.append("\n### 按评审组（墙钟 = 组内首个请求到最后一个响应）\n")
    out.append("| 组 | 请求数 | 组墙钟 | 组内请求累计 | 组内最长单次 | 组内非 200 |")
    out.append("|---|---|---|---|---|---|")
    by_group = defaultdict(list)
    for r in recs:
        by_group[r.get("file_path") or "(grouping)"].append(r)
    rows = []
    for g, rs in by_group.items():
        gw = (max(r["_end"] for r in rs) - min(r["_start"] for r in rs)).total_seconds()
        rows.append((gw, g, rs))
    for gw, g, rs in sorted(rows, reverse=True):
        label = g if len(g) <= 70 else g[:67] + "..."
        files = g.count(",") + 1 if g != "(grouping)" else 0
        bad = sum(1 for r in rs if r.get("status_code") != 200)
        out.append(
            f"| `{label}`（{files} 文件） | {len(rs)} | {gw / 60:.1f} 分 | {sum(r.get('duration_ms', 0) for r in rs) / 60000:.1f} 分 "
            f"| {fmt_s(max(r.get('duration_ms', 0) for r in rs))} | {bad} |"
        )

    # 同时在途的请求数（按秒采样）
    events = []
    for r in recs:
        events.append((r["_start"], 1))
        events.append((r["_end"], -1))
    events.sort()
    cur = peak = 0
    for _, d in events:
        cur += d
        peak = max(peak, cur)
    out.append(f"\n同时在途的 LLM 请求峰值：{peak}")
    print("\n".join(out))


if __name__ == "__main__":
    main()
