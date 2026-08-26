BEGIN;

CREATE TABLE IF NOT EXISTS restaurant_settings (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    restaurant_name TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'PKR',
    delivery_charge NUMERIC(10,2) NOT NULL DEFAULT 0,
    opening_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS menu_categories (
    id BIGSERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS menu_items (
    id BIGSERIAL PRIMARY KEY,
    category_id BIGINT REFERENCES menu_categories(id),
    name TEXT UNIQUE NOT NULL,
    aliases TEXT[] NOT NULL DEFAULT '{}',
    description TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS menu_variants (
    id BIGSERIAL PRIMARY KEY,
    menu_item_id BIGINT NOT NULL
        REFERENCES menu_items(id) ON DELETE CASCADE,
    size TEXT NOT NULL,
    price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (menu_item_id, size)
);

CREATE TABLE IF NOT EXISTS menu_extras (
    id BIGSERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    extra_type TEXT NOT NULL,
    price NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
    active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_menu_items_category
    ON menu_items(category_id);

CREATE INDEX IF NOT EXISTS idx_menu_variants_item
    ON menu_variants(menu_item_id);

COMMIT;