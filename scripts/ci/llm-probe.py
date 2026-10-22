#!/usr/bin/env python3
"""单独调几次评审用的模型接口测延迟，对比不同 reasoning_effort。不打印密钥和响应正文。

环境变量：LLM_URL、LLM_MODEL、OCR_LLM_AUTH_TOKEN；参数：要附带的代码文件路径（模拟评审输入）。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

url = os.environ["LLM_URL"]
model = os.environ["LLM_MODEL"]
token = os.environ["OCR_LLM_AUTH_TOKEN"]
code = open(sys.argv[1], encoding="utf-8").read()[:16000] if len(sys.argv) > 1 else ""

HEADERS = {
    "Content-Type": "application/json",
    "Authorization": f"Bearer {token}",
    "User-Agent": "ocr-latency-probe/1.0",
}

models = [m for m in os.environ.get("PROBE_MODELS", "").split(",") if m] or [model]
variants = [("默认", {}), ("reasoning_effort=low", {"reasoning_effort": "low"})]

# 网关上可用的模型（只打印 id）。
try:
    req = urllib.request.Request(url.replace("/chat/completions", "/models"), headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        ids = sorted(m.get("id", "") for m in json.loads(resp.read()).get("data", []))
    print("可用模型：" + ", ".join(f"`{i}`" for i in ids) + "\n")
except Exception as e:  # noqa: BLE001
    print(f"列模型失败：{type(e).__name__}\n")


def stream_ttft(m, prompt):
    """流式请求：首个内容块到达时间、总时间。"""
    body = {"model": m, "messages": [{"role": "user", "content": prompt}], "stream": True}
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=HEADERS)
    t = time.time()
    first = None
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            for line in resp:
                if first is not None or not line.startswith(b"data:"):
                    continue
                try:
                    chunk = json.loads(line[5:])
                except ValueError:
                    continue
                delta = (chunk.get("choices") or [{}])[0].get("delta") or {}
                # 只算真正的内容或推理文本，跳过只带 role 的首帧。
                if delta.get("content") or delta.get("reasoning_content") or delta.get("reasoning"):
                    first = time.time() - t
    except Exception as e:  # noqa: BLE001
        return f"{type(e).__name__}", ""
    return (f"{first:.1f}" if first is not None else "-"), f"{time.time() - t:.1f}"
prompts = [
    ("tiny", "回复一个字：好"),
    ("code", "请用中文找出下面代码里最严重的一个问题，一句话说明。\n\n" + code),
]

print("## 模型接口延迟实测\n")
print("每格 2 次，非流式。\n")
print("| 模型 | 输入 | 变体 | 耗时(s) | 输入 tok | 输出 tok | 推理 tok | 状态 |")
print("|---|---|---|---|---|---|---|---|")
for m, (pname, prompt), (vname, extra), _ in (
    (m, p, v, i) for m in models for p in prompts for v in variants for i in range(2)
):
        body = {"model": m, "messages": [{"role": "user", "content": prompt}], **extra}
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode(),
            headers=HEADERS,
        )
        t = time.time()
        status, u = "?", {}
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                status = resp.status
                u = json.loads(resp.read()).get("usage") or {}
        except urllib.error.HTTPError as e:
            status = e.code  # 不打印错误正文，可能回显请求内容
        except Exception as e:  # noqa: BLE001
            status = type(e).__name__
        dt = time.time() - t
        r = (u.get("completion_tokens_details") or {}).get("reasoning_tokens", "-")
        print(f"| {m} | {pname} | {vname} | {dt:.1f} | {u.get('prompt_tokens', '-')} | {u.get('completion_tokens', '-')} | {r} | {status} |")
        sys.stdout.flush()

print("\n流式首字延迟（TTFT）：\n")
print("| 模型 | 输入 | 首块(s) | 总计(s) |")
print("|---|---|---|---|")
for m in models:
    for pname, prompt in prompts:
        first, total = stream_ttft(m, prompt)
        print(f"| {m} | {pname} | {first} | {total} |")
        sys.stdout.flush()
