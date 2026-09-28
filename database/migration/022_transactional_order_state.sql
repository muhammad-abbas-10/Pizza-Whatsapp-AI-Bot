BEGIN;

-- Persist transactional state independently from the language model.  The
-- existing conversation session remains the single owner of a customer's
-- draft cart, in-progress deal, and checkout quote.
ALTER TABLE conversation_sessions
  ADD COLUMN IF NOT EXISTS draft_deal JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS cart_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quote_cart_revision BIGINT,
  ADD COLUMN IF NOT EXISTS quote_subtotal NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS quote_delivery_charge NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS quote_total NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS quote_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmation_status TEXT NOT NULL DEFAULT 'not_quoted';

UPDATE conversation_sessions
SET draft_deal = '{}'::jsonb
WHERE draft_deal IS NULL OR jsonb_typeof(draft_deal) <> 'object';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversation_sessions_draft_deal_object'
  ) THEN
    ALTER TABLE conversation_sessions
      ADD CONSTRAINT conversation_sessions_draft_deal_object
      CHECK (jsonb_typeof(draft_deal) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversation_sessions_confirmation_status_check'
  ) THEN
    ALTER TABLE conversation_sessions
      ADD CONSTRAINT conversation_sessions_confirmation_status_check
      CHECK (confirmation_status IN ('not_quoted', 'awaiting_confirmation', 'confirmed'));
  END IF;
END $$;

-- These short aliases are intentionally scoped to their canonical products.
-- They make state-constrained phrases such as "fajita" and "pepperoni"
-- deterministic while a deal is waiting for a pizza choice.
INSERT INTO restaurant_menu_aliases (menu_item_id, alias)
SELECT id, 'fajita' FROM restaurant_menu_items WHERE name = 'Chicken Fajita'
UNION ALL
SELECT id, 'pepperoni' FROM restaurant_menu_items WHERE name = 'Classic Pepperoni'
ON CONFLICT (menu_item_id, alias) DO NOTHING;

CREATE OR REPLACE FUNCTION pizza_invalidate_quote_on_order_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.cart IS DISTINCT FROM OLD.cart
     OR NEW.order_type IS DISTINCT FROM OLD.order_type
     OR NEW.delivery_name IS DISTINCT FROM OLD.delivery_name
     OR NEW.delivery_address IS DISTINCT FROM OLD.delivery_address THEN
    NEW.cart_revision := OLD.cart_revision + 1;
    NEW.quote_cart_revision := NULL;
    NEW.quote_subtotal := NULL;
    NEW.quote_delivery_charge := NULL;
    NEW.quote_total := NULL;
    NEW.quote_created_at := NULL;
    NEW.confirmation_status := 'not_quoted';
    NEW.awaiting_confirmation := FALSE;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pizza_invalidate_quote ON conversation_sessions;
CREATE TRIGGER trg_pizza_invalidate_quote
BEFORE UPDATE OF cart, order_type, delivery_name, delivery_address
ON conversation_sessions
FOR EACH ROW
EXECUTE FUNCTION pizza_invalidate_quote_on_order_change();

