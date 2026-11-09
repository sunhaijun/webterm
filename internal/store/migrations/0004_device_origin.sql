-- Several machines in one page (ADR-0062 §4): the page origin a device was
-- paired from when that wasn't the agent's own. Requests carrying Origin must
-- then come from the agent's own origin or this one. Existing devices get NULL
-- and keep working only from the agent's own page, as before.
ALTER TABLE devices ADD COLUMN origin TEXT;
