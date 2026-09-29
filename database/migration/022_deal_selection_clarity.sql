BEGIN;

-- A "Regular" drink in a selectable deal is the 345ml soft-drink variant.
-- Keep the customer-facing label while giving the cart validator an exact,
-- canonical variant label to match against.
UPDATE restaurant_deal_components AS component
SET allowed_item_rule = component.allowed_item_rule || '{"size":"345ml"}'::jsonb
FROM restaurant_deals AS deal
WHERE deal.id = component.deal_id
  AND component.selectable = TRUE
  AND component.component_type = 'drink'
  AND component.allowed_item_rule->>'size_label' = 'Regular';

-- Keep the AI-facing deal metadata aligned with the validation rule above.
UPDATE restaurant_deals
SET selection_rules = selection_rules || '{"drink_size":"345ml"}'::jsonb
WHERE selection_rules->>'drink_size_label' = 'Regular';

INSERT INTO restaurant_menu_rules (rule_key, rule_value, source_note, active)
VALUES (
  'deal_regular_drink_size',
  '{"display_label":"Regular","variant_label":"345ml","scope":"selectable deal drink components only"}'::jsonb,
  'For selectable deal drinks only, the menu label Regular resolves to the 345ml soft-drink variant.'::text,
  TRUE
)
ON CONFLICT (rule_key) DO UPDATE
SET rule_value = EXCLUDED.rule_value,
    source_note = EXCLUDED.source_note,
    active = TRUE,
    updated_at = NOW();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM restaurant_deal_components AS component
    WHERE component.selectable = TRUE
      AND component.component_type = 'drink'
      AND component.allowed_item_rule->>'size_label' = 'Regular'
      AND component.allowed_item_rule->>'size' IS DISTINCT FROM '345ml'
  ) THEN
    RAISE EXCEPTION 'Each selectable Regular deal drink must resolve to the 345ml variant';
  END IF;
END;
$$;

COMMIT;
