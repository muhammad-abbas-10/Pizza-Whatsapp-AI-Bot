BEGIN;

-- This deal claims to contain two "Regular" pizzas, but the active pizza menu
-- has no Regular variant. Do not silently map it to another size. Keep the
-- record for staff correction, but remove it from the customer-facing menu.
UPDATE restaurant_deals AS deal
SET active = FALSE,
    availability = COALESCE(deal.availability, '{}'::jsonb) || jsonb_build_object(
      'unavailable_reason', 'No active pizza variant matches the configured Regular size.',
      'requires_menu_configuration', TRUE
    ),
    updated_at = NOW()
WHERE deal.name = '2 Regular Pizzas'
  AND deal.active = TRUE
  AND NOT EXISTS (
    SELECT 1
    FROM restaurant_menu_items AS item
    JOIN restaurant_menu_variants AS variant
      ON variant.menu_item_id = item.id
     AND variant.active = TRUE
    WHERE item.active = TRUE
      AND item.item_type LIKE 'pizza%'
      AND LOWER(variant.variant_label) = 'regular'
  );

-- A component that contains two pizzas, drinks, or dips must have two explicit
-- selection groups. A single choice cannot safely mean either "same choice
-- twice" or "one choice per unit". Wings remain a single selectable wing type
-- with a piece count, so they are intentionally not split.
WITH deals_to_reorder AS (
  SELECT DISTINCT component.deal_id
  FROM restaurant_deal_components AS component
  JOIN restaurant_deals AS deal ON deal.id = component.deal_id
  WHERE deal.active = TRUE
    AND component.selectable = TRUE
    AND component.component_type IN ('pizza', 'drink', 'dip')
    AND component.quantity > 1
    AND COALESCE(component.details->>'independent_selection_slot', 'false') <> 'true'
)
UPDATE restaurant_deal_components AS component
SET component_order = component.component_order * 100
WHERE component.deal_id IN (SELECT deal_id FROM deals_to_reorder);

WITH components_to_split AS (
  SELECT component.*
  FROM restaurant_deal_components AS component
  JOIN restaurant_deals AS deal ON deal.id = component.deal_id
  WHERE deal.active = TRUE
    AND component.selectable = TRUE
    AND component.component_type IN ('pizza', 'drink', 'dip')
    AND component.quantity > 1
    AND COALESCE(component.details->>'independent_selection_slot', 'false') <> 'true'
),
inserted AS (
  INSERT INTO restaurant_deal_components (
    deal_id,
    component_order,
    component_type,
    quantity,
    unit,
    size_label,
    component_label,
    selectable,
    selection_group,
    allowed_item_rule,
    details
  )
  SELECT
    component.deal_id,
    component.component_order + slot.ordinality::int,
    component.component_type,
    1,
    component.unit,
    component.size_label,
    component.component_label || ' ' || slot.ordinality::text,
    TRUE,
    component.selection_group || '_' || slot.ordinality::text,
    component.allowed_item_rule,
    component.details || jsonb_build_object(
      'independent_selection_slot', TRUE,
      'slot_index', slot.ordinality,
      'original_quantity', component.quantity
    )
  FROM components_to_split AS component
  CROSS JOIN LATERAL generate_series(1, component.quantity::int) AS slot(ordinality)
  RETURNING deal_id
)
DELETE FROM restaurant_deal_components AS component
USING components_to_split AS original
WHERE component.id = original.id;

-- Old partial configurations can reference selection groups that no longer
-- exist. Clear only configurations that actually contain an old group in
-- either their saved choices or their saved requirements. This keeps the
-- migration harmless to valid in-progress selections if it is rerun.
UPDATE conversation_sessions AS session
SET pending_items = '[]'::jsonb,
    updated_at = NOW()
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(session.pending_items) = 'array' THEN session.pending_items ELSE '[]'::jsonb END
  ) AS pending(item)
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN pending.item->>'deal_id' ~ '^[0-9]+$' THEN (pending.item->>'deal_id')::bigint
      ELSE NULL
    END AS deal_id
  ) AS configured_deal
  WHERE pending.item->>'kind' = 'deal_configuration'
    AND (
      pending.item->>'deal_name' = '2 Regular Pizzas'
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(pending.item->'selected_components') = 'array'
            THEN pending.item->'selected_components' ELSE '[]'::jsonb END
        ) AS choice(component)
        WHERE jsonb_typeof(choice.component) = 'object'
          AND NOT EXISTS (
            SELECT 1
            FROM restaurant_deal_components AS current_component
            WHERE current_component.deal_id = configured_deal.deal_id
              AND current_component.selectable = TRUE
              AND current_component.selection_group = choice.component->>'selection_group'
          )
      )
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(pending.item->'required_components') = 'array'
            THEN pending.item->'required_components' ELSE '[]'::jsonb END
        ) AS required(component)
        WHERE jsonb_typeof(required.component) = 'object'
          AND NOT EXISTS (
            SELECT 1
            FROM restaurant_deal_components AS current_component
            WHERE current_component.deal_id = configured_deal.deal_id
              AND current_component.selectable = TRUE
              AND current_component.selection_group = required.component->>'selection_group'
          )
      )
    )
);

COMMIT;
