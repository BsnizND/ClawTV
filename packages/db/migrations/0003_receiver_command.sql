ALTER TABLE playback_state
ADD COLUMN receiver_command_id TEXT;

ALTER TABLE playback_state
ADD COLUMN receiver_command_type TEXT;

ALTER TABLE playback_state
ADD COLUMN receiver_command_at TEXT;
