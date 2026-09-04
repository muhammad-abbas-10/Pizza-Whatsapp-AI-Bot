BEGIN;

-- These legacy menu tables were superseded by the v2 restaurant menu schema
-- and confirmed unused by admin request.json and backend/.

DROP TABLE IF EXISTS menu_items CASCADE;
DROP TABLE IF EXISTS menu_categories CASCADE;
DROP TABLE IF EXISTS menu_variants CASCADE;
DROP TABLE IF EXISTS menu_extras CASCADE;

COMMIT;
