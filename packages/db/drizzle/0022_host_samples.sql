CREATE TABLE "host_samples" (
	"sampled_at" timestamp with time zone PRIMARY KEY NOT NULL,
	"disk_total_bytes" bigint NOT NULL,
	"disk_available_bytes" bigint NOT NULL,
	"mem_total_bytes" bigint NOT NULL,
	"mem_available_bytes" bigint NOT NULL
);
