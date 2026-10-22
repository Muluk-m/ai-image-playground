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

variants = [
    ("默认（不传 reasoning_effort）", {}),
    ("reasoning_effort=low", {"reasoning_effort": "low"}),
    ("reasoning_effort=medium", {"reasoning_effort": "medium"}),
    ("reasoning_effort=high", {"reasoning_effort": "high"}),
]
prompts = [
    ("tiny", "回复一个字：好"),
    ("code", "请用中文找出下面代码里最严重的一个问题，一句话说明。\n\n" + code),
]

print("## 模型接口延迟实测\n")
print(f"模型 `{model}`，每格 2 次，非流式。\n")
print("| 输入 | 变体 | 耗时(s) | 输入 tok | 输出 tok | 推理 tok | 状态 |")
print("|---|---|---|---|---|---|---|")
for pname, prompt in prompts:
    for vname, extra in variants:
        for _ in range(2):
            body = {"model": model, "messages": [{"role": "user", "content": prompt}], **extra}
            req = urllib.request.Request(
                url,
                data=json.dumps(body).encode(),
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
            )
            t = time.time()
            status, u = "?", {}
            try:
                with urllib.request.urlopen(req, timeout=300) as resp:
                    status = resp.status
                    u = json.loads(resp.read()).get("usage") or {}
            except urllib.error.HTTPError as e:
                status = e.code
            except Exception as e:  # noqa: BLE001
                status = type(e).__name__
            dt = time.time() - t
            r = (u.get("completion_tokens_details") or {}).get("reasoning_tokens", "-")
            print(f"| {pname} | {vname} | {dt:.1f} | {u.get('prompt_tokens', '-')} | {u.get('completion_tokens', '-')} | {r} | {status} |")
            sys.stdout.flush()
