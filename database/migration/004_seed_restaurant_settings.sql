BEGIN;

INSERT INTO restaurant_settings (id, restaurant_name, currency, delivery_charge, opening_hours)
VALUES (
  1,
  'Pizza Bar',
  'PKR',
  150.00,
  '{"mon_fri": "11:00-23:00", "sat_sun": "12:00-00:00"}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  restaurant_name = EXCLUDED.restaurant_name,
  currency = EXCLUDED.currency,
  delivery_charge = EXCLUDED.delivery_charge,
  opening_hours = EXCLUDED.opening_hours,
  updated_at = NOW();

COMMIT;
