ALTER TABLE clips ADD COLUMN first_aired_at INTEGER;
ALTER TABLE clips ADD COLUMN air_count INTEGER NOT NULL DEFAULT 0;

-- Existing production clips have already aired. Backfilling prevents a deploy
-- from presenting historical material as newly generated television.
UPDATE clips
SET first_aired_at = generated_at,
    air_count = 1
WHERE ready = 1;

CREATE INDEX IF NOT EXISTS idx_clips_fresh_ready
ON clips(ready, first_aired_at, id);
