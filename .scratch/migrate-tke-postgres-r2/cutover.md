# TKE soak and DNS cutover

Production pixels: R2 bucket `ai-images`, prefix `image-playground/`, 7-day prefix lifecycle. Never expire the whole bucket.

Images: one image, `APP_ROLE=bff|worker|admin`. Worker health is `WORKER_HEALTH_PORT` (optional). Give SIGTERM at least 60s.

Soak on `image-k8s.nainma.online` (or the hostname you set). Empty Postgres. No sqlite ETL.

Before cutting `image.nainma.online`: drain the Mac mini worker. Do not dual-write.

Human steps: `scripts/tke-cutover-wizard.sh`
