-- Why a trip was or was not counted, and how much parked time was removed.
--   flags: comma-separated, e.g. 'parked_trimmed', 'long_stop_unverified',
--          'missed_dest_post', 'did_not_cross', 'implausible_duration'
ALTER TABLE trips ADD COLUMN flags TEXT;
ALTER TABLE trips ADD COLUMN parked_minutes REAL;
