# Capabilities

Run `muvloom capabilities` immediately before an operation that may create work. Treat the service response as authoritative: do not assume a model, provider, image size, quality, cost, quota, or processing duration. If the requested operation is unavailable, explain the response and do not submit a task.

Capability discovery is read-only. It does not create a task or charge. Never hard-code prices, models, or durations in an agent request.
