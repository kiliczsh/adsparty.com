ALTER TABLE generation_jobs
ADD COLUMN provider TEXT NOT NULL DEFAULT 'fal';

CREATE INDEX IF NOT EXISTS idx_jobs_provider_status
ON generation_jobs(provider, status, created_at);