-- Reprice and validate the current cart exclusively from live menu/deal data.
CREATE OR REPLACE FUNCTION pizza_checkout_snapshot(p_customer_id BIGINT)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
WITH session_data AS (
  SELECT cs.*
  FROM conversation_sessions cs
  WHERE cs.customer_id = p_customer_id
), cart_lines AS (
  SELECT item, ordinal
  FROM session_data sd
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(sd.cart->'items') = 'array' THEN sd.cart->'items' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS x(item, ordinal)
), valid_menu AS (
  SELECT cl.ordinal, mi.id AS menu_item_id, mi.name, mi.category,
         mv.id AS variant_id, mv.variant_label, mv.price,
         (cl.item->>'quantity')::int AS quantity
  FROM cart_lines cl
  JOIN restaurant_menu_items mi
    ON mi.active = TRUE
   AND mi.id = CASE WHEN cl.item->>'menu_item_id' ~ '^[0-9]{1,18}$'
                    THEN (cl.item->>'menu_item_id')::bigint END
  JOIN restaurant_menu_variants mv
    ON mv.active = TRUE
   AND mv.menu_item_id = mi.id
   AND mv.id = CASE WHEN cl.item->>'variant_id' ~ '^[0-9]{1,18}$'
                    THEN (cl.item->>'variant_id')::bigint END
  WHERE cl.item->>'record_type' = 'menu_item'
    AND COALESCE(cl.item->>'quantity', '') ~ '^[0-9]{1,3}$'
    AND (cl.item->>'quantity')::int BETWEEN 1 AND 100
), valid_deal AS (
  SELECT cl.ordinal, d.id AS deal_id, d.name, d.category, d.price,
         (cl.item->>'quantity')::int AS quantity,
         COALESCE(cl.item->'selected_components', '[]'::jsonb) AS selected_components
  FROM cart_lines cl
  JOIN restaurant_deals d
    ON d.active = TRUE
   AND d.id = CASE WHEN cl.item->>'deal_id' ~ '^[0-9]{1,18}$'
                   THEN (cl.item->>'deal_id')::bigint END
  WHERE cl.item->>'record_type' = 'deal'
    AND COALESCE(cl.item->>'quantity', '') ~ '^[0-9]{1,3}$'
    AND (cl.item->>'quantity')::int BETWEEN 1 AND 100
    AND jsonb_typeof(COALESCE(cl.item->'selected_components', '[]'::jsonb)) = 'array'
    AND NOT EXISTS (
      SELECT 1
      FROM restaurant_deal_components required
      WHERE required.deal_id = d.id
        AND required.selectable = TRUE
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(cl.item->'selected_components', '[]'::jsonb)) choice_json
          JOIN restaurant_menu_items choice
            ON choice.active = TRUE
           AND LOWER(choice.name) = LOWER(choice_json->>'choice')
          WHERE choice_json->>'selection_group' = required.selection_group
            AND CASE
              WHEN required.allowed_item_rule->>'allowed' = 'any_active_pizza' THEN
                choice.item_type LIKE 'pizza%'
                AND EXISTS (
                  SELECT 1 FROM restaurant_menu_variants cv
                  WHERE cv.menu_item_id = choice.id AND cv.active = TRUE
                    AND LOWER(cv.variant_label) = LOWER(required.allowed_item_rule->>'size_label')
                )
              WHEN required.allowed_item_rule->>'allowed' = 'active_wing_items' THEN
                choice.name ILIKE '%wing%'
              WHEN required.allowed_item_rule->>'allowed' = 'active_sauces' THEN
                choice.item_type = 'sauce'
              WHEN jsonb_typeof(required.allowed_item_rule->'allowed_brands') = 'array' THEN
                choice.item_type = 'drink'
                AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements_text(required.allowed_item_rule->'allowed_brands') brand
                  WHERE LOWER(brand) = LOWER(choice.name)
                )
                AND EXISTS (
                  SELECT 1 FROM restaurant_menu_variants cv
                  WHERE cv.menu_item_id = choice.id AND cv.active = TRUE
                    AND LOWER(cv.variant_label) = LOWER(COALESCE(
                      required.allowed_item_rule->>'size', required.allowed_item_rule->>'size_label'
                    ))
                )
              ELSE FALSE
            END
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(cl.item->'selected_components', '[]'::jsonb)) choice_json
      WHERE jsonb_typeof(choice_json) <> 'object'
         OR NOT EXISTS (
           SELECT 1 FROM restaurant_deal_components known
           WHERE known.deal_id = d.id AND known.selectable = TRUE
             AND known.selection_group = choice_json->>'selection_group'
         )
    )
    AND jsonb_array_length(COALESCE(cl.item->'selected_components', '[]'::jsonb)) = (
      SELECT COUNT(*) FROM restaurant_deal_components required
      WHERE required.deal_id = d.id AND required.selectable = TRUE
    )
), priced_lines AS (
  SELECT vm.ordinal,
         jsonb_build_object(
           'record_type', 'menu_item', 'menu_item_id', vm.menu_item_id,
           'variant_id', vm.variant_id, 'deal_id', NULL,
           'item_name', vm.name, 'category', vm.category,
           'size', vm.variant_label, 'quantity', vm.quantity,
           'price', vm.price, 'selected_components', '[]'::jsonb,
           'line_total', vm.price * vm.quantity
         ) AS item,
         vm.price * vm.quantity AS line_total
  FROM valid_menu vm
  UNION ALL
  SELECT vd.ordinal,
         jsonb_build_object(
           'record_type', 'deal', 'menu_item_id', NULL, 'variant_id', NULL,
           'deal_id', vd.deal_id, 'item_name', vd.name, 'category', vd.category,
           'size', NULL, 'quantity', vd.quantity, 'price', vd.price,
           'selected_components', vd.selected_components,
           'line_total', vd.price * vd.quantity
         ),
         vd.price * vd.quantity
  FROM valid_deal vd
), totals AS (
  SELECT sd.*,
         COALESCE((SELECT jsonb_agg(pl.item ORDER BY pl.ordinal) FROM priced_lines pl), '[]'::jsonb) AS priced_items,
         COALESCE((SELECT SUM(pl.line_total) FROM priced_lines pl), 0)::numeric AS subtotal,
         (SELECT COUNT(*) FROM cart_lines)::int AS cart_line_count,
         (SELECT COUNT(*) FROM priced_lines)::int AS valid_line_count
  FROM session_data sd
), settings AS (
  SELECT COALESCE(delivery_charge, 0)::numeric AS delivery_charge
  FROM restaurant_settings WHERE id = 1
)
SELECT jsonb_build_object(
  'customer_id', t.customer_id,
  'cart_revision', t.cart_revision,
  'items', t.priced_items,
  'order_type', t.order_type,
  'delivery_name', t.delivery_name,
  'delivery_address', t.delivery_address,
  'subtotal', t.subtotal,
  'delivery_charge', CASE WHEN t.order_type = 'delivery' THEN s.delivery_charge ELSE 0 END,
  'total', t.subtotal + CASE WHEN t.order_type = 'delivery' THEN s.delivery_charge ELSE 0 END,
  'checkout_error', CASE
    WHEN t.cart_line_count = 0 THEN 'cart_empty'
    WHEN t.cart_line_count <> t.valid_line_count THEN 'invalid_cart'
    WHEN t.order_type IS NULL OR t.order_type NOT IN ('delivery', 'pickup') THEN 'order_type_required'
    WHEN t.order_type = 'delivery' AND NULLIF(BTRIM(t.delivery_name), '') IS NULL THEN 'delivery_name_required'
    WHEN t.order_type = 'delivery' AND NULLIF(BTRIM(t.delivery_address), '') IS NULL THEN 'delivery_address_required'
    ELSE NULL
  END
)
FROM totals t
CROSS JOIN settings s;
$$;

