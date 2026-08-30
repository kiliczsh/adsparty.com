UPDATE clips
SET duration = 10
WHERE prompt LIKE '%exactly 10-second%';

UPDATE clips
SET duration = 5
WHERE prompt LIKE '%exactly 5-second%';
