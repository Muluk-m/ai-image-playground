# First successful setup

After `auth status` is ready and `capabilities` succeeds, briefly tell the user the
connection is ready. List all models returned by this account's current
`capabilities`: show their labels and mark `default_model`. Use IDs when labels
are missing or ambiguous. Do not hard-code a model catalog, infer model strengths,
or include prices unless asked. Reuse the capabilities response from setup.

Show the invocation appropriate to the host where the Skill was installed:

| Host | How to invoke | Example request |
| --- | --- | --- |
| Codex desktop | Type `/` and select the Muvloom Skill if listed; `$muvloom` is an explicit invocation | `$muvloom 用这张商品照片制作一套电商图` |
| Codex CLI / IDE | Run `/skills` and select Muvloom, or type `$muvloom` | `$muvloom 用指定的可用模型生成一张小猫表情包` |
| Claude Code | Use `/muvloom` | `/muvloom 用这张商品照片制作一套电商图` |
| Other hosts without an installed Skill | Use natural language | `用幕芽生成一张小猫表情包` |

Also explain that natural-language requests using 幕芽, muya or muvloom can select
the Skill automatically in supported hosts. A user may name any available model
in their request; omit the model to use the displayed default. When an explicit
invocation is not visible yet, refresh the host's skill list or reopen the
session; natural-language requests remain usable. Do not invent a slash alias
that the host has not registered.

If setup was part of an image request, give this brief introduction and continue
that request. Installation-only setup ends here without a sample generation.