CREATE OR REPLACE FUNCTION pizza_prepare_checkout_quote(p_customer_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_snapshot JSONB;
  v_revision BIGINT;
BEGIN
  PERFORM 1 FROM conversation_sessions WHERE customer_id = p_customer_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('quote_created', FALSE, 'checkout_error', 'session_not_found');
  END IF;

  v_snapshot := pizza_checkout_snapshot(p_customer_id);
  IF v_snapshot IS NULL OR v_snapshot->>'checkout_error' IS NOT NULL THEN
    RETURN COALESCE(v_snapshot, '{}'::jsonb)
      || jsonb_build_object('quote_created', FALSE);
  END IF;

  v_revision := (v_snapshot->>'cart_revision')::bigint;
  UPDATE conversation_sessions
  SET quote_cart_revision = v_revision,
      quote_subtotal = (v_snapshot->>'subtotal')::numeric,
      quote_delivery_charge = (v_snapshot->>'delivery_charge')::numeric,
      quote_total = (v_snapshot->>'total')::numeric,
      quote_created_at = NOW(),
      confirmation_status = 'awaiting_confirmation',
      awaiting_confirmation = TRUE,
      updated_at = NOW()
  WHERE customer_id = p_customer_id;

  RETURN v_snapshot || jsonb_build_object(
    'quote_created', TRUE,
    'quote_cart_revision', v_revision,
    'confirmation_status', 'awaiting_confirmation'
  );
END;
$$;

CREATE OR REPLACE FUNCTION pizza_confirm_checkout_quote(p_customer_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_session conversation_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_session
  FROM conversation_sessions
  WHERE customer_id = p_customer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('confirmed', FALSE, 'checkout_error', 'session_not_found');
  END IF;
  IF v_session.confirmation_status <> 'awaiting_confirmation'
     OR v_session.quote_cart_revision IS DISTINCT FROM v_session.cart_revision THEN
    RETURN jsonb_build_object('confirmed', FALSE, 'checkout_error', 'quote_missing_or_stale');
  END IF;
  IF v_session.quote_created_at IS NULL OR v_session.quote_created_at < NOW() - INTERVAL '30 minutes' THEN
    UPDATE conversation_sessions
    SET confirmation_status = 'not_quoted', awaiting_confirmation = FALSE,
        quote_cart_revision = NULL, quote_created_at = NULL, updated_at = NOW()
    WHERE customer_id = p_customer_id;
    RETURN jsonb_build_object('confirmed', FALSE, 'checkout_error', 'quote_expired');
  END IF;

  UPDATE conversation_sessions
  SET confirmation_status = 'confirmed', awaiting_confirmation = FALSE, updated_at = NOW()
  WHERE customer_id = p_customer_id;

  RETURN jsonb_build_object(
    'confirmed', TRUE,
    'cart_revision', v_session.cart_revision,
    'quote_total', v_session.quote_total,
    'should_place', TRUE
  );
END;
$$;

CREATE OR REPLACE FUNCTION pizza_place_confirmed_order(p_customer_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_session conversation_sessions%ROWTYPE;
  v_snapshot JSONB;
  v_order orders%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('order_create:' || p_customer_id::text));
  SELECT * INTO v_session
  FROM conversation_sessions
  WHERE customer_id = p_customer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('order_created', FALSE, 'checkout_error', 'session_not_found');
  END IF;
  IF v_session.confirmation_status <> 'confirmed'
     OR v_session.quote_cart_revision IS DISTINCT FROM v_session.cart_revision THEN
    RETURN jsonb_build_object('order_created', FALSE, 'checkout_error', 'confirmation_required');
  END IF;
  IF v_session.quote_created_at IS NULL OR v_session.quote_created_at < NOW() - INTERVAL '30 minutes' THEN
    RETURN jsonb_build_object('order_created', FALSE, 'checkout_error', 'quote_expired');
  END IF;

  v_snapshot := pizza_checkout_snapshot(p_customer_id);
  IF v_snapshot IS NULL OR v_snapshot->>'checkout_error' IS NOT NULL THEN
    RETURN COALESCE(v_snapshot, '{}'::jsonb)
      || jsonb_build_object('order_created', FALSE);
  END IF;
  IF (v_snapshot->>'subtotal')::numeric IS DISTINCT FROM v_session.quote_subtotal
     OR (v_snapshot->>'delivery_charge')::numeric IS DISTINCT FROM v_session.quote_delivery_charge
     OR (v_snapshot->>'total')::numeric IS DISTINCT FROM v_session.quote_total THEN
    UPDATE conversation_sessions
    SET confirmation_status = 'not_quoted', awaiting_confirmation = FALSE,
        quote_cart_revision = NULL, quote_created_at = NULL, updated_at = NOW()
    WHERE customer_id = p_customer_id;
    RETURN v_snapshot || jsonb_build_object(
      'order_created', FALSE,
      'checkout_error', 'quote_price_changed'
    );
  END IF;

  INSERT INTO orders (
    customer_id, items, order_type, delivery_address, delivery_name,
    subtotal, delivery_charge, total
  ) VALUES (
    p_customer_id,
    v_snapshot->'items',
    v_snapshot->>'order_type',
    NULLIF(v_snapshot->>'delivery_address', ''),
    NULLIF(v_snapshot->>'delivery_name', ''),
    (v_snapshot->>'subtotal')::numeric,
    (v_snapshot->>'delivery_charge')::numeric,
    (v_snapshot->>'total')::numeric
  ) RETURNING * INTO v_order;

  UPDATE conversation_sessions
  SET cart = '{"items":[]}'::jsonb,
      draft_deal = '{}'::jsonb,
      order_type = NULL,
      delivery_address = NULL,
      delivery_name = NULL,
      order_status = 'placed',
      active_order_id = v_order.id,
      cart_updated_at = NOW(),
      updated_at = NOW()
  WHERE customer_id = p_customer_id;

  RETURN to_jsonb(v_order) || jsonb_build_object(
    'order_created', TRUE,
    'checkout_error', NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION pizza_apply_draft_deal_action(
  p_customer_id BIGINT,
  p_action JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_kind TEXT := COALESCE(p_action->>'kind', 'none');
  v_session conversation_sessions%ROWTYPE;
  v_deal restaurant_deals%ROWTYPE;
  v_choices JSONB := COALESCE(p_action->'selected_choice_ids', '{}'::jsonb);
  v_required JSONB := '[]'::jsonb;
  v_selections JSONB := '{}'::jsonb;
  v_selected_components JSONB := '[]'::jsonb;
  v_missing JSONB := '[]'::jsonb;
  v_draft JSONB := '{}'::jsonb;
  v_type_summary JSONB := '{}'::jsonb;
  v_invalid BOOLEAN := FALSE;
  v_items JSONB := '[]'::jsonb;
  v_new_items JSONB := '[]'::jsonb;
  v_line JSONB;
  v_matching_lines INTEGER := 0;
  v_quote JSONB;
BEGIN
  SELECT * INTO v_session
  FROM conversation_sessions
  WHERE customer_id = p_customer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN p_action || jsonb_build_object('handled', TRUE, 'event', 'session_not_found');
  END IF;

  IF v_kind = 'prepare_quote' THEN
    v_quote := pizza_prepare_checkout_quote(p_customer_id);
    RETURN p_action || v_quote || jsonb_build_object('handled', TRUE, 'event', 'quote_result');
  ELSIF v_kind = 'confirm_quote' THEN
    v_quote := pizza_confirm_checkout_quote(p_customer_id);
    RETURN p_action || v_quote || jsonb_build_object('handled', TRUE, 'event', 'confirmation_result');
  ELSIF v_kind = 'clear_draft' THEN
    UPDATE conversation_sessions
    SET draft_deal = '{}'::jsonb, updated_at = NOW()
    WHERE customer_id = p_customer_id;
    RETURN p_action || jsonb_build_object(
      'draft_deal', '{}'::jsonb,
      'cart', v_session.cart,
      'event', 'draft_cleared'
    );
  ELSIF v_kind <> 'save_draft' THEN
    RETURN p_action || jsonb_build_object(
      'draft_deal', v_session.draft_deal,
      'cart', v_session.cart,
      'cart_revision', v_session.cart_revision
    );
  END IF;

  IF COALESCE(p_action->>'deal_id', '') !~ '^[0-9]{1,18}$'
     OR jsonb_typeof(v_choices) <> 'object' THEN
    RETURN p_action || jsonb_build_object(
      'handled', TRUE, 'event', 'invalid_deal_action',
      'draft_deal', v_session.draft_deal
    );
  END IF;

  SELECT * INTO v_deal
  FROM restaurant_deals
  WHERE id = (p_action->>'deal_id')::bigint AND active = TRUE;
  IF NOT FOUND THEN
    RETURN p_action || jsonb_build_object(
      'handled', TRUE, 'event', 'deal_unavailable',
      'draft_deal', v_session.draft_deal
    );
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM jsonb_each_text(v_choices) choice
    WHERE choice.value !~ '^[0-9]{1,18}$'
  ) INTO v_invalid;

  IF NOT v_invalid THEN
    SELECT EXISTS (
      SELECT 1
      FROM jsonb_each_text(v_choices) choice
      WHERE NOT EXISTS (
        SELECT 1
        FROM restaurant_deal_components component
        JOIN restaurant_menu_items item
          ON item.id = choice.value::bigint AND item.active = TRUE
        WHERE component.deal_id = v_deal.id
          AND component.selectable = TRUE
          AND component.selection_group = choice.key
          AND CASE
            WHEN component.allowed_item_rule->>'allowed' = 'any_active_pizza' THEN
              item.item_type LIKE 'pizza%'
              AND EXISTS (
                SELECT 1 FROM restaurant_menu_variants variant
                WHERE variant.menu_item_id = item.id AND variant.active = TRUE
                  AND LOWER(variant.variant_label) = LOWER(component.allowed_item_rule->>'size_label')
              )
            WHEN component.allowed_item_rule->>'allowed' = 'active_wing_items' THEN
              item.name ILIKE '%wing%'
            WHEN component.allowed_item_rule->>'allowed' = 'active_sauces' THEN
              item.item_type = 'sauce'
            WHEN jsonb_typeof(component.allowed_item_rule->'allowed_brands') = 'array' THEN
              item.item_type = 'drink'
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(component.allowed_item_rule->'allowed_brands') brand
                WHERE LOWER(brand) = LOWER(item.name)
              )
              AND EXISTS (
                SELECT 1 FROM restaurant_menu_variants variant
                WHERE variant.menu_item_id = item.id AND variant.active = TRUE
                  AND LOWER(variant.variant_label) = LOWER(COALESCE(
                    component.allowed_item_rule->>'size', component.allowed_item_rule->>'size_label'
                  ))
              )
            ELSE FALSE
          END
      )
    ) INTO v_invalid;
  END IF;

  IF v_invalid THEN
    RETURN p_action || jsonb_build_object(
      'handled', TRUE, 'event', 'invalid_component_selection',
      'draft_deal', v_session.draft_deal
    );
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'order', component_order,
           'type', component_type,
           'quantity', quantity,
           'unit', unit,
           'size', size_label,
           'label', component_label,
           'selection_group', selection_group,
           'allowed_item_rule', allowed_item_rule
         ) ORDER BY component_order), '[]'::jsonb)
  INTO v_required
  FROM restaurant_deal_components
  WHERE deal_id = v_deal.id AND selectable = TRUE;

  SELECT COALESCE(jsonb_object_agg(
           component.selection_group,
           CASE WHEN item.id IS NULL THEN NULL ELSE jsonb_build_object(
             'item_id', item.id,
             'choice', item.name,
             'type', component.component_type,
             'quantity', component.quantity,
             'unit', component.unit,
             'size', component.size_label,
             'label', component.component_label,
             'selection_group', component.selection_group
           ) END
         ), '{}'::jsonb)
  INTO v_selections
  FROM restaurant_deal_components component
  LEFT JOIN restaurant_menu_items item
    ON item.id = CASE
      WHEN COALESCE(v_choices->>component.selection_group, '') ~ '^[0-9]{1,18}$'
      THEN (v_choices->>component.selection_group)::bigint
    END
  WHERE component.deal_id = v_deal.id AND component.selectable = TRUE;

  SELECT COALESCE(jsonb_agg(component.component_label ORDER BY component.component_order), '[]'::jsonb)
  INTO v_missing
  FROM restaurant_deal_components component
  WHERE component.deal_id = v_deal.id
    AND component.selectable = TRUE
    AND NOT (v_choices ? component.selection_group);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'selection_group', component.selection_group,
           'choice', item.name
         ) ORDER BY jsonb_build_object(
           'selection_group', component.selection_group,
           'choice', item.name
         )::text), '[]'::jsonb)
  INTO v_selected_components
  FROM restaurant_deal_components component
  JOIN restaurant_menu_items item
    ON item.id = (v_choices->>component.selection_group)::bigint
  WHERE component.deal_id = v_deal.id
    AND component.selectable = TRUE
    AND v_choices ? component.selection_group;

  SELECT jsonb_build_object(
    'pizza', (
      SELECT v_selections->component.selection_group
      FROM restaurant_deal_components component
      WHERE component.deal_id = v_deal.id AND component.component_type = 'pizza'
      ORDER BY component.component_order LIMIT 1
    ),
    'wings', (
      SELECT v_selections->component.selection_group
      FROM restaurant_deal_components component
      WHERE component.deal_id = v_deal.id AND component.component_type = 'wings'
      ORDER BY component.component_order LIMIT 1
    ),
    'dip', (
      SELECT v_selections->component.selection_group
      FROM restaurant_deal_components component
      WHERE component.deal_id = v_deal.id AND component.component_type = 'dip'
      ORDER BY component.component_order LIMIT 1
    ),
    'drink', (
      SELECT v_selections->component.selection_group
      FROM restaurant_deal_components component
      WHERE component.deal_id = v_deal.id AND component.component_type = 'drink'
      ORDER BY component.component_order LIMIT 1
    )
  ) INTO v_type_summary;

  v_draft := jsonb_build_object(
    'deal_id', v_deal.id,
    'deal_name', v_deal.name,
    'price', v_deal.price,
    'status', CASE WHEN jsonb_array_length(v_missing) = 0 THEN 'complete' ELSE 'in_progress' END,
    'required_components', v_required,
    'selected_choice_ids', v_choices,
    'selections', v_selections,
    'selected_components', v_selected_components,
    'missing_components', v_missing,
    'updated_at', NOW()
  ) || v_type_summary;

  IF jsonb_array_length(v_missing) > 0 THEN
    UPDATE conversation_sessions
    SET draft_deal = v_draft, updated_at = NOW()
    WHERE customer_id = p_customer_id;
    RETURN p_action || jsonb_build_object(
      'handled', TRUE,
      'event', COALESCE(p_action->>'event', 'draft_updated'),
      'draft_deal', v_draft,
      'cart', v_session.cart
    );
  END IF;

  v_items := CASE WHEN jsonb_typeof(v_session.cart->'items') = 'array'
                  THEN v_session.cart->'items' ELSE '[]'::jsonb END;
  SELECT COUNT(*)::int INTO v_matching_lines
  FROM jsonb_array_elements(v_items) existing
  WHERE existing->>'record_type' = 'deal'
    AND existing->>'deal_id' = v_deal.id::text
    AND COALESCE(existing->'selected_components', '[]'::jsonb) = v_selected_components;

  IF v_matching_lines > 0 THEN
    SELECT COALESCE(jsonb_agg(
      CASE
        WHEN existing->>'record_type' = 'deal'
         AND existing->>'deal_id' = v_deal.id::text
         AND COALESCE(existing->'selected_components', '[]'::jsonb) = v_selected_components
        THEN jsonb_set(
          jsonb_set(existing, '{quantity}', to_jsonb(COALESCE((existing->>'quantity')::int, 0) + 1)),
          '{line_total}', to_jsonb(v_deal.price * (COALESCE((existing->>'quantity')::int, 0) + 1))
        )
        ELSE existing
      END ORDER BY ordinal
    ), '[]'::jsonb)
    INTO v_new_items
    FROM jsonb_array_elements(v_items) WITH ORDINALITY AS lines(existing, ordinal);
  ELSE
    v_line := jsonb_build_object(
      'record_type', 'deal',
      'menu_item_id', NULL,
      'variant_id', NULL,
      'deal_id', v_deal.id,
      'item_name', v_deal.name,
      'category', v_deal.category,
      'size', NULL,
      'quantity', 1,
      'price', v_deal.price,
      'selected_components', v_selected_components,
      'line_total', v_deal.price
    );
    v_new_items := v_items || jsonb_build_array(v_line);
  END IF;

  UPDATE conversation_sessions
  SET cart = jsonb_build_object('items', v_new_items),
      draft_deal = '{}'::jsonb,
      order_status = 'draft',
      active_order_id = NULL,
      cart_updated_at = NOW(),
      updated_at = NOW()
  WHERE customer_id = p_customer_id;

  RETURN p_action || jsonb_build_object(
    'handled', TRUE,
    'event', 'deal_completed',
    'completed_deal', v_draft,
    'draft_deal', '{}'::jsonb,
    'cart', jsonb_build_object('items', v_new_items),
    'deal_price', v_deal.price
  );
END;
$$;

COMMIT;
