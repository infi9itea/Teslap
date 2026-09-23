-- Backstop for the concurrency design in Section 7 of the plan: even if a bug
-- ever bypassed the SELECT ... FOR UPDATE lock in application code, this
-- trigger makes an overbooked Tesla impossible at the database level.
--
-- capacity lives on `teslas`, occupied_seats lives on `pools` — a plain CHECK
-- constraint can't reference another table, so this needs a trigger.
--
-- Run this once after `prisma migrate deploy`:
--   psql "$DATABASE_URL" -f prisma/sql/enforce_capacity_trigger.sql

CREATE OR REPLACE FUNCTION enforce_pool_capacity() RETURNS trigger AS $$
DECLARE
  tesla_capacity INT;
BEGIN
  SELECT capacity INTO tesla_capacity FROM teslas WHERE id = NEW.tesla_id;

  IF NEW.occupied_seats > tesla_capacity THEN
    RAISE EXCEPTION 'pool % would exceed tesla capacity (% > %)',
      NEW.id, NEW.occupied_seats, tesla_capacity
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_pool_capacity ON pools;

CREATE TRIGGER trg_enforce_pool_capacity
  BEFORE INSERT OR UPDATE ON pools
  FOR EACH ROW
  EXECUTE FUNCTION enforce_pool_capacity();
